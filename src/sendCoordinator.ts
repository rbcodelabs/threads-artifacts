import { createHash } from 'node:crypto';
import type { AgentThreadsApiV1, PublicThreadEvent } from './contracts';
import { ARTIFACT_FEEDBACK_SUBMIT_TIMEOUT_MS } from './geodeArtifactFeedback';

/**
 * Delivers a finished prompt to a thread through `threads.send` v1 and copes with a busy thread.
 *
 * v1 has no queue for peers (spike C2), so busy comments wait in ONE in-memory slot per artifact.
 * The slot drains on `run.completed` / `run.failed` for that thread (after a short settle delay and
 * a re-check of `isRunning`) with a ~5 s `isRunning` poll as the backup, because user-started runs
 * and a dropped subscription are both possible. `THREAD_BUSY` stays the backstop. The idempotency
 * key is a hash of the final prompt, so a retry of identical content never double-sends.
 * Pending state is deliberately not persisted (spec 13c assumption b).
 */

export const POLL_INTERVAL_MS = 5000;
export const SETTLE_DELAY_MS = 250;
const VERIFY_WAIT_MS = 250;
/** A queued comment older than this is dropped with a notice instead of sending hours later. */
export const PENDING_TTL_MS = 30 * 60 * 1000;
/**
 * Upper bound for one submit. It must be strictly shorter than Geode's own submit timeout: after Geode gives
 * up, the user's FIRST Retry must start a fresh attempt (same idempotency key) instead of reattaching to the
 * still-hung one. Derived from the contract constant so the two cannot drift.
 */
export const ATTEMPT_TIMEOUT_MS = Math.max(5000, ARTIFACT_FEEDBACK_SUBMIT_TIMEOUT_MS - 3000);

export const BUSY_MESSAGE = 'A comment is already waiting for the agent. It will send when the current run finishes.';
const MESSAGES = {
  conflict: 'This comment clashes with an earlier send. Press Retry; if it keeps failing, pick the element again.',
  invalid: 'Agent Threads would not accept this message (it may be too long). Shorten the comment and try again.',
  gone: 'The thread was deleted, so the comment could not be sent.',
  runFailed: 'The agent could not start this message. Check the thread, then try again.',
  unavailable: 'Agent Threads is not available right now. Try again in a moment.',
  generic: 'Could not send to the thread. Try again.',
  unconfirmed: 'Could not confirm the send. It may have reached the thread; check the thread before retrying.',
  stillSending: 'The earlier attempt may still be reaching the thread. Wait a moment, then try again.',
  disposed: 'Design is shutting down. Try again once it has reloaded.',
  statusUnknown: 'Design reloaded while sending. The comment may already have reached the thread; check the thread before retrying.',
  timedOut: 'Agent Threads did not answer in time. The comment may have been received; check the thread before retrying.',
  expired: 'Your queued comment waited too long for the agent and was not sent. Send it again.',
  droppedOnDispose: 'Design reloaded before your queued comment could be sent. Send it again.',
} as const;

export type SendOutcome =
  | { readonly status: 'sent' }
  | { readonly status: 'queued' }
  | {
      readonly status: 'rejected';
      readonly reason: 'busy' | 'invalid' | 'unavailable' | 'failed';
      readonly message: string;
      /** Present (true) only when the message may nevertheless have reached the thread: a timeout, or a reload mid-send. */
      readonly maybeSent?: boolean;
    };

type Rejected = Extract<SendOutcome, { status: 'rejected' }>;

/** A queued message ended without `submit` knowing: it was sent, failed, or the caller cancelled it (`cancel`). */
export type DeferredOutcome = SendOutcome | { readonly status: 'cancelled' };

export interface DeferredSendResult {
  readonly selectionId: string;
  /** The artifact the held message belonged to: a result is only meaningful for that artifact. */
  readonly artifactKey: string;
  readonly outcome: DeferredOutcome;
}

export interface SendRequest {
  readonly selectionId: string;
  /** One pending slot exists per artifact key. */
  readonly artifactKey: string;
  readonly threadId: string;
  readonly prompt: string;
}

export interface CoordinatorClock {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SendCoordinatorOptions {
  readonly api: AgentThreadsApiV1;
  readonly ownerPluginId: string;
  readonly clock?: CoordinatorClock;
  /** Called when a queued comment finally sends or fails after `submit` already returned `queued`. */
  readonly onDeferredResult?: (result: DeferredSendResult) => void;
  readonly pendingTtlMs?: number;
  readonly attemptTimeoutMs?: number;
}

export interface SendCoordinator {
  submit(request: SendRequest): Promise<SendOutcome>;
  /**
   * Drops the held (queued) message `selectionId` for `artifactKey` and reports a `cancelled` deferred result.
   * False when no such message is held, or when it is being sent right now (too late to take back).
   */
  cancel(artifactKey: string, selectionId: string): boolean;
  /** True when the artifact's slot or an in-flight send belongs to a DIFFERENT request than `selectionId`: a submit now would be rejected busy. */
  isBusy(artifactKey: string, selectionId: string): boolean;
  readonly pendingCount: number;
  dispose(): void;
}

export const idempotencyKeyFor = (threadId: string, prompt: string): string =>
  `design:${threadId}:${createHash('sha256').update(prompt).digest('hex').slice(0, 32)}`;

const rejected = (reason: Rejected['reason'], message: string): Rejected => ({ status: 'rejected', reason, message });
const uncertain = (reason: Rejected['reason'], message: string): Rejected => ({ status: 'rejected', reason, message, maybeSent: true });
const errorCode = (error: unknown): string | undefined => (typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined);

/** `issued`: threads.send was already called, so an error we cannot classify may still have come after delivery. */
function mapSendError(error: unknown, issued = false): Rejected {
  switch (errorCode(error)) {
    case 'IDEMPOTENCY_CONFLICT': return rejected('failed', MESSAGES.conflict);
    case 'INVALID_ARGUMENT': return rejected('invalid', MESSAGES.invalid);
    case 'THREAD_NOT_FOUND': return rejected('unavailable', MESSAGES.gone);
    case 'RUN_FAILED': return rejected('failed', MESSAGES.runFailed);
    case 'PLUGIN_UNAVAILABLE': return rejected('unavailable', MESSAGES.unavailable);
    default: return issued ? uncertain('failed', MESSAGES.unconfirmed) : rejected('failed', MESSAGES.generic);
  }
}

interface Slot extends SendRequest {
  settleTimer: unknown | null;
  ttlTimer: unknown | null;
  draining: boolean;
  /** True while `threads.send` may be in progress for this slot: cancelling then would lie. */
  sending: boolean;
}

type ThreadState = 'missing' | 'busy' | 'idle';
const BUSY = Symbol('busy');

const realClock: CoordinatorClock = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createSendCoordinator(options: SendCoordinatorOptions): SendCoordinator {
  const { api, ownerPluginId, onDeferredResult } = options;
  const clock = options.clock ?? realClock;
  const slots = new Map<string, Slot>();
  const inFlight = new Map<string, { selectionId: string; promise: Promise<SendOutcome> }>();
  const outstanding = new Map<string, { issued: { value: boolean }; prompt: string; run: Promise<SendOutcome> }>();
  const ttlMs = options.pendingTtlMs ?? PENDING_TTL_MS;
  const attemptTimeoutMs = options.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS;

  /** The callback typically shows a Notice; a throwing callback must never break the coordinator or a host subscription. */
  const notifyDeferred = (result: DeferredSendResult): void => {
    try { onDeferredResult?.(result); } catch { /* ignore */ }
  };
  let subscription: { dispose(): void } | null = null;
  let pollTimer: unknown | null = null;
  let disposed = false;

  const canSubscribe = typeof api.threads.subscribe === 'function' && api.capabilities.includes('threads.subscribe');

  async function threadState(threadId: string): Promise<ThreadState> {
    const thread = await api.threads.get(threadId);
    if (!thread) return 'missing';
    if (thread.isRunning === true) return 'busy';
    try {
      const permissions = await api.threads.permissions(threadId);
      if (permissions?.planApprovalPending) return 'busy';
    } catch {
      // Permissions are a second guard only; THREAD_BUSY remains the backstop.
    }
    return 'idle';
  }

  /** Sends once. Returns BUSY when the host says the thread is running, so the caller can hold the comment. */
  async function attempt(request: SendRequest, issued?: { value: boolean }): Promise<SendOutcome | typeof BUSY> {
    let runId: string;
    try {
      if (issued) issued.value = true;
      ({ runId } = await api.threads.send(request.threadId, {
        prompt: request.prompt,
        ownerPluginId,
        idempotencyKey: idempotencyKeyFor(request.threadId, request.prompt),
      }));
    } catch (error) {
      if (errorCode(error) === 'THREAD_BUSY') return BUSY;
      return mapSendError(error, true);
    }
    return verifyRun(runId);
  }

  /** `send` returns a runId even when the host-level send failed (spike C2), so look for an immediate failure. */
  async function verifyRun(runId: string): Promise<SendOutcome> {
    if (typeof api.threads.wait !== 'function' || !api.capabilities.includes('threads.wait')) return { status: 'sent' };
    try {
      const result = await api.threads.wait(runId, { timeoutMs: VERIFY_WAIT_MS });
      if (result.status === 'failed') return mapSendError({ code: result.error?.code ?? 'RUN_FAILED' });
    } catch (error) {
      if (errorCode(error) === 'RUN_FAILED') return mapSendError(error);
    }
    return { status: 'sent' };
  }

  function stopWatchingIfIdle(): void {
    if (slots.size > 0) return;
    if (pollTimer !== null) { clock.clearTimeout(pollTimer); pollTimer = null; }
    if (subscription) { subscription.dispose(); subscription = null; }
  }

  function armPoll(): void {
    if (pollTimer !== null || disposed || slots.size === 0) return;
    pollTimer = clock.setTimeout(() => {
      pollTimer = null;
      void Promise.all([...slots.values()].map(drain)).then(armPoll);
    }, POLL_INTERVAL_MS);
  }

  function onThreadEvent(event: PublicThreadEvent): void {
    if (disposed) return;
    const affected = [...slots.values()].filter(slot => slot.threadId === event.threadId);
    if (affected.length === 0) return;
    if (event.kind === 'thread.removed') {
      affected.forEach(slot => finish(slot, rejected('unavailable', MESSAGES.gone)));
      return;
    }
    if (event.kind !== 'run.completed' && event.kind !== 'run.failed') return;
    for (const slot of affected) {
      if (slot.settleTimer !== null) continue;
      slot.settleTimer = clock.setTimeout(() => {
        slot.settleTimer = null;
        void drain(slot);
      }, SETTLE_DELAY_MS);
    }
  }

  function watch(): void {
    if (canSubscribe && !subscription && api.threads.subscribe) subscription = api.threads.subscribe(onThreadEvent);
    armPoll();
  }

  function finish(slot: Slot, outcome: DeferredOutcome): void {
    if (slots.get(slot.artifactKey) !== slot) return;
    if (slot.settleTimer !== null) { clock.clearTimeout(slot.settleTimer); slot.settleTimer = null; }
    if (slot.ttlTimer !== null) { clock.clearTimeout(slot.ttlTimer); slot.ttlTimer = null; }
    slots.delete(slot.artifactKey);
    notifyDeferred({ selectionId: slot.selectionId, artifactKey: slot.artifactKey, outcome });
    stopWatchingIfIdle();
  }

  async function drain(slot: Slot): Promise<void> {
    if (disposed || slot.draining || slots.get(slot.artifactKey) !== slot) return;
    slot.draining = true;
    try {
      const state = await threadState(slot.threadId);
      if (disposed || slots.get(slot.artifactKey) !== slot) return;
      if (state === 'busy') return;
      if (state === 'missing') { finish(slot, rejected('unavailable', MESSAGES.gone)); return; }
      slot.sending = true;
      const outcome = await attempt(slot);
      slot.sending = false;
      if (disposed) return;
      if (outcome === BUSY) return;
      finish(slot, outcome);
    } catch {
      // Transient host error while draining: keep the slot; the next poll retries.
    } finally {
      slot.draining = false;
      slot.sending = false;
    }
  }

  function hold(request: SendRequest): SendOutcome {
    const slot: Slot = { ...request, settleTimer: null, ttlTimer: null, draining: false, sending: false };
    slot.ttlTimer = clock.setTimeout(() => { slot.ttlTimer = null; finish(slot, rejected('unavailable', MESSAGES.expired)); }, ttlMs);
    slots.set(request.artifactKey, slot);
    watch();
    return { status: 'queued' };
  }

  /**
   * `abandoned` is set when the caller was already told the attempt timed out. From then on this run must not create
   * a held slot or issue a send: a slot nobody tracks would block the artifact and send later with no one recording it.
   */
  async function run(request: SendRequest, issued: { value: boolean }, abandoned: { value: boolean }): Promise<SendOutcome> {
    try {
      let state: ThreadState;
      try {
        state = await threadState(request.threadId);
      } catch {
        return rejected('unavailable', MESSAGES.unavailable);
      }
      if (abandoned.value) return rejected('failed', MESSAGES.timedOut);
      if (disposed) return rejected('unavailable', MESSAGES.disposed);
      if (state === 'missing') return rejected('unavailable', MESSAGES.gone);
      if (state === 'busy') return hold(request);
      const outcome = await attempt(request, issued);
      // Contract item 9: once the send was issued it may have reached the host, so do not claim it failed.
      if (disposed) return issued.value ? uncertain('unavailable', MESSAGES.statusUnknown) : rejected('unavailable', MESSAGES.disposed);
      if (outcome === BUSY && abandoned.value) return rejected('failed', MESSAGES.timedOut);
      return outcome === BUSY ? hold(request) : outcome;
    } catch (error) {
      return mapSendError(error, issued.value);
    }
  }

  function withTimeout(promise: Promise<SendOutcome>, abandoned: { value: boolean }, issued: { value: boolean }, onAbandon: () => void): Promise<SendOutcome> {
    return new Promise(resolve => {
      const timer = clock.setTimeout(() => { abandoned.value = true; onAbandon(); resolve(uncertain('failed', MESSAGES.timedOut)); }, attemptTimeoutMs);
      promise.then(outcome => { clock.clearTimeout(timer); resolve(outcome); }, error => { clock.clearTimeout(timer); resolve(mapSendError(error, issued.value)); });
    });
  }

  function submit(request: SendRequest): Promise<SendOutcome> {
    if (disposed) return Promise.resolve(rejected('unavailable', MESSAGES.disposed));
    const held = slots.get(request.artifactKey);
    if (held) return Promise.resolve(held.selectionId === request.selectionId ? { status: 'queued' } : rejected('busy', BUSY_MESSAGE));
    const running = inFlight.get(request.artifactKey);
    if (running) return running.selectionId === request.selectionId ? running.promise : Promise.resolve(rejected('busy', BUSY_MESSAGE));
    // An attempt that timed out is not forgotten while its threads.send may still land. A retry of the same request with
    // the SAME prompt is safe (same idempotency key: the host replays it); a different prompt would be a second message.
    const outstandingKey = `${request.artifactKey}\0${request.selectionId}`;
    const earlier = outstanding.get(outstandingKey);
    if (earlier && earlier.issued.value && earlier.prompt !== request.prompt) return Promise.resolve(uncertain('busy', MESSAGES.stillSending));
    const entry = { selectionId: request.selectionId, promise: undefined as unknown as Promise<SendOutcome> };
    const abandoned = { value: false };
    const issued = { value: false };
    const underlying = run(request, issued, abandoned);
    entry.promise = withTimeout(underlying, abandoned, issued, () => {
      const record = { issued, prompt: request.prompt, run: underlying };
      outstanding.set(outstandingKey, record);
      const forget = () => { if (outstanding.get(outstandingKey) === record) outstanding.delete(outstandingKey); };
      underlying.then(forget, forget);
    }).finally(() => {
      if (inFlight.get(request.artifactKey) === entry) inFlight.delete(request.artifactKey);
    });
    inFlight.set(request.artifactKey, entry);
    return entry.promise;
  }

  function cancel(artifactKey: string, selectionId: string): boolean {
    if (disposed) return false;
    const slot = slots.get(artifactKey);
    if (!slot || slot.selectionId !== selectionId || slot.sending) return false;
    finish(slot, { status: 'cancelled' });
    return true;
  }

  function isBusy(artifactKey: string, selectionId: string): boolean {
    if (disposed) return false;
    const held = slots.get(artifactKey);
    if (held) return held.selectionId !== selectionId;
    const running = inFlight.get(artifactKey);
    return running !== undefined && running.selectionId !== selectionId;
  }

  return {
    submit,
    cancel,
    isBusy,
    get pendingCount() { return slots.size; },
    dispose() {
      disposed = true;
      const dropped = [...slots.values()];
      for (const slot of dropped) {
        if (slot.settleTimer !== null) clock.clearTimeout(slot.settleTimer);
        if (slot.ttlTimer !== null) clock.clearTimeout(slot.ttlTimer);
      }
      slots.clear();
      inFlight.clear();
      outstanding.clear();
      if (pollTimer !== null) { clock.clearTimeout(pollTimer); pollTimer = null; }
      if (subscription) { subscription.dispose(); subscription = null; }
      // The user was told "Queued"; make the loss visible instead of silent.
      for (const slot of dropped) notifyDeferred({ selectionId: slot.selectionId, artifactKey: slot.artifactKey, outcome: rejected('unavailable', MESSAGES.droppedOnDispose) });
    },
  };
}
