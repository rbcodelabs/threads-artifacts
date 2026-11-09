import { createHash } from 'node:crypto';
import type { AgentThreadsApiV1, PublicThreadEvent } from './contracts';

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

export const BUSY_MESSAGE = 'A comment is already waiting for the agent. It will send when the current run finishes.';
const MESSAGES = {
  conflict: 'This comment clashes with an earlier send. Pick the element again and resend.',
  invalid: 'Agent Threads would not accept this message (it may be too long). Shorten the comment and try again.',
  gone: 'The thread was deleted, so the comment could not be sent.',
  runFailed: 'The agent could not start this message. Check the thread, then try again.',
  unavailable: 'Agent Threads is not available right now. Try again in a moment.',
  generic: 'Could not send to the thread. Try again.',
  disposed: 'Design is shutting down. Try again once it has reloaded.',
} as const;

export type SendOutcome =
  | { readonly status: 'sent' }
  | { readonly status: 'queued' }
  | { readonly status: 'rejected'; readonly reason: 'busy' | 'invalid' | 'unavailable' | 'failed'; readonly message: string };

type Rejected = Extract<SendOutcome, { status: 'rejected' }>;

export interface DeferredSendResult { readonly selectionId: string; readonly outcome: SendOutcome }

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
}

export interface SendCoordinator {
  submit(request: SendRequest): Promise<SendOutcome>;
  readonly pendingCount: number;
  dispose(): void;
}

export const idempotencyKeyFor = (threadId: string, prompt: string): string =>
  `design:${threadId}:${createHash('sha256').update(prompt).digest('hex').slice(0, 32)}`;

const rejected = (reason: Rejected['reason'], message: string): Rejected => ({ status: 'rejected', reason, message });
const errorCode = (error: unknown): string | undefined => (typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined);

function mapSendError(error: unknown): Rejected {
  switch (errorCode(error)) {
    case 'IDEMPOTENCY_CONFLICT': return rejected('failed', MESSAGES.conflict);
    case 'INVALID_ARGUMENT': return rejected('invalid', MESSAGES.invalid);
    case 'THREAD_NOT_FOUND': return rejected('unavailable', MESSAGES.gone);
    case 'RUN_FAILED': return rejected('failed', MESSAGES.runFailed);
    case 'PLUGIN_UNAVAILABLE': return rejected('unavailable', MESSAGES.unavailable);
    default: return rejected('failed', MESSAGES.generic);
  }
}

interface Slot extends SendRequest {
  settleTimer: unknown | null;
  draining: boolean;
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
  const inFlight = new Map<string, string>();
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
  async function attempt(request: SendRequest): Promise<SendOutcome | typeof BUSY> {
    let runId: string;
    try {
      ({ runId } = await api.threads.send(request.threadId, {
        prompt: request.prompt,
        ownerPluginId,
        idempotencyKey: idempotencyKeyFor(request.threadId, request.prompt),
      }));
    } catch (error) {
      if (errorCode(error) === 'THREAD_BUSY') return BUSY;
      return mapSendError(error);
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

  function finish(slot: Slot, outcome: SendOutcome): void {
    if (slots.get(slot.artifactKey) !== slot) return;
    if (slot.settleTimer !== null) { clock.clearTimeout(slot.settleTimer); slot.settleTimer = null; }
    slots.delete(slot.artifactKey);
    onDeferredResult?.({ selectionId: slot.selectionId, outcome });
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
      const outcome = await attempt(slot);
      if (disposed) return;
      if (outcome === BUSY) return;
      finish(slot, outcome);
    } catch {
      // Transient host error while draining: keep the slot; the next poll retries.
    } finally {
      slot.draining = false;
    }
  }

  function hold(request: SendRequest): SendOutcome {
    slots.set(request.artifactKey, { ...request, settleTimer: null, draining: false });
    watch();
    return { status: 'queued' };
  }

  async function submit(request: SendRequest): Promise<SendOutcome> {
    if (disposed) return rejected('unavailable', MESSAGES.disposed);
    const held = slots.get(request.artifactKey);
    if (held) return held.selectionId === request.selectionId ? { status: 'queued' } : rejected('busy', BUSY_MESSAGE);
    const running = inFlight.get(request.artifactKey);
    if (running !== undefined && running !== request.selectionId) return rejected('busy', BUSY_MESSAGE);
    inFlight.set(request.artifactKey, request.selectionId);
    try {
      let state: ThreadState;
      try {
        state = await threadState(request.threadId);
      } catch {
        return rejected('unavailable', MESSAGES.unavailable);
      }
      if (disposed) return rejected('unavailable', MESSAGES.disposed);
      if (state === 'missing') return rejected('unavailable', MESSAGES.gone);
      if (state === 'busy') return hold(request);
      const outcome = await attempt(request);
      if (disposed) return rejected('unavailable', MESSAGES.disposed);
      return outcome === BUSY ? hold(request) : outcome;
    } catch (error) {
      return mapSendError(error);
    } finally {
      if (inFlight.get(request.artifactKey) === request.selectionId) inFlight.delete(request.artifactKey);
    }
  }

  return {
    submit,
    get pendingCount() { return slots.size; },
    dispose() {
      disposed = true;
      for (const slot of slots.values()) if (slot.settleTimer !== null) clock.clearTimeout(slot.settleTimer);
      slots.clear();
      inFlight.clear();
      if (pollTimer !== null) { clock.clearTimeout(pollTimer); pollTimer = null; }
      if (subscription) { subscription.dispose(); subscription = null; }
    },
  };
}
