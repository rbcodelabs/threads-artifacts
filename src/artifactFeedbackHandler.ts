import type { AgentThreadsApiV1 } from './contracts';
import { createDesignTargetCheck } from './designTargetCheck';
import { buildElementPrompt, neutralizeEscalation, PromptTooLargeError } from './elementPrompt';
import { validateFeedbackRequest } from './elementFeedbackValidation';
import { resolveFeedbackTarget } from './feedbackIntake';
import type { ArtifactFeedbackHandler, ArtifactFeedbackRequest, ArtifactFeedbackResult } from './geodeArtifactFeedback';
import { serializeSelectionRecord } from './selectionRecord';
import { pruneSelections, SELECTION_RETENTION, writeSelectionFiles } from './selectionFiles';
import type { SendCoordinator } from './sendCoordinator';
import { findSourceHints } from './sourceHints';

/**
 * Plugin side of Geode's artifact feedback contract v1 (ADR 0006). `submit` re-validates the whole
 * request, maps the artifact to its owning thread, writes the sidecar files, builds the fenced
 * prompt and hands it to the send coordinator. Idempotent per selectionId: Geode retries with the
 * same id after its 15 s timeout, and the first accepted outcome is returned without re-sending.
 */

const LEDGER_SIZE = 64;
const SENT_MESSAGE = 'Sent to the thread.';
const QUEUED_MESSAGE = 'Queued. It will send when the agent finishes.';
const ESCALATION_NOTE = 'The escalation keyword in your comment was kept as plain text and will not switch the model.';
const MESSAGES = {
  cancelled: 'Cancelled before it was sent.',
  files: 'Could not save the selection. Check disk space and folder permissions, then try again.',
  tooLarge: 'This comment is too large to send. Shorten it and try again.',
  notRedacted: 'This design can read vault notes, so element comments must be redacted, and this version of Geode did not do that.',
  unexpected: 'Something went wrong sending the comment. Try again.',
} as const;

export interface ArtifactFeedbackHandlerDeps {
  readonly api: AgentThreadsApiV1;
  readonly coordinator: SendCoordinator;
  /** Vault base path; Design storage must live inside it and is pinned by the thread's artifact ref. */
  readonly vaultRoot: () => string | undefined;
  /** Per-session secret for the prompt boundary token. Never page-visible. */
  readonly boundarySecret: string;
  /** The host's escalation keyword(s); `known: false` when the setting could not be read. */
  readonly escalation?: () => { readonly keywords: readonly string[]; readonly known: boolean };
  /**
   * Selection ids that retention must never delete (every pinned comment's selection). `null`, or a throw, means
   * "could not tell": pruning is skipped. Omitted means no comments exist (nothing extra to protect).
   */
  readonly protectedSelectionIds?: (root: string, artifactId: string) => Promise<readonly string[] | null>;
  readonly now?: () => number;
  readonly warn?: (message: string, error?: unknown) => void;
}

const rejected = (reason: Extract<ArtifactFeedbackResult, { status: 'rejected' }>['reason'], message: string): ArtifactFeedbackResult => ({ status: 'rejected', reason, message });

export function createArtifactFeedbackHandler(deps: ArtifactFeedbackHandlerDeps): ArtifactFeedbackHandler {
  const ledger = new Map<string, Promise<ArtifactFeedbackResult>>();
  const isDesignTarget = createDesignTargetCheck({ vaultRoot: deps.vaultRoot, now: deps.now });

  function remember(selectionId: string, result: Promise<ArtifactFeedbackResult>): void {
    ledger.delete(selectionId);
    ledger.set(selectionId, result);
    while (ledger.size > LEDGER_SIZE) ledger.delete(ledger.keys().next().value as string);
    // Only accepted outcomes are sticky. A rejection (or an abort) must let Retry run for real.
    void result.then(outcome => { if (outcome.status !== 'accepted' && ledger.get(selectionId) === result) ledger.delete(selectionId); }, () => ledger.delete(selectionId));
  }

  async function protectedIdsFor(root: string, artifactId: string): Promise<readonly string[] | null> {
    if (!deps.protectedSelectionIds) return [];
    try {
      return await deps.protectedSelectionIds(root, artifactId);
    } catch (error) {
      deps.warn?.('threads-design: could not list pinned selections; skipping retention', error);
      return null;
    }
  }

  async function process(request: ArtifactFeedbackRequest, signal: AbortSignal): Promise<ArtifactFeedbackResult> {
    const { selection } = request;
    const intake = await resolveFeedbackTarget(request.artifact, { api: deps.api, vaultRoot: deps.vaultRoot });
    if (!intake.ok) return rejected(intake.reason, intake.message);
    if (intake.vaultRead && !selection.redacted) return rejected('invalid', MESSAGES.notRedacted);
    if (signal.aborted) return rejected('unavailable', MESSAGES.cancelled);

    const hints = await findSourceHints(intake.root, selection).catch(() => []);
    const png = request.screenshot && !intake.vaultRead ? request.screenshot.bytes : null;
    let files;
    try {
      files = await writeSelectionFiles({
        root: intake.root,
        selectionId: selection.selectionId,
        json: serializeSelectionRecord({ request, title: intake.title, vaultRead: intake.vaultRead, png, contractVersion: 1 }),
        png,
        vaultRead: intake.vaultRead,
      });
    } catch (error) {
      deps.warn?.('threads-design: could not write selection files', error);
      return rejected('failed', MESSAGES.files);
    }
    // Retention is best-effort and never throws; the file just written is protected.
    // Selections that a pinned comment references are exempt. If they cannot be determined, nothing is pruned.
    const protectIds = await protectedIdsFor(intake.root, intake.manifest.id);
    await pruneSelections({ root: intake.root, keep: SELECTION_RETENTION, protectId: selection.selectionId, protectIds: protectIds ?? [] });
    if (signal.aborted) return rejected('unavailable', MESSAGES.cancelled);

    const escalation = deps.escalation?.() ?? { keywords: [], known: true };
    let prompt: string;
    try {
      prompt = buildElementPrompt({
        request,
        artifactTitle: intake.title,
        jsonPath: files.jsonPath,
        pngPath: files.pngPath,
        hints,
        boundarySecret: deps.boundarySecret,
        escalationKeywords: escalation.keywords,
        conservativeKeywords: !escalation.known,
      });
    } catch (error) {
      if (error instanceof PromptTooLargeError) return rejected('invalid', MESSAGES.tooLarge);
      deps.warn?.('threads-design: could not build the element prompt', error);
      return rejected('failed', MESSAGES.unexpected);
    }

    // Past this point the send may be issued: finish the bookkeeping even if the signal aborts.
    const outcome = await deps.coordinator.submit({ selectionId: selection.selectionId, artifactKey: intake.root, threadId: intake.threadId, prompt });
    // A typed escalation keyword is kept as plain text (rewriting would flatten the fence): say so.
    const note = neutralizeEscalation(request.comment, escalation.keywords) !== request.comment ? ` ${ESCALATION_NOTE}` : '';
    if (outcome.status === 'sent') return { status: 'accepted', message: `${SENT_MESSAGE}${note}` };
    if (outcome.status === 'queued') return { status: 'accepted', message: `${QUEUED_MESSAGE}${note}` };
    return rejected(outcome.reason, outcome.message);
  }

  return {
    contractVersion: 1,
    canHandle: target => isDesignTarget(target),
    submit(raw, context) {
      const validated = validateFeedbackRequest(raw);
      if (!validated.ok) return Promise.resolve(rejected('invalid', `This comment could not be sent: ${validated.message}`));
      const request = validated.value;
      const id = request.selection.selectionId;
      const existing = ledger.get(id);
      if (existing) return existing;
      const result = process(request, context.signal).catch((error: unknown) => {
        deps.warn?.('threads-design: unexpected feedback failure', error);
        return rejected('failed', MESSAGES.unexpected);
      });
      remember(id, result);
      return result;
    },
  };
}
