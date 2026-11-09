import type { AgentThreadsApiV1, PublicThreadEvent, ThreadArtifactRef } from '../../src/contracts';

export class FakeApiError extends Error {
  constructor(readonly code: string, message = code) { super(message); this.name = 'ClaudeThreadsApiError'; }
}

export interface FakeThread { isRunning: boolean; planApprovalPending: boolean; artifacts: ThreadArtifactRef[]; cwd?: string }
export interface FakeSend { threadId: string; prompt: string; ownerPluginId?: string; idempotencyKey?: string }

export interface FakeApiOptions {
  capabilities?: string[];
  /** Hide `isRunning` from `threads.get` like an older Agent Threads build. */
  omitIsRunning?: boolean;
  /** Omit `threads.subscribe` like an older Agent Threads build. */
  omitSubscribe?: boolean;
  omitWait?: boolean;
}

/** Controllable stand-in for Agent Threads API v1: threads, run state, send outcomes, subscribe events. */
export function createFakeApi(options: FakeApiOptions = {}) {
  const threads = new Map<string, FakeThread>();
  const sends: FakeSend[] = [];
  const listeners = new Set<(event: PublicThreadEvent) => void>();
  const sendErrors: unknown[] = [];
  const state = { hangSends: 0, gate: null as Promise<void> | null, subscribeCalls: 0, disposeCalls: 0, waitResult: { status: 'timed_out' } as { status: string; error?: { code?: string; message?: string } }, nextRun: 1 };
  /** Keys that already produced a run: the real host replays them without re-sending. */
  const seen = new Map<string, { prompt: string; runId: string }>();

  const api = {
    apiVersion: 1 as const,
    generation: 'gen-1',
    capabilities: options.capabilities ?? ['threads.send', 'threads.permissions', 'threads.subscribe', 'threads.wait'],
    threads: {
      get: async (id: string) => {
        const thread = threads.get(id);
        if (!thread) return null;
        return { id, cwd: thread.cwd, artifacts: thread.artifacts, ...(options.omitIsRunning ? {} : { isRunning: thread.isRunning }) };
      },
      permissions: async (id: string) => {
        const thread = threads.get(id);
        return thread ? { effectivePermissionMode: 'default' as const, planApprovalPending: thread.planApprovalPending } : null;
      },
      send: async (id: string, input: { prompt: string; ownerPluginId?: string; idempotencyKey?: string }) => {
        const thread = threads.get(id);
        if (!thread) throw new FakeApiError('THREAD_NOT_FOUND');
        const scoped = `${input.ownerPluginId}\0${id}\0${input.idempotencyKey}`;
        const prior = seen.get(scoped);
        if (prior) {
          if (prior.prompt !== input.prompt) throw new FakeApiError('IDEMPOTENCY_CONFLICT');
          return { runId: prior.runId };
        }
        if (state.hangSends > 0) { state.hangSends--; return new Promise<never>(() => undefined); }
        if (state.gate) await state.gate;
        const queued = sendErrors.shift();
        if (queued) throw queued;
        if (thread.isRunning) throw new FakeApiError('THREAD_BUSY', 'Thread is already running.');
        sends.push({ threadId: id, ...input });
        const runId = `run-${state.nextRun++}`;
        seen.set(scoped, { prompt: input.prompt, runId });
        return { runId };
      },
      open: async () => undefined,
      beginProvisional: async () => { throw new Error('not used'); },
      ...(options.omitSubscribe ? {} : {
        subscribe: (listener: (event: PublicThreadEvent) => void) => {
          state.subscribeCalls++;
          listeners.add(listener);
          return { dispose: () => { state.disposeCalls++; listeners.delete(listener); } };
        },
      }),
      ...(options.omitWait ? {} : { wait: async () => state.waitResult }),
    },
    artifacts: {
      list: async (threadId: string) => threads.get(threadId)?.artifacts ?? [],
      allocateStorage: async () => { throw new Error('not used'); },
      attach: async () => ({ success: true }),
      update: async () => ({ success: true }),
      invokeAction: async () => ({ status: 'ok' as const }),
    },
    extensions: {
      registerArtifactProvider: () => ({ success: true, dispose() {} }),
      registerAgentTool: () => ({ success: true, dispose() {} }),
      registerSlashCommand: () => ({ success: true, dispose() {} }),
    },
  } as unknown as AgentThreadsApiV1;

  return {
    api,
    threads,
    sends,
    sendErrors,
    state,
    addThread(id: string, patch: Partial<FakeThread> = {}) {
      threads.set(id, { isRunning: false, planApprovalPending: false, artifacts: [], ...patch });
    },
    emit(event: PublicThreadEvent) { [...listeners].forEach(listener => listener(event)); },
    get listenerCount() { return listeners.size; },
  };
}
