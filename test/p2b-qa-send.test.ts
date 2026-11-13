import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createArtifactCommentsProvider, type CommentsProviderController } from '../src/artifactCommentsProvider';
import { bodySha256 } from '../src/commentModel';
import { createCommentStore, type CommentRootHandle, type CommentStore } from '../src/commentStore';
import { buildDesignManifest } from '../src/designArtifact';
import type { ArtifactCommentsProvider } from '../src/geodeArtifactFeedbackV2';
import type { ArtifactFeedbackRequest, ArtifactFeedbackTarget } from '../src/geodeArtifactFeedback';
import { ATTEMPT_TIMEOUT_MS, createSendCoordinator, PENDING_TTL_MS, type SendCoordinator } from '../src/sendCoordinator';
import { createFakeApi, FakeApiError } from './helpers/fakeApi';
import { createFakeClock } from './helpers/fakeClock';
import { cmtId, KEY, OTHER_KEY, selId, stored } from './helpers/commentFixtures';
import { validRequest } from './helpers/feedbackFixtures';

/**
 * Independent QA of P2b sendBatch / unqueue / reload recovery (design 1.5, 2.3, 4.2, T4, T6).
 * Tests named "BUG:" use it.fails: they assert the CORRECT behavior, currently fail, and must be fixed in src
 * (then `.fails` removed). Everything else is a regression guard that passes today.
 */

const START_MS = Date.parse('2026-11-08T20:01:00.000Z');
const rid = (hex: string): string => `req_${hex.repeat(32)}`;
const rid2 = (n: number): string => `req_${n.toString(16).padStart(32, '0')}`;

let base: string;
let root: string;
let fake: ReturnType<typeof createFakeApi>;
let clock: ReturnType<typeof createFakeClock>;
let nowMs: number;
let live: { controller: CommentsProviderController; coordinator: SendCoordinator }[];
let controller: CommentsProviderController;
let coordinator: SendCoordinator;
let provider: ArtifactCommentsProvider;
let target: ArtifactFeedbackTarget;
let warnings: unknown[][];

const ctx = () => ({ signal: new AbortController().signal });
const commentsFile = () => path.join(root, '.threads-design', 'comments.json');
const settle = async () => {
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};
async function until(check: () => boolean | Promise<boolean>, limitMs = 3000): Promise<boolean> {
  const stop = Date.now() + limitMs;
  while (Date.now() < stop) {
    if (await check()) return true;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  return false;
}
function ok<T>(result: { status: string; value?: T; reason?: string; message?: string }): T {
  if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status} ${result.reason} ${result.message}`);
  return result.value as T;
}

async function makeArtifact(id = 't1', manifestPatch: Record<string, unknown> = {}): Promise<string> {
  const dir = path.join(base, '.geode', 'artifacts', `design-${id}`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'artifact.json'), JSON.stringify({ ...buildDesignManifest(id, 'Landing'), ...manifestPatch }));
  await fs.writeFile(path.join(dir, 'index.html'), '<main><h1 id="hero-title">Build faster</h1></main>\n');
  return dir;
}

interface Hooks {
  /** Replace the handle's `transition`. Return undefined to fall through to the real one. */
  transition?: (items: readonly any[], real: CommentRootHandle, call: number) => Promise<any> | undefined;
  update?: (input: any, real: CommentRootHandle, call: number) => Promise<any> | undefined;
  /** Runs after the real snapshot, before the provider sees it; may mutate the store behind the provider's back. */
  afterSnapshot?: (real: CommentRootHandle, snapshot: any, call: number) => Promise<void>;
}

/** Fault injection around the real store: nothing else is mocked. */
function wrapStore(real: CommentStore, hooks: Hooks): CommentStore {
  const calls = { transition: 0, update: 0, snapshot: 0 };
  return {
    async open(targetArg) {
      const handle = await real.open(targetArg);
      return new Proxy(handle, {
        get(obj, prop) {
          const value = Reflect.get(obj, prop) as unknown;
          if (prop === 'transition' && hooks.transition) return (items: readonly any[]) => hooks.transition!(items, obj, ++calls.transition) ?? (obj as any).transition(items);
          if (prop === 'update' && hooks.update) return (input: any) => hooks.update!(input, obj, ++calls.update) ?? (obj as any).update(input);
          if (prop === 'snapshot' && hooks.afterSnapshot) return async () => { const snap = await (obj as any).snapshot(); await hooks.afterSnapshot!(obj, snap, ++calls.snapshot); return snap; };
          return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(obj) : value;
        },
      }) as CommentRootHandle;
    },
  };
}

interface StackOptions { maxPromptLength?: number; boundarySecret?: string; hooks?: Hooks; coordApi?: any; escalation?: () => { keywords: readonly string[]; known: boolean } }

function makeStack(extra: StackOptions = {}) {
  const realStore = createCommentStore({ keys: { getKey: async () => KEY }, now: () => new Date(START_MS) });
  const store = extra.hooks ? wrapStore(realStore, extra.hooks) : realStore;
  let ctl!: CommentsProviderController;
  const coord = createSendCoordinator({ api: extra.coordApi ?? fake.api, ownerPluginId: 'threads-design', clock, onDeferredResult: result => { void ctl.handleDeferredResult(result); } });
  ctl = createArtifactCommentsProvider({
    api: fake.api,
    vaultRoot: () => base,
    store,
    now: () => nowMs,
    coordinator: coord,
    boundarySecret: extra.boundarySecret ?? 'qa-batch-secret',
    escalation: extra.escalation ?? (() => ({ keywords: [], known: true })),
    maxPromptLength: extra.maxPromptLength,
    warn: (...args: unknown[]) => { warnings.push(args); },
  });
  ctl.activate();
  live.push({ controller: ctl, coordinator: coord });
  return { controller: ctl, coordinator: coord };
}

function useStack(extra: StackOptions = {}) {
  const stack = makeStack(extra);
  controller = stack.controller;
  coordinator = stack.coordinator;
  provider = controller.provider;
}

function request(n: number, patch: Record<string, unknown> = {}, selectionPatch: Record<string, unknown> = {}, artifactRoot = root, artifactId = 'design-t1'): ArtifactFeedbackRequest {
  const req = validRequest({ comment: `Comment ${n}`, ...patch }) as any;
  req.artifact.root = artifactRoot;
  req.artifact.artifactId = artifactId;
  req.selection = { ...req.selection, selectionId: selId(n), artifactId, ...selectionPatch };
  return req;
}

async function pin(n: number, patch: Record<string, unknown> = {}, selectionPatch: Record<string, unknown> = {}) {
  return ok<any>(await provider.save(target, { request: request(n, patch, selectionPatch) }, ctx())).comment;
}
const pins = async (count: number) => { for (let n = 1; n <= count; n++) await pin(n); };
const list = async () => ok<any>(await provider.list(target, ctx()));
const byId = async (n: number) => (await list()).comments.find((c: any) => c.id === cmtId(n));
const send = (ids: number[], requestId = rid('a'), extra: Record<string, unknown> = {}, tgt: ArtifactFeedbackTarget = target) =>
  provider.sendBatch(tgt, { requestId, ids: ids.map(cmtId), resend: false, anchorStates: {}, ...extra } as never, ctx());
const unqueue = async (n: number, tgt: ArtifactFeedbackTarget = target) => {
  const member = (ok<any>(await provider.list(tgt, ctx()))).comments.find((c: any) => c.id === cmtId(n));
  return provider.update(tgt, { id: cmtId(n), expectedVersion: member.version, change: { action: 'unqueue' } }, ctx());
};
const rev = async (): Promise<number> => JSON.parse(await fs.readFile(commentsFile(), 'utf8')).rev;

async function rewriteComments(mutate: (file: any) => void): Promise<void> {
  const file = JSON.parse(await fs.readFile(commentsFile(), 'utf8'));
  mutate(file);
  file.rev += 1;
  file.bodySha256 = bodySha256({ comments: file.comments, tombstones: file.tombstones, nextOrdinal: file.nextOrdinal });
  await fs.writeFile(commentsFile(), JSON.stringify(file));
}

const running = (value: boolean, thread = 't1') => { fake.threads.get(thread)!.isRunning = value; };
const finishRun = async (thread = 't1') => {
  running(false, thread);
  fake.emit({ kind: 'run.completed', threadId: thread, runId: 'x' });
  await clock.advance(300);
  await settle();
};
async function waitPending(n: number): Promise<void> {
  for (let i = 0; i < 100; i++) { await settle(); if ((await byId(n))?.status === 'pending') return; }
  throw new Error(`comment ${n} never became pending`);
}
const gateSends = () => {
  let release!: () => void;
  fake.state.gate = new Promise<void>(resolve => { release = resolve; });
  return () => { release(); };
};
const promptsOf = () => fake.sends.map(s => s.prompt);

beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'td-p2bqa-')));
  root = await makeArtifact();
  fake = createFakeApi();
  fake.addThread('t1', { artifacts: [{ providerId: 'agent-threads.design', kind: 'design-static', schemaVersion: 2, id: 'design-t1', title: 'Landing', data: {}, storageRoot: root }] });
  clock = createFakeClock();
  nowMs = START_MS;
  live = [];
  warnings = [];
  useStack();
  target = { root, artifactId: 'design-t1', title: 'Landing', runtime: 'static', vaultRead: false };
});
afterEach(async () => {
  for (const entry of live) { entry.controller.dispose(); entry.coordinator.dispose(); }
  await fs.rm(base, { recursive: true, force: true });
});

// =============================================================================================
// Reviewer B1 (blocking): coordinator timeout while run() continues
// =============================================================================================

describe('B1: coordinator timeout (12 s) while run() is still going', () => {
  /** A coordinator view of the API whose threads.get can be held; the provider's own intake keeps the normal API. */
  function holdableCoordApi() {
    const real = fake.api.threads.get.bind(fake.api.threads);
    const gate = { hold: false, release: () => undefined as void, promise: Promise.resolve() };
    gate.promise = new Promise<void>(resolve => { gate.release = resolve; });
    const coordApi = { ...fake.api, threads: { ...fake.api.threads, get: async (id: string) => { if (gate.hold) await gate.promise; return real(id); } } };
    return { coordApi, gate };
  }

  async function timedOutBatch() {
    const { coordApi, gate } = holdableCoordApi();
    controller.dispose(); coordinator.dispose();
    useStack({ coordApi });
    await pins(2);
    running(true);
    gate.hold = true;
    const first = send([1], rid('a'));
    await waitPending(1);
    await clock.advance(ATTEMPT_TIMEOUT_MS + 10);
    const result = await first;
    return { gate, result };
  }

  it('the caller gets a failure after the timeout and the comment is back to open with a warning that it may have arrived', async () => {
    const { result } = await timedOutBatch();
    expect(result).toMatchObject({ status: 'rejected', reason: 'failed' });
    expect(await byId(1)).toMatchObject({ status: 'open', send: { lastOutcome: 'failed' } });
    const comment = await byId(1);
    expect(comment.send.maybeSent || /may have been received|check the thread/i.test(comment.send.lastMessage ?? '')).toBe(true);
  });

  it('BUG B1a: a late hold() after the timeout leaves an orphan slot: another batch is rejected busy although nothing is pending', async () => {
    const { gate } = await timedOutBatch();
    gate.hold = false; gate.release();
    await settle();
    expect(coordinator.pendingCount, 'orphaned slot for a request whose submit already failed').toBe(0);
    // A different comment must be able to queue or send now.
    const next = await send([2], rid('b'));
    expect(next.status, `second batch got ${JSON.stringify(next)}`).toBe('ok');
  });

  it('BUG B1b: the orphan slot later delivers the message but the comment stays open/failed (deferred result dropped)', async () => {
    const { gate } = await timedOutBatch();
    gate.hold = false; gate.release();
    await settle();
    await finishRun();
    // The host received the message...
    const delivered = fake.sends.length;
    const comment = await byId(1);
    // ...so the comment must say so (sent) or at least be flagged as maybe sent. It must never read as an ordinary failure.
    if (delivered > 0) expect(comment.status === 'sent' || comment.send.maybeSent, `delivered ${delivered}x but comment is ${comment.status} lastOutcome=${comment.send.lastOutcome} maybeSent=${comment.send.maybeSent}`).toBe(true);
    else expect(coordinator.pendingCount).toBe(0);
  });

  it('a hung threads.send on an idle thread times out into a clear failure; a retry with the same request id reuses the prompt so the host dedupes', async () => {
    await pins(1);
    const release = gateSends();
    const first = send([1], rid('a'));
    await waitPending(1);
    await clock.advance(ATTEMPT_TIMEOUT_MS + 10);
    expect(await first).toMatchObject({ status: 'rejected', reason: 'failed' });
    release();
    await settle();
    expect(fake.sends).toHaveLength(1); // the slow host did take it after the timeout
    const retry = ok<any>(await send([1], rid('a')));
    expect(retry.outcome).toBe('sent');
    expect(fake.sends, 'retry with the same request id must not create a second message').toHaveLength(1);
    expect(await byId(1)).toMatchObject({ status: 'sent' });
  });
});

// =============================================================================================
// Reload then retry the same request id (reviewer: double send)
// =============================================================================================

describe('reload while a send is in flight, then the client retries the same request id', () => {
  async function crashedAfterDelivery(newSecret: string) {
    await pins(1);
    const release = gateSends();
    const old = send([1], rid('a'));
    await waitPending(1);
    controller.dispose(); coordinator.dispose();
    release(); // the host gets the message although Design is gone
    await old;
    await settle();
    expect(fake.sends).toHaveLength(1);
    useStack({ boundarySecret: newSecret });
  }

  it('reload with the SAME secret: a retry of the same request id is still refused for confirmation (the plugin cannot know the secret is stable), nothing more is sent', async () => {
    useStack({ boundarySecret: 'S1' });
    await crashedAfterDelivery('S1');
    expect(await send([1], rid('a'))).toMatchObject({ status: 'rejected', reason: 'conflict' });
    expect(fake.sends).toHaveLength(1);
  });

  it('after the reload the comment is open, flagged maybeSent and the notice says so', async () => {
    useStack({ boundarySecret: 'S1' });
    await crashedAfterDelivery('S2');
    expect(await byId(1)).toMatchObject({ status: 'open', send: { maybeSent: true, lastOutcome: 'unknown' } });
    expect((await list()).notice).toMatch(/restarted/);
  });

  it('BUG: the same request id retried after a reload (new random secret) sends the message a second time', async () => {
    useStack({ boundarySecret: 'S1' });
    await crashedAfterDelivery('S2');
    await send([1], rid('a'));
    expect(fake.sends, 'a retry of a request whose comments are open+maybeSent+same lastBatchRequestId must not double-send').toHaveLength(1);
  });

  it('a NEW request id after the reload sends again (the user chose to, after the maybe-sent warning) and clears maybeSent', async () => {
    useStack({ boundarySecret: 'S1' });
    await crashedAfterDelivery('S2');
    expect(ok<any>(await send([1], rid('b'))).outcome).toBe('sent');
    expect(await byId(1)).toMatchObject({ status: 'sent', send: { maybeSent: false } });
    expect((await list()).notice ?? '').not.toMatch(/restarted/);
  });

  it('crash while QUEUED: reload recovers to open+maybeSent, the dead slot does not block, and one new send goes out', async () => {
    await pins(2);
    running(true);
    ok(await send([1, 2], rid('a')));
    controller.dispose(); coordinator.dispose();
    useStack({ boundarySecret: 'S2' });
    expect(await byId(1)).toMatchObject({ status: 'open', send: { maybeSent: true } });
    expect(await byId(2)).toMatchObject({ status: 'open', send: { maybeSent: true } });
    running(false);
    expect(ok<any>(await send([1, 2], rid('b'))).outcome).toBe('sent');
    expect(fake.sends).toHaveLength(1);
  });
});

// =============================================================================================
// Fault injection: store results the provider does not check
// =============================================================================================

describe('store write failures during the send flow', () => {
  const failing = (event: string) => (items: readonly any[]) => (items[0]?.event === event ? Promise.resolve({ status: 'rejected', reason: 'failed', message: 'disk full' }) : undefined);

  it('a write-ahead that throws sends nothing, leaves every comment open, and the same request id works once the disk is back', async () => {
    controller.dispose(); coordinator.dispose();
    let broken = true;
    useStack({ hooks: { transition: items => (broken && items[0]?.event === 'batch-issued' ? Promise.reject(new Error('EIO')) : undefined) } });
    await pins(2);
    expect(await send([1, 2], rid('a'))).toMatchObject({ status: 'rejected' });
    expect(fake.sends).toHaveLength(0);
    for (const n of [1, 2]) expect(await byId(n)).toMatchObject({ status: 'open' });
    broken = false;
    expect(ok<any>(await send([1, 2], rid('a'))).outcome).toBe('sent');
    expect(fake.sends).toHaveLength(1);
  });

  it('a write-ahead that is REJECTED (not thrown) sends nothing', async () => {
    controller.dispose(); coordinator.dispose();
    useStack({ hooks: { transition: failing('batch-issued') } });
    await pins(1);
    const result = await send([1], rid('a'));
    expect(fake.sends).toHaveLength(0);
    expect(result.status === 'rejected' || (result.status === 'ok' && (result.value as any).outcome === 'none')).toBe(true);
    expect(await byId(1)).toMatchObject({ status: 'open' });
  });

  it('BUG: the delivered write is rejected after the message went out: the comment must not stay pending forever while the report says sent', async () => {
    controller.dispose(); coordinator.dispose();
    useStack({ hooks: { transition: failing('delivered') } });
    await pins(2);
    const result = await send([1, 2], rid('a'));
    expect(fake.sends).toHaveLength(1);
    const reported = result.status === 'ok' ? (result.value as any).outcome : result.status;
    const states = [(await byId(1)).status, (await byId(2)).status];
    expect(states.includes('pending'), `report said ${reported} but comments are ${states}`).toBe(false);
  });

  it('BUG: send fails and the send-failed write is rejected: the comment must not stay pending (it cannot be re-sent while pending)', async () => {
    controller.dispose(); coordinator.dispose();
    useStack({ hooks: { transition: failing('send-failed') } });
    await pins(1);
    fake.sendErrors.push(new FakeApiError('INVALID_ARGUMENT'));
    const result = await send([1], rid('a'));
    expect(result).toMatchObject({ status: 'rejected' });
    expect((await byId(1)).status, 'send failed but the comment is stuck').not.toBe('pending');
  });
});

describe('unqueue is not atomic (members are released one by one)', () => {
  it('observation: releasing N queued members costs N file writes, never one', async () => {
    await pins(4);
    running(true);
    ok(await send([1, 2, 3, 4]));
    const before = await rev();
    ok(await unqueue(2));
    expect(await rev() - before).toBe(4);
  });

  it('BUG: one member update fails during cancel: the cancelled batch must not leave that member pending (and later flagged maybeSent on restart although nothing was sent)', async () => {
    controller.dispose(); coordinator.dispose();
    useStack({ hooks: { update: input => (input.id === cmtId(2) && input.change?.action === 'unqueue' ? Promise.resolve({ status: 'rejected', reason: 'failed', message: 'disk full' }) : undefined) } });
    await pins(3);
    running(true);
    ok(await send([1, 2, 3]));
    await unqueue(1);
    await settle();
    expect(fake.sends).toHaveLength(0);
    const states = await Promise.all([1, 2, 3].map(async n => (await byId(n)).status));
    expect(states, 'cancelled batch left a member behind').toEqual(['open', 'open', 'open']);
  });

  it('a deferred result that arrives between the member updates of a cancel changes nothing', async () => {
    await pins(4);
    running(true);
    ok(await send([1, 2, 3, 4], rid('a')));
    const cancelling = unqueue(1);
    // Land a bogus "sent" and a bogus "rejected" for the same request while the members are being released.
    await Promise.resolve();
    await controller.handleDeferredResult({ selectionId: rid('a'), artifactKey: root, outcome: { status: 'sent' } });
    await controller.handleDeferredResult({ selectionId: rid('a'), artifactKey: root, outcome: { status: 'rejected', reason: 'failed', message: 'x' } });
    await cancelling;
    await settle();
    const states = await Promise.all([1, 2, 3, 4].map(async n => (await byId(n)).status));
    expect(new Set(states).size, `mixed states ${states}`).toBe(1);
    expect(fake.sends).toHaveLength(0);
  });

  it('a send that starts for the members already released while the cancel is still releasing the rest leaves a consistent result', async () => {
    await pins(4);
    running(true);
    ok(await send([1, 2, 3, 4], rid('a')));
    running(false);
    const cancelling = unqueue(1);
    const sendNow = send([1, 2, 3, 4], rid('b'));
    const [cancelResult, sendResult] = await Promise.all([cancelling, sendNow]);
    await settle(); await finishRun(); await settle();
    const statuses = await Promise.all([1, 2, 3, 4].map(async n => (await byId(n)).status));
    expect(statuses.includes('pending'), `${JSON.stringify([cancelResult.status, sendResult.status])} -> ${statuses}`).toBe(false);
    // A comment is sent exactly when a message that contains it reached the host.
    for (let n = 1; n <= 4; n++) {
      const inThread = promptsOf().some(prompt => prompt.includes(`Comment ${n}\n`));
      expect(statuses[n - 1] === 'sent', `comment ${n}`).toBe(inThread);
    }
  });

  it('pending comments cannot be edited, resolved, dismissed or removed behind the queue', async () => {
    await pins(2);
    running(true);
    ok(await send([1, 2]));
    const c = await byId(1);
    for (const change of [{ text: 'NEW TEXT' }, { action: 'resolve' }, { action: 'dismiss' }, { action: 'reopen' }]) {
      expect(await provider.update(target, { id: cmtId(1), expectedVersion: c.version, change } as never, ctx()), JSON.stringify(change)).toMatchObject({ status: 'rejected', reason: 'invalid-transition' });
    }
    expect(await provider.remove(target, { id: cmtId(1), expectedVersion: c.version } as never, ctx())).toMatchObject({ status: 'rejected', reason: 'invalid-transition' });
    expect(await byId(1)).toMatchObject({ status: 'pending', text: 'Comment 1', version: c.version });
  });

  it('randomized unqueue versus drain: every outcome is all-sent with one message, or all-open with none (30 interleavings)', async () => {
    for (let k = 1; k <= 30; k++) {
      await pin(k);
      running(true);
      ok(await send([k], rid2(k)));
      running(false);
      const before = fake.sends.length;
      const delay = async () => { for (let i = 0; i < (k % 7); i++) await (k % 2 ? Promise.resolve() : new Promise(resolve => setImmediate(resolve))); };
      const drainIt = (async () => { fake.emit({ kind: 'run.completed', threadId: 't1', runId: 'x' }); await clock.advance(300); })();
      await delay();
      const cancelIt = unqueue(k);
      const [, cancelled] = await Promise.all([drainIt, cancelIt]);
      await settle();
      const state = await byId(k);
      const sentNow = fake.sends.length - before;
      expect(['sent', 'open'], `k=${k}`).toContain(state.status);
      if (state.status === 'sent') expect(sentNow, `k=${k}`).toBe(1);
      else expect(sentNow, `k=${k} cancel=${cancelled.status}`).toBe(0);
      if (cancelled.status === 'ok') expect(state.status, `k=${k}`).toBe('open');
      expect(coordinator.pendingCount, `k=${k}`).toBe(0);
    }
  });
});

describe('a retried request id after an explicit unqueue', () => {
  it('BUG: must not send the cancelled batch again', async () => {
    await pins(2);
    running(true);
    ok(await send([1, 2], rid('a')));
    ok(await unqueue(1));
    running(false);
    await send([1, 2], rid('a')); // a late client retry of the original request
    expect(fake.sends, 'the user cancelled this send').toHaveLength(0);
  });
});

// =============================================================================================
// Stale prompt text: no expectedVersion on the write-ahead, plan keyed by ids only
// =============================================================================================

describe('prompt text versus the comment text that gets marked sent', () => {
  it('BUG: an edit that lands between the snapshot and the write-ahead must not leave "sent" status on text that never went out', async () => {
    controller.dispose(); coordinator.dispose();
    let edited = false;
    let armed = false;
    useStack({
      hooks: {
        afterSnapshot: async (real, snapshot) => {
          if (!armed || edited || snapshot.comments.length === 0) return;
          edited = true;
          const c = snapshot.comments[0];
          ok(await real.update({ id: c.id, expectedVersion: c.version, change: { text: 'EDITED-AFTER-SNAPSHOT' } }));
        },
      },
    });
    await pins(1);
    armed = true;
    const result = await send([1], rid('a'));
    armed = false;
    const comment = await byId(1);
    const sentPrompt = promptsOf()[0] ?? '';
    if (comment.status === 'sent') expect(sentPrompt, `comment text is "${comment.text}" but the thread got ${sentPrompt.includes('EDITED') ? 'edited' : 'old'} text (${result.status})`).toContain(comment.text);
    else expect(['open'], 'not sent, so it must be open').toContain(comment.status);
  });

  it('BUG: a retry of the same request id after the user edited the text sends the NEW text, not the pinned old prompt', async () => {
    await pins(1);
    fake.sendErrors.push(new FakeApiError('INVALID_ARGUMENT'));
    expect(await send([1], rid('a'))).toMatchObject({ status: 'rejected' });
    const c = await byId(1);
    ok(await provider.update(target, { id: cmtId(1), expectedVersion: c.version, change: { text: 'REWRITTEN-BY-USER' } }, ctx()));
    ok(await send([1], rid('a')));
    expect(promptsOf().at(-1) ?? '').toContain('REWRITTEN-BY-USER');
  });

  it('a retry with a different set of comments under the same request id is a conflict and sends nothing', async () => {
    await pins(2);
    ok(await send([1], rid('a')));
    expect(await send([1, 2], rid('a'))).toMatchObject({ status: 'rejected', reason: 'conflict' });
    expect(fake.sends).toHaveLength(1);
    expect(await byId(2)).toMatchObject({ status: 'open' });
  });
});

// =============================================================================================
// Deferred results keyed by selectionId only
// =============================================================================================

describe('deferred results are routed by request id only', () => {
  it('BUG: the same request id queued on two artifacts: a result for artifact B must not settle artifact A', async () => {
    const root2 = await makeArtifact('t2');
    fake.addThread('t2', { artifacts: [{ providerId: 'agent-threads.design', kind: 'design-static', schemaVersion: 2, id: 'design-t2', title: 'Other', data: {}, storageRoot: root2 }] });
    const target2: ArtifactFeedbackTarget = { root: root2, artifactId: 'design-t2', title: 'Other', runtime: 'static', vaultRead: false };
    await pin(1);
    ok<any>(await provider.save(target2, { request: request(2, {}, {}, root2, 'design-t2') }, ctx()));
    running(true, 't1'); running(true, 't2');
    ok(await send([1], rid('c')));
    ok(await send([2], rid('c'), {}, target2));
    await finishRun('t2');
    const a = (await list()).comments.find((c: any) => c.id === cmtId(1));
    const b = ok<any>(await provider.list(target2, ctx())).comments.find((c: any) => c.id === cmtId(2));
    expect(b.status).toBe('sent');
    expect(a.status, 'artifact A is still waiting for its own thread').toBe('pending');
  });
});

// =============================================================================================
// Ledger, idempotency, boundaries
// =============================================================================================

describe('ledger and idempotency boundaries', () => {
  it('five concurrent identical requests (ids in different order) share one attempt: one threads.send, identical reports', async () => {
    await pins(3);
    const results = await Promise.all([
      send([1, 2, 3]), send([3, 2, 1]), send([2, 1, 3]), send([1, 2, 3], rid('a'), { anchorStates: { [cmtId(1)]: 'detached' } }), send([3, 1, 2]),
    ]);
    expect(fake.sends).toHaveLength(1);
    const first = ok<any>(results[0]);
    for (const r of results) expect(ok<any>(r)).toEqual(first);
  });

  it('the ledger forgets at more than 10 minutes, not at exactly 10 minutes', async () => {
    await pins(1);
    ok(await send([1], rid('a')));
    nowMs = START_MS + 10 * 60 * 1000;
    expect(ok<any>(await send([1], rid('a'))).outcome, 'at exactly 10 minutes the request is still remembered').toBe('sent');
    nowMs = START_MS + 10 * 60 * 1000 + 1;
    expect(ok<any>(await send([1], rid('a'))).outcome, 'after 10 minutes the request is forgotten and the comment is already sent').toBe('none');
    expect(fake.sends).toHaveLength(1);
  });

  it('the ledger keeps the newest 64 requests: with 71 requests the 7th is remembered and the 6th is not (observed through attempts, because the fake host also dedupes by prompt)', async () => {
    await pins(1);
    ok(await send([1], rid2(0)));
    for (let i = 1; i <= 70; i++) ok(await send([1], rid2(i), { resend: true }));
    const attempts = async () => (await byId(1)).send.attempts;
    const base71 = await attempts();
    expect(base71).toBe(71);
    ok(await send([1], rid2(7), { resend: true }));
    expect(await attempts(), 'request 7 must be deduped by the ledger').toBe(71);
    ok(await send([1], rid2(6), { resend: true }));
    expect(await attempts(), 'request 6 was evicted so the resend runs again').toBe(72);
  }, 60_000);

  it('a failed attempt keeps its pinned plan: the retry reuses the prompt byte for byte and the host sees one message', async () => {
    await pins(2);
    fake.sendErrors.push(new FakeApiError('RUN_FAILED'));
    expect(await send([1, 2], rid('a'))).toMatchObject({ status: 'rejected' });
    ok(await send([1, 2], rid('a')));
    expect(fake.sends).toHaveLength(1);
  });
});

describe('write-ahead is one store write for the whole batch', () => {
  it('immediate send of 5 comments costs 2 writes (write-ahead + delivered), not 10', async () => {
    await pins(5);
    const before = await rev();
    ok(await send([1, 2, 3, 4, 5]));
    expect(await rev() - before).toBe(2);
  });

  it('queued send costs 1 write, the drain 1 more; a second batch while the slot is held costs 0 and leaves the file byte-identical', async () => {
    await pins(4);
    running(true);
    const r0 = await rev();
    ok(await send([1, 2], rid('a')));
    expect(await rev() - r0).toBe(1);
    const bytes = await fs.readFile(commentsFile(), 'utf8');
    expect(await send([3, 4], rid('b'))).toMatchObject({ status: 'rejected', reason: 'busy' });
    expect(await fs.readFile(commentsFile(), 'utf8')).toBe(bytes);
    await finishRun();
    expect(await rev() - r0).toBe(2);
  });

  it('a v1 single Send holding the slot makes a batch busy without any disk churn, and the reverse', async () => {
    await pins(2);
    running(true);
    expect(await coordinator.submit({ selectionId: selId(99), artifactKey: root, threadId: 't1', prompt: 'v1 prompt' })).toEqual({ status: 'queued' });
    const bytes = await fs.readFile(commentsFile(), 'utf8');
    expect(await send([1], rid('a'))).toMatchObject({ status: 'rejected', reason: 'busy' });
    expect(await fs.readFile(commentsFile(), 'utf8')).toBe(bytes);
    // reverse: after the v1 message drains, a queued batch makes a v1 submit busy
    await finishRun();
    running(true);
    ok(await send([1], rid('b')));
    expect(await coordinator.submit({ selectionId: selId(98), artifactKey: root, threadId: 't1', prompt: 'v1 again' })).toMatchObject({ status: 'rejected', reason: 'busy' });
  });

  it('two disjoint batches at the same instant: nothing is left pending, no comment goes out twice, and a comment is sent exactly when a message holds it', async () => {
    await pins(4);
    const [a, b] = await Promise.all([send([1, 2], rid('a')), send([3, 4], rid('b'))]);
    await settle();
    expect(fake.sends.length).toBeGreaterThanOrEqual(1);
    expect(fake.sends.length).toBeLessThanOrEqual(2);
    for (let n = 1; n <= 4; n++) {
      const inMessages = promptsOf().filter(prompt => prompt.includes(`Comment ${n}\n`)).length;
      const status = (await byId(n)).status;
      expect(inMessages, `comment ${n} in ${inMessages} messages`).toBeLessThanOrEqual(1);
      expect(status === 'sent', `comment ${n} is ${status} (${a.status}/${b.status})`).toBe(inMessages === 1);
      expect(status).not.toBe('pending');
    }
    if (fake.sends.length === 1) expect([a.status, b.status].sort()).toEqual(['ok', 'rejected']);
  });

  it('two overlapping batches at the same instant: no comment goes out twice, nothing is left pending', async () => {
    await pins(3);
    await Promise.all([send([1, 2], rid('a')), send([2, 3], rid('b'))]);
    await settle();
    for (let n = 1; n <= 3; n++) {
      const inMessages = promptsOf().filter(prompt => prompt.includes(`Comment ${n}\n`)).length;
      const status = (await byId(n)).status;
      expect(inMessages, `comment ${n}`).toBeLessThanOrEqual(1);
      expect(status === 'sent', `comment ${n} is ${status}`).toBe(inMessages === 1);
    }
  });
});

// =============================================================================================
// Reviewer: unusual states and the report
// =============================================================================================

describe('queued results and the retry window', () => {
  it('BUG: a queued request that fails later (thread removed) and is retried while the failure is still being recorded answers with the stale queued report', async () => {
    controller.dispose(); coordinator.dispose();
    useStack({ hooks: { transition: items => (items[0]?.event === 'send-failed' ? new Promise(resolve => setTimeout(resolve, 150)).then(() => undefined as never) : undefined) } });
    await pins(1);
    running(true);
    ok(await send([1], rid('a')));
    fake.emit({ kind: 'thread.removed', threadId: 't1' });
    const retry = await send([1], rid('a'));
    const outcome = retry.status === 'ok' ? (retry.value as any).outcome : retry.status;
    expect(outcome, 'a failed queued send was reported as queued again').not.toBe('queued');
  });

  it('a request that already settled as sent answers sent on retry, never queued', async () => {
    await pins(1);
    running(true);
    ok(await send([1], rid('a')));
    await finishRun();
    expect(ok<any>(await send([1], rid('a'))).outcome).toBe('sent');
  });

  it('a late rejected result for a request that already settled as sent changes neither the comments nor the remembered report', async () => {
    await pins(1);
    ok(await send([1], rid('a')));
    const bytes = await fs.readFile(commentsFile(), 'utf8');
    await controller.handleDeferredResult({ selectionId: rid('a'), artifactKey: root, outcome: { status: 'rejected', reason: 'failed', message: 'late' } });
    await controller.handleDeferredResult({ selectionId: rid('a'), artifactKey: root, outcome: { status: 'cancelled' } });
    expect(await fs.readFile(commentsFile(), 'utf8')).toBe(bytes);
    expect(ok<any>(await send([1], rid('a'))).outcome, 'the retry must still be answered from the ledger').toBe('sent');
    expect(fake.sends).toHaveLength(1);
  });

  it('malformed deferred results are ignored without throwing', async () => {
    await pins(1);
    running(true);
    ok(await send([1], rid('a')));
    for (const junk of [null, undefined, {}, { selectionId: 5 }, { selectionId: rid('a') }, { selectionId: rid('a'), outcome: null }, 'x', 7]) {
      await controller.handleDeferredResult(junk as never).catch(() => undefined);
    }
    expect(await byId(1)).toMatchObject({ status: 'pending' });
  });
});

describe('never "sent" unless threads.send succeeded', () => {
  const scenarios: { name: string; arrange: () => void; expectStatus: 'open' | 'pending' }[] = [
    { name: 'INVALID_ARGUMENT', arrange: () => fake.sendErrors.push(new FakeApiError('INVALID_ARGUMENT')), expectStatus: 'open' },
    { name: 'RUN_FAILED', arrange: () => fake.sendErrors.push(new FakeApiError('RUN_FAILED')), expectStatus: 'open' },
    { name: 'PLUGIN_UNAVAILABLE', arrange: () => fake.sendErrors.push(new FakeApiError('PLUGIN_UNAVAILABLE')), expectStatus: 'open' },
    { name: 'THREAD_NOT_FOUND', arrange: () => fake.sendErrors.push(new FakeApiError('THREAD_NOT_FOUND')), expectStatus: 'open' },
    { name: 'unknown error', arrange: () => fake.sendErrors.push(new Error('boom')), expectStatus: 'open' },
    { name: 'wait() reports the run failed', arrange: () => { fake.state.waitResult = { status: 'failed', error: { code: 'RUN_FAILED', message: 'x' } }; }, expectStatus: 'open' },
    { name: 'send throws synchronously', arrange: () => { (fake.api.threads as any).send = () => { throw new Error('sync boom'); }; }, expectStatus: 'open' },
  ];
  for (const scenario of scenarios) {
    it(`${scenario.name}: the comment is open with lastOutcome failed and the caller sees a failure`, async () => {
      await pins(2);
      scenario.arrange();
      const result = await send([1, 2], rid('a'));
      expect(result.status, scenario.name).toBe('rejected');
      for (const n of [1, 2]) expect(await byId(n), scenario.name).toMatchObject({ status: scenario.expectStatus, send: { lastOutcome: 'failed' } });
    });
  }

  it('TTL expiry and thread.removed both return queued members to open/failed and never to sent', async () => {
    await pins(3);
    running(true);
    ok(await send([1], rid('a')));
    await clock.advance(PENDING_TTL_MS + 1);
    await settle();
    expect(await byId(1)).toMatchObject({ status: 'open', send: { lastOutcome: 'failed' } });
    ok(await send([2], rid('b')));
    fake.emit({ kind: 'thread.removed', threadId: 't1' });
    await settle();
    expect(await byId(2)).toMatchObject({ status: 'open', send: { lastOutcome: 'failed' } });
    expect(fake.sends).toHaveLength(0);
  });
});

describe('abort and dispose races around sendBatch', () => {
  it('abort fired right after the call: either nothing happened or everything completed consistently', async () => {
    for (let k = 1; k <= 12; k++) {
      await pin(k);
      const ac = new AbortController();
      const before = fake.sends.length;
      const call = provider.sendBatch(target, { requestId: rid2(k), ids: [cmtId(k)], resend: false, anchorStates: {} } as never, { signal: ac.signal });
      for (let i = 0; i < k % 6; i++) await new Promise(resolve => setImmediate(resolve));
      ac.abort();
      const result = await call;
      await settle();
      const state = await byId(k);
      const sent = fake.sends.length - before;
      expect(state.status, `k=${k}`).not.toBe('pending');
      if (state.status === 'sent') expect(sent, `k=${k}`).toBe(1);
      else { expect(sent, `k=${k}`).toBe(0); expect(result.status, `k=${k}`).toBe('rejected'); }
    }
  });

  it('abort after the write-ahead does not abandon an in-flight send: it completes once and is recorded', async () => {
    await pins(1);
    const release = gateSends();
    const ac = new AbortController();
    const call = provider.sendBatch(target, { requestId: rid('a'), ids: [cmtId(1)], resend: false, anchorStates: {} } as never, { signal: ac.signal });
    await waitPending(1);
    ac.abort();
    release();
    expect(ok<any>(await call).outcome).toBe('sent');
    expect(fake.sends).toHaveLength(1);
    expect(await byId(1)).toMatchObject({ status: 'sent' });
  });

  it('dispose at 25 different moments: never sent without a message, never stuck pending after the next start', async () => {
    await pins(25);
    for (let k = 1; k <= 25; k++) {
      const before = fake.sends.length;
      const call = send([k], rid2(k));
      for (let i = 0; i < k; i++) await new Promise(resolve => setImmediate(resolve));
      controller.dispose(); coordinator.dispose();
      await call;
      await settle();
      useStack({ boundarySecret: `s${k}` });
      const state = await byId(k);
      const sent = fake.sends.length - before;
      expect(state.status, `k=${k}`).not.toBe('pending');
      if (state.status === 'sent') expect(sent, `k=${k}`).toBe(1);
      if (state.status === 'open' && sent > 0) expect(state.send.maybeSent || state.send.lastOutcome === 'failed', `k=${k}: delivered but reads as a plain open comment`).toBe(true);
    }
  }, 60_000);

  it('dispose before intake finishes writes nothing and sends nothing', async () => {
    await pins(1);
    const bytes = await fs.readFile(commentsFile(), 'utf8');
    const call = send([1]);
    controller.dispose();
    expect(await call).toMatchObject({ status: 'rejected', reason: 'unavailable' });
    expect(fake.sends).toHaveLength(0);
    expect(await fs.readFile(commentsFile(), 'utf8')).toBe(bytes);
  });
});

describe('resend', () => {
  it('resend:true re-sends sent comments only: open ones go as normal, resolved, dismissed and pending ones are skipped', async () => {
    await pins(5);
    ok(await send([1, 2], rid('a')));
    const change = async (n: number, action: string) => { const c = await byId(n); ok(await provider.update(target, { id: cmtId(n), expectedVersion: c.version, change: { action } } as never, ctx())); };
    await change(2, 'resolve');
    await change(3, 'dismiss');
    running(true);
    ok(await send([4], rid('b')));
    expect(ok<any>(await send([4], rid('c'), { resend: true }))).toMatchObject({ outcome: 'none', items: [{ id: cmtId(4), result: 'skipped', reason: 'not-sendable' }] });
    await finishRun();
    const report = ok<any>(await send([1, 2, 3, 4, 5], rid('d'), { resend: true }));
    expect(report.items.map((i: any) => [i.id, i.result, i.reason ?? null])).toEqual([
      [cmtId(1), 'sent', null], [cmtId(2), 'skipped', 'not-sendable'], [cmtId(3), 'skipped', 'not-sendable'], [cmtId(4), 'sent', null], [cmtId(5), 'sent', null],
    ]);
  });

  it('a resend that goes out increments attempts, refreshes sentAt, and a failed resend leaves the comment open (not sent)', async () => {
    await pins(1);
    ok(await send([1], rid('a')));
    nowMs += 1000;
    const first = await byId(1);
    fake.sendErrors.push(new FakeApiError('RUN_FAILED'));
    expect(await send([1], rid('b'), { resend: true })).toMatchObject({ status: 'rejected' });
    expect(await byId(1)).toMatchObject({ status: 'open', send: { attempts: first.send.attempts + 1, lastOutcome: 'failed' } });
  });

  it('without resend a sent comment is skipped as not-sendable and nothing is written or sent', async () => {
    await pins(1);
    ok(await send([1], rid('a')));
    const bytes = await fs.readFile(commentsFile(), 'utf8');
    expect(ok<any>(await send([1], rid('b')))).toMatchObject({ outcome: 'none', items: [{ id: cmtId(1), result: 'skipped', reason: 'not-sendable' }] });
    expect(fake.sends).toHaveLength(1);
    expect(await fs.readFile(commentsFile(), 'utf8')).toBe(bytes);
  });
});

describe('input limits and hostile input', () => {
  it('exactly 20 distinct comments are sent in one message, 21 are refused as limit with nothing written', async () => {
    for (let n = 1; n <= 21; n++) await pin(n);
    const bytes = await fs.readFile(commentsFile(), 'utf8');
    expect(await send(Array.from({ length: 21 }, (_, i) => i + 1))).toMatchObject({ status: 'rejected', reason: 'limit' });
    expect(await fs.readFile(commentsFile(), 'utf8')).toBe(bytes);
    const report = ok<any>(await send(Array.from({ length: 20 }, (_, i) => i + 1), rid('b')));
    expect(report.items).toHaveLength(20);
    expect(report.outcome === 'sent' || report.outcome === 'partial').toBe(true);
    expect(fake.sends).toHaveLength(1);
    expect((fake.sends[0].prompt.match(/^=== COMMENT \d+ of /gm) ?? []).length + (report.items.filter((i: any) => i.result === 'deferred').length)).toBe(20);
  });

  it('duplicates, bad ids, non-arrays and wrong types are invalid and cost nothing', async () => {
    await pins(1);
    const bytes = await fs.readFile(commentsFile(), 'utf8');
    for (const bad of [
      { ids: [cmtId(1), cmtId(1)] }, { ids: [] }, { ids: 'cmt' }, { ids: [cmtId(1), 'cmt_zz'] }, { ids: [{}] }, { ids: [cmtId(1)], resend: 'yes' },
      { ids: [cmtId(1)], requestId: 'req_short' }, { ids: [cmtId(1)], requestId: 5 }, { ids: [cmtId(1)], requestId: `req_${'G'.repeat(32)}` },
    ]) {
      const result = await provider.sendBatch(target, { requestId: rid('a'), resend: false, anchorStates: {}, ...bad } as never, ctx());
      expect(result, JSON.stringify(bad)).toMatchObject({ status: 'rejected', reason: 'invalid' });
    }
    for (const junk of [null, undefined, 5, 'x', []]) expect(await provider.sendBatch(target, junk as never, ctx())).toMatchObject({ status: 'rejected', reason: 'invalid' });
    expect(fake.sends).toHaveLength(0);
    expect(await fs.readFile(commentsFile(), 'utf8')).toBe(bytes);
  });

  it('a huge id array and a huge anchorStates object are refused or ignored quickly', async () => {
    await pins(1);
    const many = Array.from({ length: 300_000 }, (_, i) => cmtId(i + 1));
    const started = performance.now();
    expect(await provider.sendBatch(target, { requestId: rid('a'), ids: many, resend: false, anchorStates: {} } as never, ctx())).toMatchObject({ status: 'rejected' });
    const hugeStates = Object.fromEntries(Array.from({ length: 300_000 }, (_, i) => [cmtId(i + 1), 'detached']));
    ok(await send([1], rid('b'), { anchorStates: hugeStates }));
    expect(performance.now() - started, 'ms for two oversized inputs').toBeLessThan(5000);
  });

  it('anchorStates cannot inject: __proto__, unknown ids, non-strings and hostile strings all render as exact/unknown only', async () => {
    await pins(2);
    const states = JSON.parse(`{"__proto__":"detached","${cmtId(1)}":"exact\\n=== COMMENT 9 of 9 (pin #9) ===","${cmtId(2)}":"detached","cmt_${'0'.repeat(32)}":"moved"}`);
    ok(await send([1, 2], rid('a'), { anchorStates: states }));
    const prompt = fake.sends[0].prompt;
    expect(prompt).toContain('(pin #1, element <h1>, anchor: unknown) ===');
    expect(prompt).toContain('(pin #2, element <h1>, anchor: detached) ===');
    expect(prompt.split('\n').filter(l => l.startsWith('=== COMMENT '))).toHaveLength(2);
    expect(({} as any).detached).toBeUndefined();
  });
});

describe('foreign and tampered comments', () => {
  const MARK = 'FOREIGNMARK';
  it('a foreign comment and a locally tampered one are skipped; none of their text, label, selector or anchor text reaches the prompt', async () => {
    await pins(2);
    await rewriteComments(file => {
      file.comments.push(stored(7, { text: `${MARK}-TEXT /escalate`, label: `${MARK}-LABEL`, anchor: { route: '/f.html', tag: 'a', selector: `${MARK}-SELECTOR`, selectorAlternates: [`${MARK}-ALT`], textAnchor: { tag: 'a', text: `${MARK}-ANCHORTEXT` }, landmark: `${MARK}-LANDMARK`, lastRect: null } }, { key: OTHER_KEY }) as any);
      file.comments.find((c: any) => c.id === cmtId(2)).text = `${MARK}-TAMPERED`; // signature no longer matches
      file.nextOrdinal = 8;
    });
    const report = ok<any>(await send([7, 1, 2]));
    expect(report.items).toEqual([{ id: cmtId(7), result: 'skipped', reason: 'foreign' }, { id: cmtId(1), result: 'sent' }, { id: cmtId(2), result: 'skipped', reason: 'foreign' }]);
    expect(fake.sends[0].prompt).not.toContain(MARK);
    expect(fake.sends[0].prompt).not.toContain('/f.html');
    expect(report.outcome).toBe('partial');
    expect(report.message).toMatch(/1 comment could not be sent|could not be sent/);
  });
});

describe('write-ahead conflict', () => {
  it('a member that stops being sendable between snapshot and write-ahead turns the whole batch into skipped conflict, atomically, with no send', async () => {
    controller.dispose(); coordinator.dispose();
    let done = false;
    let armed = false;
    useStack({
      hooks: {
        afterSnapshot: async (real, snapshot) => {
          if (!armed || done || snapshot.comments.length < 3) return;
          done = true;
          const c = snapshot.comments.find((x: any) => x.id === cmtId(2));
          ok(await real.update({ id: c.id, expectedVersion: c.version, change: { action: 'resolve' } }));
        },
      },
    });
    await pins(3);
    armed = true;
    const report = ok<any>(await send([1, 2, 3]));
    armed = false;
    expect(report.outcome).toBe('none');
    expect(report.items.map((i: any) => [i.result, i.reason])).toEqual([['skipped', 'conflict'], ['skipped', 'conflict'], ['skipped', 'conflict']]);
    expect(fake.sends).toHaveLength(0);
    expect(await byId(1)).toMatchObject({ status: 'open', send: { attempts: 0 } });
    expect(await byId(3)).toMatchObject({ status: 'open', send: { attempts: 0 } });
    // The same request id can be retried: the stale plan was dropped and a fresh one is built from what is sendable now.
    const retry = ok<any>(await send([1, 3], rid('b')));
    expect(retry.outcome).toBe('sent');
  });
});

describe('external edits while a send is queued', () => {
  it('BUG: a member changed behind the queue (resolved by hand) must not strand the other members as pending when the batch is delivered', async () => {
    await pins(3);
    running(true);
    ok(await send([1, 2, 3], rid('a')));
    await rewriteComments(file => {
      const c = file.comments.find((x: any) => x.id === cmtId(2));
      c.status = 'resolved';
    });
    await finishRun();
    const states = await Promise.all([1, 3].map(async n => (await byId(n)).status));
    expect(fake.sends).toHaveLength(1);
    expect(states, 'delivered batch left members pending').toEqual(['sent', 'sent']);
  });
});

describe('ordering and shared level through sendBatch', () => {
  it('ordinal order whatever the id order, and the header carries only numbers', async () => {
    await pins(4);
    ok(await send([4, 2, 3, 1]));
    const prompt = fake.sends[0].prompt;
    expect(prompt.split('\n')[0]).toBe('Design review: 4 comments on this artifact (pins #1, #2, #3, #4; revision 7).');
    for (let n = 1; n < 4; n++) expect(prompt.indexOf(`Comment ${n}\n`)).toBeLessThan(prompt.indexOf(`Comment ${n + 1}\n`));
  });

  it('a prompt cap that fits only some comments sends the ordinal prefix, reports the rest deferred, and the next request sends them', async () => {
    controller.dispose(); coordinator.dispose();
    useStack({ maxPromptLength: 6000 });
    for (let n = 1; n <= 6; n++) await pin(n, {}, { outerHTML: { html: `<p>${'x'.repeat(1400)}</p>`, truncated: false } });
    const report = ok<any>(await send([6, 5, 4, 3, 2, 1], rid('a')));
    const results = report.items.map((i: any) => i.result);
    expect(results.filter((r: string) => r === 'sent').length).toBeGreaterThan(0);
    expect(results.filter((r: string) => r === 'deferred').length).toBeGreaterThan(0);
    const firstDeferred = results.indexOf('deferred');
    // report is in the caller's id order (6..1); sent ones are the LOWEST ordinals
    const sentOrdinals = report.items.filter((i: any) => i.result === 'sent').map((i: any) => Number.parseInt(i.id.slice(4), 16));
    const deferredOrdinals = report.items.filter((i: any) => i.result === 'deferred').map((i: any) => Number.parseInt(i.id.slice(4), 16));
    expect(Math.max(...sentOrdinals)).toBeLessThan(Math.min(...deferredOrdinals));
    expect(firstDeferred).toBeGreaterThanOrEqual(0);
    for (const n of deferredOrdinals) expect(await byId(n)).toMatchObject({ status: 'open', send: { attempts: 0 } });
    expect(fake.sends[0].prompt.length).toBeLessThanOrEqual(6000);
    expect(ok<any>(await send(deferredOrdinals, rid('b'))).items.every((i: any) => i.result === 'sent' || i.result === 'deferred')).toBe(true);
  });
});

describe('vault-read artifacts: nothing from the page text reaches a batch prompt', () => {
  const VAULT = 'VAULTMARK';
  const vaultManifest = { permissions: { network: 'none', clipboard: false, vault: 'read' } };
  const secretSelection = { textAnchor: { tag: 'h1', text: `${VAULT}-ANCHOR` }, landmark: `${VAULT}-LANDMARK`, a11y: { role: 'heading', name: `${VAULT}-NAME`, tabIndex: null }, outerHTML: { html: `<h1>${VAULT}-HTML</h1>`, truncated: false } };

  it('a vault-read pin (redacted at save) sends no screenshot line, no text and no vault marker, with the snapshot present or deleted', async () => {
    await fs.writeFile(path.join(root, 'artifact.json'), JSON.stringify({ ...buildDesignManifest('t1', 'Landing'), ...vaultManifest }));
    target = { ...target, vaultRead: true };
    const redacted = { ...secretSelection, redacted: true };
    ok<any>(await provider.save(target, { request: request(1, {}, redacted) }, ctx()));
    ok<any>(await provider.save(target, { request: request(2, {}, redacted) }, ctx()));
    await fs.rm(path.join(root, '.threads-design', 'selections', `${selId(2)}.json`), { force: true });
    ok(await send([1, 2], rid('a')));
    const prompt = fake.sends[0].prompt;
    expect(prompt).not.toContain(VAULT);
    expect(prompt).not.toContain('Screenshot (');
    expect(prompt).not.toMatch(/\.png/);
  });

  it('a redacted pin whose sidecar was swapped for an unredacted copy falls back to the stored (empty) anchor', async () => {
    await fs.writeFile(path.join(root, 'artifact.json'), JSON.stringify({ ...buildDesignManifest('t1', 'Landing'), ...vaultManifest }));
    target = { ...target, vaultRead: true };
    ok<any>(await provider.save(target, { request: request(1, {}, { ...secretSelection, redacted: true }) }, ctx()));
    const file = path.join(root, '.threads-design', 'selections', `${selId(1)}.json`);
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    parsed.selection = { ...parsed.selection, redacted: false, ...secretSelection };
    await fs.writeFile(file, JSON.stringify(parsed));
    ok(await send([1], rid('a')));
    expect(fake.sends[0].prompt).not.toContain(VAULT);
  });

  it('a pin saved BEFORE the artifact gained vault:read: the full selection snapshot (outerHTML) is not used, only the stored anchor', async () => {
    await pin(1, {}, { outerHTML: { html: '<h1>VAULTHTML-ONLY-IN-SNAPSHOT</h1>', truncated: false } });
    await fs.writeFile(path.join(root, 'artifact.json'), JSON.stringify({ ...buildDesignManifest('t1', 'Landing'), ...vaultManifest }));
    ok(await send([1], rid('a')));
    expect(fake.sends[0].prompt).not.toContain('VAULTHTML');
    expect(fake.sends[0].prompt).toContain('selection snapshot: unavailable');
  });

  it('BUG (advisory): a pin saved BEFORE the artifact gained vault:read still sends its stored anchor text, label and landmark', async () => {
    await pin(1, {}, secretSelection);
    await fs.writeFile(path.join(root, 'artifact.json'), JSON.stringify({ ...buildDesignManifest('t1', 'Landing'), ...vaultManifest }));
    ok(await send([1], rid('a')));
    expect(fake.sends[0].prompt, 'page text from before the vault grant reached the thread').not.toContain(VAULT);
  });
});

describe('timing probe: 20 comments against a large artifact', () => {
  it('sendBatch of 20 pins over 24 x 250 KB source files finishes in bounded time', async () => {
    for (let f = 0; f < 24; f++) await fs.writeFile(path.join(root, `page-${f}.html`), `<div>${'<button id="hero-title" class="title big">Build faster</button>'.repeat(4000)}</div>`);
    for (let n = 1; n <= 20; n++) await pin(n);
    const started = performance.now();
    ok(await send(Array.from({ length: 20 }, (_, i) => i + 1)));
    const elapsed = performance.now() - started;
    console.log(`P2B-QA timing: sendBatch 20 pins over large artifact -> ${elapsed.toFixed(0)} ms`);
    expect(elapsed).toBeLessThan(15_000);
  }, 60_000);
});

describe('mutation sentinels (kept so a revert of the behavior fails here too)', () => {
  it('the batch send marks sent only after the host accepted it, and only members of the prompt', async () => {
    await pins(3);
    fake.sendErrors.push(new FakeApiError('RUN_FAILED'));
    await send([1, 2, 3], rid('a'));
    for (const n of [1, 2, 3]) expect((await byId(n)).status).not.toBe('sent');
    ok(await send([1, 2, 3], rid('b')));
    for (const n of [1, 2, 3]) expect((await byId(n)).status).toBe('sent');
  });
});


// =============================================================================================
// Fix-pass re-verification (D1-D10 as fixed in ca43ca2)
// =============================================================================================

const rejectedWrite = { status: 'rejected', reason: 'failed', message: 'disk full' };
const heldCoordApi = (which: 'get' | 'permissions') => {
  const real = (fake.api.threads as any)[which].bind(fake.api.threads);
  const gate = { hold: false, release: () => undefined as void, promise: Promise.resolve() };
  gate.promise = new Promise<void>(resolve => { gate.release = resolve; });
  const coordApi = { ...fake.api, threads: { ...fake.api.threads, [which]: async (id: string) => { if (gate.hold) await gate.promise; return real(id); } } };
  return { coordApi, gate };
};

describe('fix pass: abandoned runs (timeout at every await of the coordinator)', () => {
  it('a hung threads.permissions that outlives the timeout: nothing is sent late, no slot, comment open/failed', async () => {
    const { coordApi, gate } = heldCoordApi('permissions');
    controller.dispose(); coordinator.dispose();
    useStack({ coordApi });
    await pins(2);
    gate.hold = true;
    const first = send([1], rid('a'));
    await waitPending(1);
    await clock.advance(ATTEMPT_TIMEOUT_MS + 10);
    expect(await first).toMatchObject({ status: 'rejected', reason: 'failed' });
    gate.hold = false; gate.release();
    await settle();
    expect(fake.sends).toHaveLength(0);
    expect(coordinator.pendingCount).toBe(0);
    expect(await byId(1)).toMatchObject({ status: 'open', send: { lastOutcome: 'failed' } });
    expect(ok<any>(await send([2], rid('b'))).outcome, 'the artifact is not blocked').toBe('sent');
  });

  it('a send that outlives the timeout and then answers THREAD_BUSY does not turn into a held slot', async () => {
    await pins(1);
    const release = gateSends();
    fake.sendErrors.push(new FakeApiError('THREAD_BUSY'));
    const first = send([1], rid('a'));
    await waitPending(1);
    await clock.advance(ATTEMPT_TIMEOUT_MS + 10);
    expect(await first).toMatchObject({ status: 'rejected', reason: 'failed' });
    release();
    await settle();
    expect(coordinator.pendingCount).toBe(0);
    expect(fake.sends).toHaveLength(0);
    running(false);
    await clock.advance(POLL_MS * 3);
    expect(fake.sends, 'an abandoned run must never send later').toHaveLength(0);
  });

  it('a hung threads.get while the thread is busy: after release no hold, and a later run end sends nothing', async () => {
    const { coordApi, gate } = heldCoordApi('get');
    controller.dispose(); coordinator.dispose();
    useStack({ coordApi });
    await pins(1);
    running(true);
    gate.hold = true;
    const first = send([1], rid('a'));
    await waitPending(1);
    await clock.advance(ATTEMPT_TIMEOUT_MS + 10);
    await first;
    gate.hold = false; gate.release();
    await settle();
    await finishRun();
    expect(fake.sends).toHaveLength(0);
    expect(coordinator.pendingCount).toBe(0);
    expect(await byId(1)).toMatchObject({ status: 'open' });
  });

  it('timeout while threads.send is in flight: the caller is told it may have been received, the same request id retries safely in this process, and a NEW request id is the user\'s explicit second message', async () => {
    await pins(1);
    const release = gateSends();
    const first = send([1], rid('a'));
    await waitPending(1);
    await clock.advance(ATTEMPT_TIMEOUT_MS + 10);
    expect(await first).toMatchObject({ status: 'rejected', reason: 'failed', message: expect.stringMatching(/may have been received|check the thread/i) });
    release();
    await settle();
    expect(fake.sends).toHaveLength(1);
    ok(await send([1], rid('a')));
    expect(fake.sends, 'same request id: host dedupes').toHaveLength(1);
  });

  it.fails('ADVISORY: timeout (message may have arrived), then a reload, then the same request id: must not send a second message', async () => {
    useStack({ boundarySecret: 'S1' });
    await pins(1);
    const release = gateSends();
    const first = send([1], rid('a'));
    await waitPending(1);
    await clock.advance(ATTEMPT_TIMEOUT_MS + 10);
    await first;
    release();
    await settle();
    expect(fake.sends).toHaveLength(1);
    controller.dispose(); coordinator.dispose();
    useStack({ boundarySecret: 'S2' });
    await send([1], rid('a'));
    expect(fake.sends).toHaveLength(1);
  });
});
const POLL_MS = 5000;

describe('fix pass: retry after a reload is a conflict, not a dead end', () => {
  async function crashed() {
    useStack({ boundarySecret: 'S1' });
    await pins(2);
    const release = gateSends();
    const old = send([1, 2], rid('a'));
    await waitPending(1);
    controller.dispose(); coordinator.dispose();
    release();
    await old;
    await settle();
    useStack({ boundarySecret: 'S2' });
  }

  it('the conflict writes nothing, sends nothing, names the reason, is stable on repeat, and does not poison the ledger', async () => {
    await crashed();
    await list(); // the restart recovery runs once, here
    const bytes = await fs.readFile(commentsFile(), 'utf8');
    for (let i = 0; i < 3; i++) expect(await send([1, 2], rid('a'))).toMatchObject({ status: 'rejected', reason: 'conflict', message: expect.stringMatching(/may already be in the thread/) });
    expect(await fs.readFile(commentsFile(), 'utf8')).toBe(bytes);
    expect(fake.sends).toHaveLength(1);
  });

  it('any one maybe-sent comment of the request makes the whole retry a conflict, a subset too, but a NEW request id sends all of them', async () => {
    await crashed();
    await pin(3);
    expect(await send([1, 3], rid('a'))).toMatchObject({ status: 'rejected', reason: 'conflict' });
    expect(await send([2], rid('a'))).toMatchObject({ status: 'rejected', reason: 'conflict' });
    expect(fake.sends).toHaveLength(1);
    expect(ok<any>(await send([1, 2, 3], rid('b'))).outcome).toBe('sent');
    expect(fake.sends).toHaveLength(2);
    for (const n of [1, 2, 3]) expect(await byId(n)).toMatchObject({ status: 'sent', send: { maybeSent: false } });
  });

  it('the user is never stuck: editing, resolving, dismissing and reopening a maybe-sent comment all work, and so does a new request', async () => {
    await crashed();
    const c = await byId(1);
    ok(await provider.update(target, { id: cmtId(1), expectedVersion: c.version, change: { text: 'Edited after the restart' } }, ctx()));
    expect(await send([1], rid('a'))).toMatchObject({ status: 'rejected', reason: 'conflict' });
    const c2 = await byId(2);
    ok(await provider.update(target, { id: cmtId(2), expectedVersion: c2.version, change: { action: 'dismiss' } }, ctx()));
    const c2b = await byId(2);
    ok(await provider.update(target, { id: cmtId(2), expectedVersion: c2b.version, change: { action: 'reopen' } }, ctx()));
    expect(ok<any>(await send([1, 2], rid('c'))).outcome).toBe('sent');
  });

  it('a comment maybe-sent from request A does not block request B even after a SECOND reload', async () => {
    await crashed();
    controller.dispose(); coordinator.dispose();
    useStack({ boundarySecret: 'S3' });
    expect(await byId(1)).toMatchObject({ status: 'open', send: { maybeSent: true } });
    expect(ok<any>(await send([1, 2], rid('b'))).outcome).toBe('sent');
  });

  it('a retry whose comments were recovered from a DIFFERENT earlier request is not a conflict', async () => {
    await crashed();
    expect(ok<any>(await send([1, 2], rid('d'))).outcome).toBe('sent');
    await provider.update(target, { id: cmtId(1), expectedVersion: (await byId(1)).version, change: { action: 'reopen' } }, ctx());
    expect(ok<any>(await send([1], rid('e'))).outcome, 'reopened + sent before: not maybe-sent').toBe('sent');
  });
});

describe('fix pass: the store keeps rejecting after the message went out', () => {
  const afterFirst = (events: string[], mode: 'reject' | 'throw' = 'reject') => (items: readonly any[], _real: any, call: number) => {
    if (call === 1 || !events.includes(items[0]?.event)) return undefined;
    return mode === 'reject' ? Promise.resolve(rejectedWrite) : Promise.reject(new Error('EIO'));
  };

  it('delivered always refused, reload-recovered works: comments end open + maybeSent, the report says so, and a retry of the same request is a conflict (no second message)', async () => {
    controller.dispose(); coordinator.dispose();
    useStack({ hooks: { transition: afterFirst(['delivered']) } });
    await pins(2);
    const result = ok<any>(await send([1, 2], rid('a')));
    expect(fake.sends).toHaveLength(1);
    expect(result.message).toMatch(/could not be saved/);
    for (const n of [1, 2]) expect(await byId(n)).toMatchObject({ status: 'open', send: { maybeSent: true } });
    const retry = await send([1, 2], rid('a'));
    expect(retry.status === 'rejected' || (retry.status === 'ok' && (retry.value as any).message.includes('could not be saved')), JSON.stringify(retry)).toBe(true);
    expect(fake.sends, 'no second message').toHaveLength(1);
  });

  it('the same with a thrown error instead of a rejection', async () => {
    controller.dispose(); coordinator.dispose();
    useStack({ hooks: { transition: afterFirst(['delivered'], 'throw') } });
    await pins(1);
    ok(await send([1], rid('a')));
    expect(await byId(1)).toMatchObject({ status: 'open', send: { maybeSent: true } });
  });

  it('one transient refusal is retried once and the outcome is a clean sent', async () => {
    controller.dispose(); coordinator.dispose();
    let refused = false;
    useStack({ hooks: { transition: (items, _r, call) => (call > 1 && !refused && items[0]?.event === 'delivered' ? ((refused = true), Promise.resolve(rejectedWrite)) : undefined) } });
    await pins(2);
    const result = ok<any>(await send([1, 2], rid('a')));
    expect(result.message).not.toMatch(/could not be saved/);
    for (const n of [1, 2]) expect(await byId(n)).toMatchObject({ status: 'sent', send: { maybeSent: false } });
  });

  it('EVERY write after the write-ahead refused: members stay pending, nothing throws, healing the disk lets the user take them back, and no second message exists', async () => {
    controller.dispose(); coordinator.dispose();
    let healed = false;
    useStack({ hooks: { transition: (items, _r, call) => (call > 1 && !healed ? Promise.resolve(rejectedWrite) : undefined), update: () => (healed ? undefined : Promise.resolve(rejectedWrite)) } });
    await pins(2);
    const result = ok<any>(await send([1, 2], rid('a')));
    expect(result.outcome).toBe('sent');
    expect(result.message).toMatch(/could not be saved/);
    healed = true;
    expect((await byId(1)).status).toBe('pending');
    ok(await unqueue(1));
    expect((await byId(1)).status).toBe('open');
    expect(fake.sends).toHaveLength(1);
  });

  it('EVERY write refused, then a restart: pending members are recovered as open + maybeSent and the request id is a conflict', async () => {
    controller.dispose(); coordinator.dispose();
    useStack({ hooks: { transition: (_i, _r, call) => (call > 1 ? Promise.resolve(rejectedWrite) : undefined) } });
    await pins(1);
    ok(await send([1], rid('a')));
    controller.dispose(); coordinator.dispose();
    useStack({ boundarySecret: 'S9' });
    expect(await byId(1)).toMatchObject({ status: 'open', send: { maybeSent: true } });
    expect(await send([1], rid('a'))).toMatchObject({ status: 'rejected', reason: 'conflict' });
    expect(fake.sends).toHaveLength(1);
  });

  it('send-failed always refused, expired works: comment is open + failed (not maybeSent) and can be re-sent with the same request id', async () => {
    controller.dispose(); coordinator.dispose();
    useStack({ hooks: { transition: afterFirst(['send-failed']) } });
    await pins(1);
    fake.sendErrors.push(new FakeApiError('INVALID_ARGUMENT'));
    expect(await send([1], rid('a'))).toMatchObject({ status: 'rejected' });
    expect(await byId(1)).toMatchObject({ status: 'open', send: { lastOutcome: 'failed', maybeSent: false } });
    expect(ok<any>(await send([1], rid('a'))).outcome).toBe('sent');
  });

  it('cancel with every unqueue update refused: members are released through expired, open, not maybeSent, none left pending', async () => {
    controller.dispose(); coordinator.dispose();
    useStack({ hooks: { update: input => (input.change?.action === 'unqueue' ? Promise.resolve(rejectedWrite) : undefined) } });
    await pins(3);
    running(true);
    ok(await send([1, 2, 3]));
    await unqueue(1);
    await settle();
    for (const n of [1, 2, 3]) expect(await byId(n), `member ${n}`).toMatchObject({ status: 'open', send: { maybeSent: false } });
    expect(fake.sends).toHaveLength(0);
  });

  it('a member resolved behind the queue keeps its status; the others are delivered; the changed member is not touched by the fallback', async () => {
    await pins(3);
    running(true);
    ok(await send([1, 2, 3], rid('a')));
    await rewriteComments(file => { file.comments.find((x: any) => x.id === cmtId(2)).status = 'resolved'; });
    await finishRun();
    expect((await byId(1)).status).toBe('sent');
    expect((await byId(3)).status).toBe('sent');
    expect((await byId(2)).status).toBe('resolved');
  });
});

describe('fix pass: cancelled tombstone', () => {
  it('within the window a retry of a cancelled request is a conflict and sends nothing; a new request id works', async () => {
    await pins(2);
    running(true);
    ok(await send([1, 2], rid('a')));
    ok(await unqueue(1));
    running(false);
    expect(await send([1, 2], rid('a'))).toMatchObject({ status: 'rejected', reason: 'conflict', message: expect.stringMatching(/cancelled/i) });
    expect(fake.sends).toHaveLength(0);
    expect(ok<any>(await send([1, 2], rid('b'))).outcome).toBe('sent');
  });

  it.fails('BUG: a batch queued for more than 10 minutes and then cancelled loses its tombstone at once (the window runs from creation), so a late retry revives it', async () => {
    await pins(1);
    running(true);
    ok(await send([1], rid('a')));
    nowMs = START_MS + 11 * 60 * 1000;
    ok(await unqueue(1));
    running(false);
    await send([1], rid('a'));
    expect(fake.sends, 'cancelled request sent again').toHaveLength(0);
  });
});

describe('fix pass: expectedVersion and plan keys', () => {
  it('an external version bump (comments.json rewritten) between snapshot and write-ahead is a skipped conflict for the whole batch: no message, nothing pending', async () => {
    controller.dispose(); coordinator.dispose();
    let armed = false;
    let done = false;
    useStack({ hooks: { afterSnapshot: async () => { if (!armed || done) return; done = true; await rewriteComments(file => { file.comments.find((x: any) => x.id === cmtId(2)).version += 1; }); } } });
    await pins(3);
    armed = true;
    const report = ok<any>(await send([1, 2, 3], rid('a')));
    armed = false;
    expect(report.outcome).toBe('none');
    expect(fake.sends).toHaveLength(0);
    for (const n of [1, 2, 3]) expect((await byId(n)).status).toBe('open');
    expect(ok<any>(await send([1, 2, 3], rid('a'))).outcome, 'observation: a conflict report is remembered for the request id (idempotent retry)').toBe('none');
    expect(ok<any>(await send([1, 2, 3], rid('b'))).outcome, 'a new request id sends').toBe('sent');
  });

  it('an edit between snapshot and write-ahead: nothing sent, and the retry sends the edited text', async () => {
    controller.dispose(); coordinator.dispose();
    let armed = false;
    let edited = false;
    useStack({ hooks: { afterSnapshot: async (real, snap) => { if (!armed || edited || snap.comments.length === 0) return; edited = true; const c = snap.comments[0]; ok(await real.update({ id: c.id, expectedVersion: c.version, change: { text: 'EDITED-RACE' } })); } } });
    await pins(1);
    armed = true;
    const report = ok<any>(await send([1], rid('a')));
    armed = false;
    expect(report.outcome).toBe('none');
    expect(fake.sends).toHaveLength(0);
    ok(await send([1], rid('b')));
    expect(promptsOf()[0]).toContain('EDITED-RACE');
  });

  it('plan key includes the text: edit between two attempts of one request id changes the prompt, and reverting the text gives the original prompt back', async () => {
    const attempted: string[] = [];
    const original = fake.api.threads.send.bind(fake.api.threads);
    (fake.api.threads as any).send = async (id: string, input: any) => { attempted.push(input.prompt); return original(id, input); };
    await pins(1);
    const edit = async (text: string) => { const c = await byId(1); ok(await provider.update(target, { id: cmtId(1), expectedVersion: c.version, change: { text } }, ctx())); };
    fake.sendErrors.push(new FakeApiError('RUN_FAILED'));
    await send([1], rid('a'));
    await edit('Second wording');
    fake.sendErrors.push(new FakeApiError('RUN_FAILED'));
    await send([1], rid('a'));
    await edit('Comment 1');
    ok(await send([1], rid('a')));
    expect(attempted).toHaveLength(3);
    expect(attempted[1]).toContain('Second wording');
    expect(attempted[1]).not.toBe(attempted[0]);
    expect(attempted[2]).toBe(attempted[0]);
  });
});

describe('fix pass: vault-read blanking and unfenced lines', () => {
  const VAULT = 'VAULTMARK';
  const secret = { textAnchor: { tag: 'h1', text: `${VAULT}-ANCHOR` }, landmark: `${VAULT}-LANDMARK`, a11y: { role: 'heading', name: `${VAULT}-NAME`, tabIndex: null }, outerHTML: { html: `<h1>${VAULT}-HTML</h1>`, truncated: false } };

  it('a pre-grant pin on a manifest-vault-read artifact: no anchor text, landmark, label text, html or name; structure (route, selector, tag) and the typed comment survive', async () => {
    await pin(1, { comment: 'Please make this bigger' }, secret);
    await fs.writeFile(path.join(root, 'artifact.json'), JSON.stringify({ ...buildDesignManifest('t1', 'Landing'), permissions: { network: 'none', clipboard: false, vault: 'read' } }));
    ok(await send([1], rid('a')));
    const prompt = fake.sends[0].prompt;
    expect(prompt).not.toContain(VAULT);
    expect(prompt).toContain('selector: ');
    expect(prompt).toContain('Please make this bigger');
    expect(prompt).toContain('pin label: "h1"');
  });

  it('the same when only the host target says vaultRead (manifest unchanged), and when the sidecar is gone', async () => {
    await pin(1, {}, secret);
    await fs.rm(path.join(root, '.threads-design', 'selections', `${selId(1)}.json`), { force: true });
    ok(await send([1], rid('a'), {}, { ...target, vaultRead: true }));
    expect(fake.sends[0].prompt).not.toContain(VAULT);
  });

  it('a normal (non vault-read) pin still carries its anchor text and label (the blanking is not applied elsewhere)', async () => {
    await pin(1, {}, secret);
    ok(await send([1], rid('a')));
    expect(fake.sends[0].prompt).toContain(`${VAULT}-ANCHOR`);
  });

  it('the artifact folder is named once per data block inside the fence; file lines are relative and fixed-shape', async () => {
    await pins(2);
    ok(await send([1, 2]));
    const prompt = fake.sends[0].prompt;
    expect((prompt.match(/^artifact folder: /gm) ?? []).length).toBe(2);
    expect(prompt).toContain(`Full payload: ".threads-design/selections/${selId(1)}.json"`);
  });
});
