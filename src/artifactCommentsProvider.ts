import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { AgentThreadsApiV1 } from './contracts';
import { isCommentId } from './commentModel';
import type { CommentRootHandle, CommentStore } from './commentStore';
import { buildBatchPrompt, type BatchPromptItem } from './elementPrompt';
import { validateFeedbackRequest, validateStoredSelection } from './elementFeedbackValidation';
import { resolveFeedbackTarget, type IntakeResult } from './feedbackIntake';
import type {
  AdoptCommentsInput,
  ArtifactComment,
  ArtifactCommentDetail,
  ArtifactCommentsChange,
  ArtifactCommentsProvider,
  ArtifactCommentsRejectReason,
  ArtifactCommentsResult,
  ArtifactCommentsSnapshot,
  BatchItemResult,
  BatchSendReport,
  BatchSkipReason,
} from './geodeArtifactFeedbackV2';
import { ARTIFACT_COMMENT_ID_PATTERN, ARTIFACT_COMMENTS_CAPS, ARTIFACT_COMMENTS_REQUEST_ID_PATTERN } from './geodeArtifactFeedbackV2';
import type { ArtifactFeedbackRequest, ArtifactFeedbackTarget } from './geodeArtifactFeedback';
import { pruneSelections, readSelectionJson, removeSelectionFiles, SELECTION_RETENTION, SIDECAR_DIR, writeSelectionFiles } from './selectionFiles';
import { serializeSelectionRecord } from './selectionRecord';
import { BUSY_MESSAGE, type DeferredSendResult, type SendCoordinator } from './sendCoordinator';
import { findSourceHints, loadSourceFiles } from './sourceHints';

/**
 * The `comments` provider of the v2 handler (design 1.2 to 1.5, threats T5, T6, T11, T12): a thin, defensive layer
 * over the P1 store. Every call re-resolves the target through the same intake as Send, so a call can only ever
 * reach a real Design artifact inside the vault. Values go back to Geode by value (structured clones).
 *
 * Inert until `activate()`: the registration code calls it only after Geode accepted the v2 handler, so a v2
 * handler that was refused (or never registered) can never create the install key or touch comments.json.
 */

const SKEW_MS = 24 * 60 * 60 * 1000;
const MAX_BATCH = ARTIFACT_COMMENTS_CAPS.maxBatch;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;
const MESSAGES = {
  inactive: 'Comments are not available right now.',
  aborted: 'Cancelled before it was saved.',
  invalidTarget: 'This design could not be found.',
  invalidRequest: 'This pin could not be saved',
  notRedacted: 'This design can read vault notes, so pins must be redacted, and this version of Geode did not do that.',
  staleClock: 'This pin was captured too long ago or in the future. Pick the element again.',
  files: 'Could not save the selection. Check disk space and folder permissions, then try again.',
  unexpected: 'Something went wrong with the comments. Try again.',
  sendUnavailable: 'Sending pinned comments is not available right now.',
  requestReused: 'That send request was already used for different comments. Try again.',
  sendingNow: 'This comment is being sent right now, so it cannot be taken back.',
  cancelled: 'This send was cancelled. Choose the comments and send again.',
  settling: 'The previous attempt is still being recorded. Try again in a moment.',
  maybeSentRetry: 'Design restarted while this was sending, so it may already be in the thread. Send it again only if you want a second message.',
  notRecorded: 'The message went out, but its status could not be saved, so these comments are marked as maybe sent.',
  changedWhileSending: 'These comments changed while sending, so nothing was sent. Try again.',
  promptUnsafe: 'These comments could not be made safe to send. Shorten them and try again.',
  delivered: 'Sent to the thread.',
  restarted: 'Design restarted while this was sending. It may already be in the thread.',
  restartedNotice: 'Design restarted while these were sending. They may already be in the thread.',
  tooManySubscribers: 'Too many listeners are watching these comments.',
} as const;

const LEDGER_SIZE = 64;
const LEDGER_TTL_MS = 10 * 60 * 1000;

export interface CommentsProviderDeps {
  readonly api: Pick<AgentThreadsApiV1, 'threads' | 'artifacts'>;
  readonly vaultRoot: () => string | undefined;
  readonly store: CommentStore;
  /** Delivers batches through the one pending slot per artifact. Without it `sendBatch` answers `unavailable`. */
  readonly coordinator?: SendCoordinator;
  /** Per-session secret for the batch boundary token. Never page-visible. */
  readonly boundarySecret?: string;
  /** The host's escalation keyword(s); `known: false` when the setting could not be read. */
  readonly escalation?: () => { readonly keywords: readonly string[]; readonly known: boolean };
  /** Override of the prompt size cap (tests). */
  readonly maxPromptLength?: number;
  readonly now?: () => number;
  /** Newest-N retention for selection files that no comment references. */
  readonly retention?: number;
  readonly warn?: (message: string, error?: unknown) => void;
}

export interface CommentsProviderController {
  readonly provider: ArtifactCommentsProvider;
  /** Allows provider calls. Idempotent. Call only after Geode accepted the v2 handler. */
  activate(): void;
  /** Selection ids retention must keep for this artifact; null when they cannot be listed (skip pruning). */
  protectedSelectionIds(root: string, artifactId: string): Promise<readonly string[] | null>;
  /**
   * Feed this the coordinator's `onDeferredResult`: a queued batch that later sent, failed or was cancelled. Results for
   * requests this provider does not know (a single Send, an already settled batch) are ignored.
   */
  handleDeferredResult(result: DeferredSendResult): Promise<void>;
  /** Stops answering, drops every subscription and closes the store handles. Idempotent. */
  dispose(): void;
}

const fail = (reason: ArtifactCommentsRejectReason, message: string): ArtifactCommentsResult<never> => ({ status: 'rejected', reason, message: message.slice(0, ARTIFACT_COMMENTS_CAPS.maxMessageUnits) });
const done = <T,>(value: T): ArtifactCommentsResult<T> => ({ status: 'ok', value });
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const clone = <T,>(result: ArtifactCommentsResult<T>): ArtifactCommentsResult<T> => (result.status === 'ok' ? { status: 'ok', value: structuredClone(result.value) } : { status: 'rejected', reason: result.reason, message: result.message });
const clean = (text: string): string => text.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();

/** Short display string for the rail: the tag plus the accessible name or text. Nothing at all for redacted selections. */
function labelFor(selection: ArtifactFeedbackRequest['selection']): string {
  const name = selection.redacted ? '' : clean(selection.a11y.name ?? selection.textAnchor.text ?? '');
  return clipCodePoints(name ? `${selection.tag} "${name}"` : selection.tag, ARTIFACT_COMMENTS_CAPS.maxLabelUnits);
}

/** Cuts to at most `max` UTF-16 units without splitting a surrogate pair, adding an ellipsis when something was cut. */
function clipCodePoints(text: string, max: number): string {
  if (text.length <= max) return text;
  let out = '';
  for (const point of text) {
    if (out.length + point.length > max - 1) break;
    out += point;
  }
  return `${out}…`;
}

// ---------------------------------------------------------------------------------------------
// Batch send (design 1.5, 4.1, 4.2)
// ---------------------------------------------------------------------------------------------

type EntryState = 'idle' | 'sending' | 'queued' | 'done' | 'failed' | 'cancelled';

/** The prompt pinned for one request: a retry reuses it byte for byte, so the host idempotency key cannot change. */
interface BatchPlan {
  /** Ids and text hashes (ordinal order) of the comments the prompt was built from: any edit makes the plan stale. */
  readonly sendableKey: string;
  readonly prompt: string;
  readonly includedIds: readonly string[];
  readonly deferredIds: readonly string[];
  readonly tooLargeIds: readonly string[];
}

interface BatchEntry {
  readonly key: string;
  readonly root: string;
  readonly artifactId: string;
  readonly requestId: string;
  /** Canonical form of what was asked for: a requestId reused for something else is a conflict. */
  readonly requested: string;
  readonly at: number;
  state: EntryState;
  promise: Promise<ArtifactCommentsResult<BatchSendReport>> | null;
  /** The accepted outcome, returned verbatim on a retry. */
  report: BatchSendReport | null;
  plan: BatchPlan | null;
  /** Comments inside the message while it is being sent or is queued. */
  memberIds: readonly string[];
  settling: Promise<void> | null;
  /** True once the writes that follow a queued outcome have finished. A retry before then is asked to wait. */
  settled: boolean;
}

const isLive = (entry: BatchEntry): boolean => entry.state === 'sending' || entry.state === 'queued';

interface ParsedSend {
  readonly ok: true;
  readonly requestId: string;
  readonly ids: readonly string[];
  readonly resend: boolean;
  readonly anchorStates: Readonly<Record<string, string>>;
}

function parseSendInput(input: unknown): ParsedSend | { readonly ok: false; readonly result: ArtifactCommentsResult<never> } {
  const invalid = (message: string) => ({ ok: false as const, result: fail('invalid', message) });
  if (!isObject(input)) return invalid('That send request is not valid.');
  const { requestId, ids, resend, anchorStates } = input;
  if (typeof requestId !== 'string' || !ARTIFACT_COMMENTS_REQUEST_ID_PATTERN.test(requestId)) return invalid('That send request is not valid.');
  // The length comes first: nothing below walks a list the caller made arbitrarily long.
  if (Array.isArray(ids) && ids.length > MAX_BATCH) return { ok: false as const, result: fail('limit', `Send at most ${MAX_BATCH} comments at a time.`) };
  if (!Array.isArray(ids) || ids.length < 1 || !ids.every((id) => isCommentId(id)) || new Set(ids).size !== ids.length) return invalid('Choose between 1 and 20 different comments to send.');
  if (typeof resend !== 'boolean') return invalid('That send request is not valid.');
  // Only the requested ids are looked up, so the size of the caller's object does not matter.
  const states: Record<string, string> = {};
  if (isObject(anchorStates)) {
    for (const id of ids as string[]) {
      if (!Object.prototype.hasOwnProperty.call(anchorStates, id)) continue;
      const state = anchorStates[id];
      if (typeof state === 'string' && state.length <= 32) states[id] = state;
    }
  }
  return { ok: true, requestId, ids: ids as string[], resend, anchorStates: states };
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

type ItemResult = { readonly id: string; readonly result: BatchItemResult; readonly reason?: BatchSkipReason };

/** Outcome and message follow from the per-item results alone, so a report can be re-derived when a queued batch settles. */
function buildReport(requestId: string, items: readonly ItemResult[]): BatchSendReport {
  const sent = items.filter((item) => item.result === 'sent').length;
  const queued = items.filter((item) => item.result === 'queued').length;
  const deferred = items.filter((item) => item.result === 'deferred').length;
  const skipped = items.filter((item) => item.result === 'skipped');
  const included = sent + queued;
  const others = deferred + skipped.length;
  const outcome: BatchSendReport['outcome'] = included === 0 ? 'none' : others > 0 ? 'partial' : sent > 0 ? 'sent' : 'queued';
  let message: string;
  if (included === 0) {
    const reasons = new Set(skipped.map((item) => item.reason));
    const why = reasons.has('too-large') ? 'This comment is too large to send. Shorten it and try again.'
      : reasons.has('conflict') ? MESSAGES.changedWhileSending
      : reasons.has('foreign') ? 'Adopt comments from another source before sending them.'
      : 'These comments are not ready to send.';
    message = `Nothing was sent. ${why}`;
  } else {
    const head = sent > 0 ? `Sent ${plural(included, 'comment')} to the thread.` : `Queued ${plural(included, 'comment')}. ${included === 1 ? 'It' : 'They'} will send when the agent finishes.`;
    const tail = [
      deferred > 0 ? `${plural(deferred, 'comment')} ${deferred === 1 ? 'was' : 'were'} left for the next send.` : '',
      skipped.length > 0 ? `${plural(skipped.length, 'comment')} could not be sent.` : '',
    ].filter(Boolean);
    message = [head, ...tail].join(' ');
  }
  return { requestId, outcome, items: items.map((item) => (item.reason === undefined ? { id: item.id, result: item.result } : { id: item.id, result: item.result, reason: item.reason })), message: message.slice(0, ARTIFACT_COMMENTS_CAPS.maxMessageUnits) };
}

/** Comments that were sending when Design restarted say so in the snapshot notice, for as long as any is flagged. */
function withRestartNotice(snapshot: ArtifactCommentsSnapshot): ArtifactCommentsSnapshot {
  if (!snapshot.comments.some((comment) => comment.status === 'open' && comment.send.maybeSent && comment.send.lastOutcome === 'unknown')) return snapshot;
  return { ...snapshot, notice: clipCodePoints(snapshot.notice ? `${MESSAGES.restartedNotice} ${snapshot.notice}` : MESSAGES.restartedNotice, ARTIFACT_COMMENTS_CAPS.maxNoticeUnits) };
}

export function createArtifactCommentsProvider(deps: CommentsProviderDeps): CommentsProviderController {
  const now = deps.now ?? (() => Date.now());
  const retention = deps.retention ?? SELECTION_RETENTION;
  const warn = deps.warn ?? (() => undefined);
  const handles = new Map<string, Promise<CommentRootHandle>>();
  const subscriptions = new Set<{ dispose(): void; attach(): void }>();
  const warnedUnhealthy = new Set<string>();
  const ledger = new Map<string, BatchEntry>();
  let active = false;
  let disposed = false;

  /**
   * A plugin (re)start has no live send slot, so a comment still `pending` on disk was left behind by a crash or a
   * reload: it goes back to `open`, flagged `maybeSent` because the message may already have reached the thread.
   * Runs once per store handle, before the first caller sees the comments.
   */
  async function reconcileRestart(handle: CommentRootHandle, root: string): Promise<void> {
    try {
      if ([...ledger.values()].some((entry) => entry.root === root && isLive(entry))) return;
      const snapshot = await handle.snapshot();
      const stuck = snapshot.comments.filter((comment) => comment.status === 'pending');
      if (stuck.length === 0) return;
      await handle.transition(stuck.map((comment) => ({ id: comment.id, event: 'reload-recovered' as const, message: MESSAGES.restarted })));
    } catch (error) {
      warn('threads-design: could not recover comments that were sending when Design restarted', error);
    }
  }

  function handleFor(root: string, artifactId: string): Promise<CommentRootHandle> {
    let handle = handles.get(root);
    if (!handle) {
      const opening = deps.store.open({ root, artifactId }).then(async (opened) => {
        await reconcileRestart(opened, root);
        return opened;
      });
      handle = opening;
      handles.set(root, opening);
      // A failed open must not be remembered: the next call tries again.
      opening.catch(() => { if (handles.get(root) === opening) handles.delete(root); });
    }
    return handle;
  }

  async function intakeOf(target: unknown): Promise<Extract<IntakeResult, { ok: true }> | ArtifactCommentsResult<never>> {
    if (!isObject(target)) return fail('unavailable', MESSAGES.invalidTarget);
    const intake = await resolveFeedbackTarget(target as unknown as ArtifactFeedbackTarget, { api: deps.api, vaultRoot: deps.vaultRoot });
    return intake.ok ? intake : fail('unavailable', intake.message);
  }

  /** Common shell: active check, intake, store handle, fault isolation, data-only result. */
  async function run<T>(target: unknown, body: (handle: CommentRootHandle, intake: Extract<IntakeResult, { ok: true }>) => Promise<ArtifactCommentsResult<T>>): Promise<ArtifactCommentsResult<T>> {
    if (!active) return fail('unavailable', MESSAGES.inactive);
    try {
      const intake = await intakeOf(target);
      if ('status' in intake) return intake;
      if (!active) return fail('unavailable', MESSAGES.inactive);
      const handle = await handleFor(intake.root, intake.manifest.id);
      return clone(await body(handle, intake));
    } catch (error) {
      warn('threads-design: comments call failed', error);
      return fail('failed', MESSAGES.unexpected);
    }
  }

  async function readSelection(root: string, artifactId: string, selectionId: string, mustBeRedacted: boolean): Promise<ArtifactCommentDetail['selection']> {
    const text = await readSelectionJson(root, selectionId);
    if (text === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }
    if (!isObject(parsed)) return null;
    const selection = validateStoredSelection(parsed.selection, artifactId);
    if (selection === null || selection.selectionId !== selectionId) return null;
    // A redacted pin must never hand back an unredacted snapshot, whatever the file on disk says.
    if (mustBeRedacted && !selection.redacted) return null;
    return selection;
  }

  // ---- batch send ------------------------------------------------------------------------

  /** Forgets finished requests after ten minutes. A request that is sending or queued is never forgotten. */
  function pruneLedger(): void {
    const cutoff = now() - LEDGER_TTL_MS;
    for (const [key, entry] of ledger) if (!isLive(entry) && entry.promise === null && entry.at < cutoff) ledger.delete(key);
  }

  function trimLedger(): void {
    for (const [key, entry] of ledger) {
      if (ledger.size <= LEDGER_SIZE) return;
      if (!isLive(entry) && entry.promise === null) ledger.delete(key);
    }
  }

  function liveBatchFor(root: string, commentId: string): BatchEntry | null {
    for (const entry of ledger.values()) if (entry.root === root && isLive(entry) && entry.memberIds.includes(commentId)) return entry;
    return null;
  }

  type Transition = Parameters<CommentRootHandle['transition']>[0][number];
  type Written = ArtifactCommentsResult<unknown>;
  const transient = (result: Written): boolean => result.status === 'rejected' && (result.reason === 'failed' || result.reason === 'unavailable');

  /** One store call that never throws: a throw is just another failed write. */
  async function tryWrite(call: () => Promise<Written>): Promise<Written> {
    try {
      return await call();
    } catch (error) {
      warn('threads-design: a comment status write threw', error);
      return fail('failed', MESSAGES.unexpected);
    }
  }

  /** Tries a write, then once more when the failure may be transient (a busy or failing disk). */
  async function writeWithRetry(call: () => Promise<Written>): Promise<Written> {
    const first = await tryWrite(call);
    return transient(first) ? tryWrite(call) : first;
  }

  /**
   * Records a send result on every member. The write is atomic in the store, so when it is refused (one member changed
   * behind our back, or the disk failed) it is redone member by member: a changed member is skipped and the others
   * still get their status. A member whose write keeps failing is moved to `fallback` so nothing stays `pending`
   * after the send is over. Returns true when every write that was needed worked the first way.
   */
  async function recordMembers(handle: CommentRootHandle, ids: readonly string[], event: Transition['event'], requestId: string, message: string, fallback: { readonly event: Transition['event']; readonly message: string } | null): Promise<boolean> {
    const item = (id: string, which: Transition['event'], text: string): Transition => ({ id, event: which, ...(which === 'reload-recovered' ? {} : { requestId }), message: text });
    if ((await writeWithRetry(() => handle.transition(ids.map((id) => item(id, event, message))))).status === 'ok') return true;
    for (const id of ids) {
      const written = await writeWithRetry(() => handle.transition([item(id, event, message)]));
      if (written.status === 'ok') continue;
      if (written.status === 'rejected' && (written.reason === 'invalid-transition' || written.reason === 'not-found' || written.reason === 'conflict')) continue; // changed behind the queue: not ours to touch
      if (fallback) await writeWithRetry(() => handle.transition([item(id, fallback.event, fallback.message)]));
    }
    return false;
  }

  /** Puts one cancelled member back to `open`; a member whose write keeps failing is released through `expired` instead. */
  async function releaseMember(handle: CommentRootHandle, id: string, requestId: string): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const found = await tryWrite(() => handle.get(id));
      if (found.status !== 'ok') break;
      const value = found.value as ArtifactComment;
      if (value.status !== 'pending') return;
      if ((await tryWrite(() => handle.update({ id, expectedVersion: value.version, change: { action: 'unqueue' } }))).status === 'ok') return;
    }
    await recordMembers(handle, [id], 'expired', requestId, 'Cancelled before it was sent.', null);
  }

  async function unqueueBatch(handle: CommentRootHandle, entry: BatchEntry, id: string, expectedVersion: unknown): Promise<ArtifactCommentsResult<ArtifactComment>> {
    if (entry.state !== 'queued') return fail('busy', MESSAGES.sendingNow);
    const current = await handle.get(id);
    if (current.status !== 'ok') return current;
    if (current.value.version !== expectedVersion) return fail('conflict', 'That comment changed. Refresh and try again.');
    // The prompt is prebuilt and fixed, so cancelling one queued comment cancels the whole queued send.
    if (!deps.coordinator?.cancel(entry.root, entry.requestId)) return fail('busy', MESSAGES.sendingNow);
    await settleEntry(entry, { status: 'cancelled' });
    return handle.get(id);
  }

  type Settled = DeferredSendResult['outcome'];

  /** Applies how a queued batch ended to its members. The first outcome wins; later ones find no live entry. */
  function settleEntry(entry: BatchEntry, outcome: Settled): Promise<void> {
    if (entry.settling) return entry.settling;
    entry.state = outcome.status === 'sent' ? 'done' : outcome.status === 'cancelled' ? 'cancelled' : 'failed';
    // The old "queued" answer is wrong from this moment on, whatever the writes below take.
    if (outcome.status !== 'sent') entry.report = null;
    if (outcome.status === 'cancelled') entry.plan = null;
    entry.settling = (async () => {
      try {
        const handle = await handleFor(entry.root, entry.artifactId);
        if (outcome.status === 'sent') await recordMembers(handle, entry.memberIds, 'delivered', entry.requestId, MESSAGES.delivered, { event: 'reload-recovered', message: MESSAGES.notRecorded });
        else if (outcome.status === 'rejected') await recordMembers(handle, entry.memberIds, 'send-failed', entry.requestId, outcome.message, { event: 'expired', message: outcome.message });
        else if (outcome.status === 'cancelled') for (const id of entry.memberIds) await releaseMember(handle, id, entry.requestId);
      } catch (error) {
        warn('threads-design: could not record how a queued batch ended', error);
      }
      if (outcome.status === 'sent' && entry.report) {
        entry.report = buildReport(entry.requestId, entry.report.items.map((item) => (item.result === 'queued' ? { id: item.id, result: 'sent' as const } : item)));
      }
      entry.settled = true;
    })();
    return entry.settling;
  }

  async function handleDeferredResult(result: DeferredSendResult): Promise<void> {
    if (disposed || !active || typeof result !== 'object' || result === null) return;
    for (const entry of ledger.values()) {
      // Both the request and the artifact must match: the same request id on another artifact is another send.
      if (entry.state === 'queued' && entry.requestId === result.selectionId && entry.root === result.artifactKey) {
        await settleEntry(entry, result.outcome);
        return;
      }
    }
  }

  const textHash = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16);

  async function executeBatch(handle: CommentRootHandle, intake: Extract<IntakeResult, { ok: true }>, parsed: ParsedSend, entry: BatchEntry, signal: AbortSignal | undefined): Promise<ArtifactCommentsResult<BatchSendReport>> {
    const coordinator = deps.coordinator as SendCoordinator;
    const { requestId } = parsed;
    const snapshot = await handle.snapshot();
    if (snapshot.health === 'unavailable') return fail('unavailable', snapshot.notice ?? MESSAGES.unexpected);
    if (snapshot.health === 'read-only') return fail('read-only', snapshot.notice ?? MESSAGES.unexpected);

    const known = new Map(snapshot.comments.map((comment) => [comment.id, comment]));
    const results = new Map<string, ItemResult>();
    const sendable: ArtifactComment[] = [];
    for (const id of parsed.ids) {
      const comment = known.get(id);
      if (!comment) results.set(id, { id, result: 'skipped', reason: 'not-found' });
      else if (comment.provenance !== 'local') results.set(id, { id, result: 'skipped', reason: 'foreign' });
      else if (comment.status === 'open' || (comment.status === 'sent' && parsed.resend)) sendable.push(comment);
      else results.set(id, { id, result: 'skipped', reason: 'not-sendable' });
    }
    const report = (): BatchSendReport => buildReport(requestId, parsed.ids.map((id): ItemResult => results.get(id) ?? { id, result: 'skipped', reason: 'conflict' }));
    if (sendable.length === 0) return done(report());
    sendable.sort((a, b) => a.ordinal - b.ordinal);

    // After a restart the ledger is empty and the rebuilt prompt gets a new boundary token, so the host could not tell a
    // retry of this request from a new message. A comment that may already have gone out under this very request id
    // needs the user's decision (a new request), not a silent second send.
    const unsure = sendable.filter((comment) => comment.status === 'open' && comment.send.maybeSent).map((comment) => comment.id);
    if (unsure.length > 0) {
      const marks = await handle.lastBatchRequestIds(unsure);
      if ([...marks.values()].some((mark) => mark === requestId)) return fail('conflict', MESSAGES.maybeSentRetry);
    }

    // Another request holds the one slot: say so before building or writing anything.
    if (coordinator.isBusy(intake.root, requestId)) return fail('busy', BUSY_MESSAGE);

    const sendableKey = sendable.map((comment) => `${comment.id}:${textHash(comment.text)}`).join(',');
    let plan = entry.plan !== null && entry.plan.sendableKey === sendableKey ? entry.plan : null;
    if (plan === null) {
      const escalation = deps.escalation?.() ?? { keywords: [], known: true };
      const dir = path.join(intake.root, SIDECAR_DIR, 'selections');
      // One read of the source files serves every comment of the batch.
      const files = await loadSourceFiles(intake.root).catch(() => []);
      const items: BatchPromptItem[] = await Promise.all(sendable.map(async (comment) => {
        const selection = await readSelection(intake.root, intake.manifest.id, comment.selectionId, comment.redacted || intake.vaultRead);
        const hints = selection ? await findSourceHints(intake.root, selection, { files }).catch(() => []) : [];
        // A pin saved before the artifact gained `vault: read` keeps page text in its stored anchor: that text is not sent.
        const hide = intake.vaultRead && !comment.redacted;
        const anchor = hide ? { ...comment.anchor, textAnchor: { tag: comment.anchor.textAnchor.tag, text: '' }, landmark: null } : comment.anchor;
        return {
          id: comment.id,
          selectionId: comment.selectionId,
          ordinal: comment.ordinal,
          commentText: comment.text,
          tag: comment.anchor.tag,
          anchorState: parsed.anchorStates[comment.id] ?? 'unknown',
          label: hide ? comment.anchor.tag : comment.label,
          artifactRevision: comment.artifactRevision,
          selection,
          anchor,
          jsonPath: selection ? path.join(dir, `${comment.selectionId}.json`) : null,
          pngPath: comment.hasScreenshot && !comment.redacted && !intake.vaultRead ? path.join(dir, `${comment.selectionId}.png`) : null,
          hints,
        };
      }));
      let built;
      try {
        built = buildBatchPrompt({ items, artifactTitle: intake.title, requestId, boundarySecret: deps.boundarySecret as string, artifactRoot: intake.root, escalationKeywords: escalation.keywords, conservativeKeywords: !escalation.known, maxLength: deps.maxPromptLength });
      } catch (error) {
        warn('threads-design: could not build the batch prompt', error);
        return fail('failed', MESSAGES.promptUnsafe);
      }
      for (const id of built.tooLargeIds) results.set(id, { id, result: 'skipped', reason: 'too-large' });
      for (const id of built.deferredIds) results.set(id, { id, result: 'deferred' });
      if (built.prompt === null) return done(report());
      plan = { sendableKey, prompt: built.prompt, includedIds: built.includedIds, deferredIds: built.deferredIds, tooLargeIds: built.tooLargeIds };
      entry.plan = plan;
    } else {
      for (const id of plan.tooLargeIds) results.set(id, { id, result: 'skipped', reason: 'too-large' });
      for (const id of plan.deferredIds) results.set(id, { id, result: 'deferred' });
    }
    if (signal?.aborted) return fail('unavailable', MESSAGES.aborted);

    // Write-ahead (one store write): after this, a crash leaves `pending` comments that the next start recovers.
    // The versions seen in the snapshot are required, so an edit that landed since then cannot be marked sent unsent.
    entry.memberIds = plan.includedIds;
    entry.state = 'sending';
    const written = await handle.transition(plan.includedIds.map((id) => ({ id, event: known.get(id)?.status === 'sent' ? ('batch-resend' as const) : ('batch-issued' as const), requestId, expectedVersion: known.get(id)?.version })));
    if (written.status !== 'ok') {
      entry.state = 'failed';
      entry.memberIds = [];
      if (written.reason === 'invalid-transition' || written.reason === 'not-found' || written.reason === 'foreign' || written.reason === 'conflict') {
        entry.plan = null;
        for (const id of plan.includedIds) results.set(id, { id, result: 'skipped', reason: 'conflict' });
        return done(report());
      }
      return written;
    }
    const markMembers = (result: BatchItemResult) => { for (const id of plan!.includedIds) results.set(id, { id, result }); };

    const outcome = await coordinator.submit({ selectionId: requestId, artifactKey: intake.root, threadId: intake.threadId, prompt: plan.prompt });
    // A reload mid-send leaves the write-ahead state for the next start to recover; nothing more is written here.
    if (disposed) { entry.state = 'failed'; return fail('unavailable', MESSAGES.inactive); }
    if (outcome.status === 'sent') {
      entry.state = 'done';
      markMembers('sent');
      const recorded = await recordMembers(handle, plan.includedIds, 'delivered', requestId, MESSAGES.delivered, { event: 'reload-recovered', message: MESSAGES.notRecorded });
      const final = report();
      return done(recorded ? final : { ...final, message: `${final.message} ${MESSAGES.notRecorded}`.slice(0, ARTIFACT_COMMENTS_CAPS.maxMessageUnits) });
    }
    if (outcome.status === 'queued') {
      entry.state = 'queued';
      markMembers('queued');
      return done(report());
    }
    entry.state = 'failed';
    await recordMembers(handle, plan.includedIds, 'send-failed', requestId, outcome.message, { event: 'expired', message: outcome.message });
    return fail(outcome.reason, outcome.message);
  }

  const provider: ArtifactCommentsProvider = {
    capabilities: { pins: true, batchSend: true, textEdit: false },

    list(target) {
      return run(target, async (handle) => done(withRestartNotice(await handle.snapshot())));
    },

    get(target, id) {
      if (typeof id !== 'string' || !ARTIFACT_COMMENT_ID_PATTERN.test(id)) return Promise.resolve(fail('invalid', 'That is not a comment id.'));
      return run(target, async (handle, intake) => {
        const found = await handle.get(id);
        if (found.status !== 'ok') return found;
        const selection = await readSelection(intake.root, intake.manifest.id, found.value.selectionId, found.value.redacted || intake.vaultRead);
        return done({ comment: found.value, selection });
      });
    },

    save(target, input, ctx) {
      return run(target, async (handle, intake) => {
        const raw = isObject(input) ? input.request : undefined;
        const validated = validateFeedbackRequest(raw);
        if (!validated.ok) return fail('invalid', `${MESSAGES.invalidRequest}: ${validated.message}`);
        const request = validated.value;
        const asked = target as ArtifactFeedbackTarget;
        if (request.artifact.artifactId !== asked.artifactId || request.artifact.root !== asked.root) return fail('invalid', `${MESSAGES.invalidRequest}: it belongs to another design.`);
        const { selection } = request;
        if (intake.vaultRead && !selection.redacted) return fail('invalid', MESSAGES.notRedacted);
        const captured = Date.parse(selection.capturedAt);
        if (!Number.isFinite(captured) || Math.abs(now() - captured) > SKEW_MS) return fail('invalid', MESSAGES.staleClock);
        if (ctx?.signal?.aborted) return fail('unavailable', MESSAGES.aborted);

        // A vault-read pin never has a PNG, even if bytes were sent, and never a text anchor (the validator already blanks it).
        const png = request.screenshot && !intake.vaultRead ? request.screenshot.bytes : null;
        let files;
        try {
          files = await writeSelectionFiles({
            root: intake.root,
            selectionId: selection.selectionId,
            json: serializeSelectionRecord({ request, title: intake.title, vaultRead: intake.vaultRead, png, contractVersion: 2 }),
            png,
            vaultRead: intake.vaultRead,
          });
        } catch (error) {
          warn('threads-design: could not write pin selection files', error);
          return fail('failed', MESSAGES.files);
        }

        const result = await handle.create({
          selectionId: selection.selectionId,
          // Host clock: capturedAt comes from the page-side embedder and is used only for the staleness check above.
          createdAt: new Date(now()).toISOString(),
          artifactRevision: selection.artifactRevision,
          viewSessionId: selection.viewSessionId,
          kind: 'pin',
          text: request.comment,
          anchor: {
            route: selection.route,
            tag: selection.tag,
            selector: selection.selector,
            selectorAlternates: [...selection.selectorAlternates],
            textAnchor: { tag: selection.textAnchor.tag, text: selection.redacted ? '' : selection.textAnchor.text },
            landmark: selection.redacted ? null : selection.landmark,
            lastRect: { ...selection.boundingBox.document },
          },
          label: labelFor(selection),
          hasScreenshot: png !== null,
          redacted: selection.redacted || intake.vaultRead,
        });
        if (result.status !== 'ok') {
          // Nothing references the files we just wrote: do not leave them behind.
          await cleanUpOwnFiles(handle, intake.root, selection.selectionId, files);
          return result;
        }
        await pruneAround(handle, intake.root, selection.selectionId);
        return result;
      });
    },

    update(target, input) {
      return run(target, async (handle, intake) => {
        const raw: unknown = input;
        const change = isObject(raw) ? raw.change : undefined;
        if (isObject(raw) && isObject(change) && change.action === 'unqueue' && isCommentId(raw.id)) {
          const entry = liveBatchFor(intake.root, raw.id);
          if (entry) return unqueueBatch(handle, entry, raw.id, raw.expectedVersion);
        }
        return handle.update(input);
      });
    },

    remove(target, input) {
      return run(target, (handle) => handle.remove(input));
    },

    adopt(target, input) {
      const ids = isObject(input) ? (input as unknown as AdoptCommentsInput).ids : undefined;
      if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_BATCH || !ids.every((id) => typeof id === 'string' && ARTIFACT_COMMENT_ID_PATTERN.test(id))) {
        return Promise.resolve(fail('invalid', 'Choose between 1 and 20 comments to adopt.'));
      }
      return run(target, (handle) => handle.adopt([...new Set(ids as string[])]));
    },

    subscribe(target, listener) {
      let cancelled = false;
      let started = false;
      let inner: { dispose(): void } | null = null;
      const subscription = {
        dispose() {
          cancelled = true;
          inner?.dispose();
          inner = null;
          subscriptions.delete(subscription);
        },
        /** Attaches to the store once the provider is active. A subscription made earlier waits for activation. */
        attach() {
          if (started || cancelled || !active) return;
          started = true;
          void (async () => {
            try {
              const intake = await intakeOf(target);
              if ('status' in intake || cancelled || !active) return;
              const handle = await handleFor(intake.root, intake.manifest.id);
              if (cancelled || !active) return;
              const deliver = (change: ArtifactCommentsChange) => {
                if (cancelled) return;
                try {
                  listener(structuredClone(change));
                } catch (error) {
                  warn('threads-design: a comments listener threw', error);
                }
              };
              const attached = handle.subscribe(deliver);
              if (attached === null) {
                // Too many listeners: tell this one to re-list, since it will not hear future changes.
                warn(MESSAGES.tooManySubscribers);
                deliver({ storeId: `str_${'0'.repeat(32)}`, revision: 0, reason: 'recovered', ids: 'all' });
                return;
              }
              if (cancelled) attached.dispose();
              else inner = attached;
            } catch (error) {
              warn('threads-design: could not subscribe to comments', error);
            }
          })();
        },
      };
      if (disposed || typeof listener !== 'function') return { dispose() { /* nothing attached */ } };
      subscriptions.add(subscription);
      subscription.attach();
      return subscription;
    },

    sendBatch(target, input, ctx) {
      const parsed = parseSendInput(input);
      if (!parsed.ok) return Promise.resolve(parsed.result);
      if (!deps.coordinator || !deps.boundarySecret) return Promise.resolve(fail('unavailable', MESSAGES.sendUnavailable));
      return run(target, async (handle, intake) => {
        pruneLedger();
        const key = `${intake.root}\0${parsed.requestId}`;
        const requested = `${parsed.resend ? 'resend' : 'send'}:${[...parsed.ids].sort().join(',')}`;
        let entry = ledger.get(key);
        if (entry) {
          if (entry.requested !== requested) return fail('conflict', MESSAGES.requestReused);
          // A request the user took back stays taken back for the ledger window: a late retry must not revive it.
          if (entry.state === 'cancelled') return fail('conflict', MESSAGES.cancelled);
          // The previous attempt is still writing its outcome: answering now would use a state that is about to change.
          if (entry.settling && !entry.settled) return fail('busy', MESSAGES.settling);
          if (entry.promise) return entry.promise;
          if (entry.report) return done(entry.report);
        } else {
          entry = { key, root: intake.root, artifactId: intake.manifest.id, requestId: parsed.requestId, requested, at: now(), state: 'idle', promise: null, report: null, plan: null, memberIds: [], settling: null, settled: false };
          ledger.set(key, entry);
          trimLedger();
        }
        const current = entry;
        const attempt = executeBatch(handle, intake, parsed, current, ctx?.signal);
        current.promise = attempt;
        void attempt.then((result) => {
          current.promise = null;
          if (result.status === 'ok') current.report = result.value;
          else if (current.plan === null && ledger.get(key) === current) ledger.delete(key);
        }, () => {
          current.promise = null;
          if (ledger.get(key) === current) ledger.delete(key);
        });
        return attempt;
      });
    },
  };

  /**
   * After a rejected save: remove only the files THIS call created, and none at all when a comment for the id exists
   * or the id is listed as pinned (another request may have won the race, or a v1 Send record owns them).
   */
  async function cleanUpOwnFiles(handle: CommentRootHandle, root: string, selectionId: string, files: { createdJson: boolean; createdPng: boolean }): Promise<void> {
    if (!files.createdJson && !files.createdPng) return;
    let remove = { json: files.createdJson, png: files.createdPng };
    try {
      const existing = await handle.get(`cmt_${selectionId.slice(4)}`);
      if (existing.status === 'ok') {
        // The comment owns its json always, and its png only if it was saved with one: a png this losing call added is an orphan.
        remove = { json: false, png: files.createdPng && !existing.value.hasScreenshot };
      } else if ((await handle.protectedSelectionIds().catch(() => null))?.includes(selectionId)) {
        return;
      }
    } catch {
      return;
    }
    if (remove.json || remove.png) await removeSelectionFiles(root, selectionId, remove);
  }

  /** Retention around a fresh pin: every comment's selection is exempt; if they cannot be listed, nothing is pruned. */
  async function pruneAround(handle: CommentRootHandle, root: string, selectionId: string): Promise<void> {
    try {
      const protectIds = await handle.protectedSelectionIds();
      await pruneSelections({ root, keep: retention, protectId: selectionId, protectIds });
    } catch {
      // A store that is not healthy cannot say which selections are pinned: keep everything, and say so once.
      if (!warnedUnhealthy.has(root)) {
        warnedUnhealthy.add(root);
        warn('threads-design: selection retention is skipped because the comment store is not healthy');
      }
    }
  }

  return {
    provider,
    handleDeferredResult,
    activate() {
      if (disposed) return;
      active = true;
      for (const subscription of [...subscriptions]) subscription.attach();
    },
    async protectedSelectionIds(root, artifactId) {
      if (!active) return null;
      try {
        return await (await handleFor(root, artifactId)).protectedSelectionIds();
      } catch {
        return null;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      active = false;
      ledger.clear();
      for (const subscription of [...subscriptions]) subscription.dispose();
      const open = [...handles.values()];
      handles.clear();
      for (const pending of open) void pending.then((handle) => handle.dispose(), () => undefined);
    },
  };
}

/**
 * Retention guard for the v1-only registration (no store): if comments were ever written for this artifact, the
 * pinned selections are unknown, so pruning is skipped. Otherwise nothing extra needs protecting.
 */
export async function protectedIdsWithoutStore(root: string): Promise<readonly string[] | null> {
  for (const name of ['comments.json', 'comments.prev.json']) {
    try {
      await fs.lstat(path.join(root, SIDECAR_DIR, name));
      return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
    }
  }
  return [];
}
