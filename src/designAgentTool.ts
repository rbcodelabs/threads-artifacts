import type { AgentToolContribution } from './contracts';
import type { DesignService } from './DesignService';
import { DESIGN_RUNTIMES, isDesignRuntime, type DesignRuntime } from './designArtifact';
import { DESIGN_MODES, DESIGN_MODE_DESCRIPTIONS, PICK_LETTER_ERROR, PICK_WITHOUT_DESIGN_ERROR, SPEC_WITHOUT_DESIGN_ERROR, isDesignMode, pickLetter } from './designModes';

const failure = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });

// Built from the shared per-mode descriptions so the tool schema and the
// slash command's autocomplete can never say different things about a mode.
const MODE_ENUM_DESCRIPTION = `Optional prompt mode for this turn. ${DESIGN_MODES.map(mode => `"${mode}": ${DESIGN_MODE_DESCRIPTIONS[mode]}`).join(' ')} Omit for a full visual design.`;

export const DESIGN_TOOL_DESCRIPTION = [
  'Use mode "report" whenever the user asks for a report, analysis, summary document or charts, instead of any cloud doc connector (Claude Docs, Google Docs). The output is a local HTML file in the vault and nothing is uploaded, so it is also the right place for personal or financial data. For report mode, begin the brief with a short plain title phrase (under 60 characters, no "Title:" prefix, no file paths) because it names the folder and artifact, with details after it.',
  'Create or reopen a design artifact for this thread and open its preview.',
  'Set runtime "static" (default) for a single-screen or simple page built from plain HTML/CSS/JS.',
  'Set runtime "nextjs" when the brief asks for a sophisticated prototype or complete app design: multi-page flows, client-side state, realistic navigation, or several connected screens.',
  'A Next.js artifact uses mock data and client state only, previews on a local dev server, and can be exported to static HTML. Modes variations, pick, spec, storyboard and report are static-only.',
  'An existing artifact keeps its runtime; it cannot be changed.',
].join(' ');

export function createDesignAgentTool(service: DesignService): AgentToolContribution {
  return {
    name: 'EnterDesignMode',
    description: DESIGN_TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        brief: { type: 'string', minLength: 1, description: 'The visual design brief or requested revision.' },
        mode: {
          type: 'string',
          enum: [...DESIGN_MODES],
          description: MODE_ENUM_DESCRIPTION,
        },
        runtime: {
          type: 'string',
          enum: [...DESIGN_RUNTIMES],
          default: 'static',
          description: 'Artifact runtime: "static" HTML/CSS/JS (default) or "nextjs" for a full multi-page app prototype.',
        },
      },
      required: ['brief'],
      additionalProperties: false,
    },
    alwaysLoad: true,
    requiresApproval: true,
    async invoke(threadId, args) {
      const brief = typeof args.brief === 'string' ? args.brief.trim() : '';
      if (!brief) return failure('A non-empty design brief is required.');
      const mode = args.mode;
      if (mode !== undefined && !isDesignMode(mode)) {
        return failure(`Unknown design mode: ${String(mode)}. Use one of: ${DESIGN_MODES.join(', ')}.`);
      }
      let runtime: DesignRuntime | undefined;
      if (args.runtime !== undefined) {
        if (!isDesignRuntime(args.runtime)) return failure(`Unsupported runtime ${JSON.stringify(args.runtime)}. Use "static" or "nextjs".`);
        runtime = args.runtime;
      }
      if (mode === 'pick' && !pickLetter(brief)) return failure(PICK_LETTER_ERROR);
      try {
        if (mode === 'pick' && !(await service.state(threadId))?.hasArtifacts) return failure(PICK_WITHOUT_DESIGN_ERROR);
        if (mode === 'spec' && !(await service.state(threadId))?.hasArtifacts) return failure(SPEC_WITHOUT_DESIGN_ERROR);
        const result = await service.prepare(threadId, brief, { mode, runtime });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }
    },
  };
}
