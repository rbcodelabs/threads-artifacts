import type { SlashCommandArgCompletion, SlashCommandContribution, SlashCommandResult } from './contracts';
import {
  DESIGN_MODES,
  DESIGN_MODE_DESCRIPTIONS,
  DESIGN_MODE_LIST,
  PICK_DISPATCH_ERROR,
  PICK_EMPTY_ERROR,
  PICK_LETTER_ERROR,
  PICK_WITHOUT_DESIGN_ERROR,
  SPEC_DISPATCH_ERROR,
  SPEC_WITHOUT_DESIGN_ERROR,
  parseDesignModeArgs,
  pickLetter,
  type DesignMode,
} from './designModes';
import { isDesignRuntime, type DesignRuntime } from './designArtifact';

export interface DesignSlashCommandDependencies {
  getState(threadId: string): Promise<{ hasArtifacts: boolean; existingTitle?: string } | null> | { hasArtifacts: boolean; existingTitle?: string } | null;
  isDesktopFilesystem(): boolean;
  prepare(threadId: string, brief: string, mode?: DesignMode, runtime?: DesignRuntime): Promise<{ artifact: { title: string }; instructions: string }>;
  send(threadId: string, prompt: string): Promise<void>;
  dispatch(brief: string, harness?: 'claude' | 'codex', mode?: DesignMode, runtime?: DesignRuntime): Promise<string>;
}

export type ParsedDesignArgs = { runtime?: DesignRuntime; mode?: DesignMode; brief: string } | { error: string };

/**
 * Leading flags choose the runtime: `--nextjs`, `--static`, `--runtime nextjs`, `--runtime=static`.
 * Flags are only recognised before the mode/brief, so briefs may freely mention them later.
 * The remainder is parsed for a `<mode>:` prefix, so `--nextjs wireframe: a dashboard` composes.
 */
export function parseDesignArgs(args: string): ParsedDesignArgs {
  let rest = args.trim();
  let runtime: DesignRuntime | undefined;
  for (;;) {
    const flag = /^--(nextjs|static)(?=\s|$)\s*/.exec(rest);
    if (flag) { runtime = flag[1] as DesignRuntime; rest = rest.slice(flag[0].length); continue; }
    const explicit = /^--runtime(?:=|\s+)(\S+)\s*/.exec(rest);
    if (explicit) {
      if (!isDesignRuntime(explicit[1])) return { error: `Unknown runtime "${explicit[1]}". Use --nextjs or --static.` };
      runtime = explicit[1];
      rest = rest.slice(explicit[0].length);
      continue;
    }
    const { mode, brief } = parseDesignModeArgs(rest);
    return { runtime, mode, brief };
  }
}

const failure = (message: string): SlashCommandResult => ({ status: 'error', message });
const cancelled = (): SlashCommandResult => failure('Design command was cancelled.');
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
const MODE_EXAMPLE = '/design wireframe: a billing settings page';
// Only forward a mode when one was requested so default calls keep their exact shape.
// Trailing args are only forwarded when set, so default calls keep their exact shape.
const modeArgs = (mode: DesignMode | undefined, runtime?: DesignRuntime): [mode?: DesignMode, runtime?: DesignRuntime] => {
  if (runtime) return [mode, runtime];
  return mode ? [mode] : [];
};
const MODE_USAGE = `/design [--nextjs] <brief> or /design [--nextjs] <mode>: <brief> (${DESIGN_MODE_LIST})`;
const REPORT_HINT = 'For a report, analysis or charts use /design report: <brief> (local HTML in the vault, nothing uploaded).';
// pick and spec always error on dispatch — there's nothing to pick/annotate in a brand-new thread —
// so they're excluded from what dispatch offers as autocomplete.
const DISPATCH_MODES: readonly DesignMode[] = DESIGN_MODES.filter(mode => mode !== 'pick' && mode !== 'spec');
const modeCompletions = (modes: readonly DesignMode[]): readonly SlashCommandArgCompletion[] =>
  modes.map(mode => ({ name: `${mode}:`, description: DESIGN_MODE_DESCRIPTIONS[mode] }));

/** Design behavior with host adapters; command views know only the contribution contract. */
export function createDesignSlashCommand(deps: DesignSlashCommandDependencies): SlashCommandContribution {
  return {
    name: 'design',
    thread: {
      description: `Create or revise a live UI artifact (static HTML by default, --nextjs for a full app prototype). ${REPORT_HINT} ${MODE_USAGE}`,
      argCompletions: modeCompletions(DESIGN_MODES),
      invoke: async (context, host) => {
        if (host.signal.aborted) return cancelled();
        const threadId = context.threadId;
        const state = threadId ? await deps.getState(threadId) : null;
        if (!threadId || !state) return { status: 'ok' };
        const parsed = parseDesignArgs(context.args);
        if ('error' in parsed) return failure(parsed.error);
        const { mode, brief, runtime } = parsed;
        if (mode === 'pick') {
          // Unlike other modes, pick needs a letter and existing variations; fail before preparing.
          if (!brief) return failure(PICK_EMPTY_ERROR);
          if (!state.hasArtifacts) return failure(PICK_WITHOUT_DESIGN_ERROR);
          if (!pickLetter(brief)) return failure(PICK_LETTER_ERROR);
        }
        if (mode === 'spec' && !state.hasArtifacts) {
          // spec is an overlay on an existing design; there is nothing to annotate yet.
          return failure(SPEC_WITHOUT_DESIGN_ERROR);
        }
        if (!brief && !state.hasArtifacts) {
          if (mode) return failure(`Include a brief after the mode — e.g. ${MODE_EXAMPLE}`);
          return failure('Include a brief — e.g. /design a responsive pricing page for a developer tool');
        }
        if (!deps.isDesktopFilesystem()) {
          return failure('Design artifacts require a desktop vault with local filesystem access.');
        }
        let prepared: Awaited<ReturnType<DesignSlashCommandDependencies['prepare']>>;
        try {
          prepared = await deps.prepare(threadId, brief || state.existingTitle || 'Design artifact', ...modeArgs(mode, runtime));
        } catch (error) {
          return failure(`Could not prepare the design artifact: ${errorMessage(error)}`);
        }
        if (host.signal.aborted) return cancelled();
        // A bare /design only reopens; a bare mode runs that mode against the existing design.
        if (!brief && !mode) {
          host.report(`Opened design artifact: ${prepared.artifact.title}`);
          return { status: 'ok' };
        }
        host.report(mode
          ? (state.existingTitle !== undefined ? `Revising design artifact in ${mode} mode…` : `Design artifact created. Starting ${mode} design turn…`)
          : (state.existingTitle !== undefined ? 'Revising design artifact…' : 'Design artifact created. Starting design turn…'));
        // Sending starts a long-lived turn. Preparation is the command's
        // transaction boundary; a later session failure keeps the artifact.
        void Promise.resolve().then(() => {
          if (!host.signal.aborted) return deps.send(threadId, prepared.instructions);
        }).catch(error => {
          if (!host.signal.aborted) host.report(`Failed to start design turn: ${errorMessage(error)}`, true);
        });
        return { status: 'ok' };
      },
    },
    dispatch: {
      description: `Dispatch a thread with a live UI artifact (static HTML by default, --nextjs for a full app prototype). ${REPORT_HINT} ${MODE_USAGE}`,
      argCompletions: modeCompletions(DISPATCH_MODES),
      invoke: async (context, host) => {
        if (host.signal.aborted) return cancelled();
        const parsed = parseDesignArgs(context.args);
        if ('error' in parsed) return failure(parsed.error);
        const { mode, brief, runtime } = parsed;
        if (mode === 'pick') return failure(brief ? PICK_DISPATCH_ERROR : PICK_EMPTY_ERROR);
        if (mode === 'spec') return failure(SPEC_DISPATCH_ERROR);
        if (mode && !brief) return failure(`Include a brief after the mode — e.g. "${MODE_EXAMPLE}"`);
        if (!brief) return failure('Include a brief — e.g. "/design a responsive pricing page for a developer tool"');
        if (context.hasImages || context.hasAttachment) {
          return failure('Design dispatch does not support attachments yet. Remove them and try again.');
        }
        try {
          await deps.dispatch(brief, context.agentHarness, ...modeArgs(mode, runtime));
          return host.signal.aborted ? cancelled() : { status: 'ok' };
        } catch (error) {
          return failure(`Could not create design artifact: ${errorMessage(error)}`);
        }
      },
    },
  };
}
