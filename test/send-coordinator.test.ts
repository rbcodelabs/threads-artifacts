import { createHash } from 'node:crypto';
import { ARTIFACT_FEEDBACK_SUBMIT_TIMEOUT_MS } from '../src/geodeArtifactFeedback';
import { beforeEach, describe, expect, it } from 'vitest';
import { ATTEMPT_TIMEOUT_MS, createSendCoordinator, idempotencyKeyFor, PENDING_TTL_MS, type DeferredSendResult } from '../src/sendCoordinator';
import { THREAD_GONE_MESSAGE } from '../src/threadGone';
import { createFakeApi, FakeApiError } from './helpers/fakeApi';
import { createFakeClock } from './helpers/fakeClock';

const sha32 = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 32);

let fake: ReturnType<typeof createFakeApi>;
let clock: ReturnType<typeof createFakeClock>;
let deferred: DeferredSendResult[];

function make(options: Parameters<typeof createFakeApi>[0] = {}) {
  fake = createFakeApi(options);
  fake.addThread('t1');
  fake.addThread('t2');
  clock = createFakeClock();
  deferred = [];
  return createSendCoordinator({ api: fake.api, ownerPluginId: 'threads-design', clock, onDeferredResult: result => deferred.push(result) });
}

const req = (selectionId: string, prompt = `prompt for ${selectionId}`, artifactKey = 'art-1', threadId = 't1') => ({ selectionId, artifactKey, threadId, prompt });

beforeEach(() => { make(); });

describe('immediate send', () => {
  it('sends with owner id and a deterministic content-hash idempotency key', async () => {
    const coordinator = make();
    const outcome = await coordinator.submit(req('sel_a', 'hello'));
    expect(outcome).toEqual({ status: 'sent' });
    expect(fake.sends).toEqual([{ threadId: 't1', prompt: 'hello', ownerPluginId: 'threads-design', idempotencyKey: `design:t1:${sha32('hello')}` }]);
    expect(idempotencyKeyFor('t1', 'hello')).toBe(`design:t1:${sha32('hello')}`);
    expect(idempotencyKeyFor('t1', 'hello').length).toBeLessThanOrEqual(256);
  });

  it('never double-sends an identical prompt (host replays the key)', async () => {
    const coordinator = make();
    await coordinator.submit(req('sel_a', 'same'));
    await coordinator.submit(req('sel_a', 'same'));
    expect(fake.sends).toHaveLength(1);
  });

  it('reports a failed run as rejected when wait says failed', async () => {
    const coordinator = make();
    fake.state.waitResult = { status: 'failed', error: { code: 'RUN_FAILED', message: 'nope' } };
    expect(await coordinator.submit(req('sel_a'))).toMatchObject({ status: 'rejected', reason: 'failed' });
  });

  it('still reports sent when wait is unavailable or times out', async () => {
    expect(await make({ omitWait: true }).submit(req('sel_a'))).toEqual({ status: 'sent' });
    expect(await make().submit(req('sel_a'))).toEqual({ status: 'sent' });
  });
});

describe('busy threads', () => {
  it('queues while the thread runs and auto-sends on run.completed after a short settle delay', async () => {
    const coordinator = make();
    fake.threads.get('t1')!.isRunning = true;
    expect(await coordinator.submit(req('sel_a'))).toEqual({ status: 'queued' });
    expect(fake.sends).toHaveLength(0);
    fake.threads.get('t1')!.isRunning = false;
    fake.emit({ kind: 'run.completed', threadId: 't1', runId: 'x' });
    expect(fake.sends).toHaveLength(0); // settle delay
    await clock.advance(300);
    expect(fake.sends).toHaveLength(1);
    expect(deferred).toEqual([{ selectionId: 'sel_a', artifactKey: 'art-1', outcome: { status: 'sent' } }]);
    expect(coordinator.pendingCount).toBe(0);
  });

  it('also drains on run.failed', async () => {
    const coordinator = make();
    fake.threads.get('t1')!.isRunning = true;
    await coordinator.submit(req('sel_a'));
    fake.threads.get('t1')!.isRunning = false;
    fake.emit({ kind: 'run.failed', threadId: 't1', runId: 'x' });
    await clock.advance(300);
    expect(fake.sends).toHaveLength(1);
  });

  it('stays queued if a new run started in the settle gap, then sends on the next completion', async () => {
    const coordinator = make();
    fake.threads.get('t1')!.isRunning = true;
    await coordinator.submit(req('sel_a'));
    fake.emit({ kind: 'run.completed', threadId: 't1', runId: 'x' });
    await clock.advance(300); // thread still running
    expect(fake.sends).toHaveLength(0);
    expect(coordinator.pendingCount).toBe(1);
    fake.threads.get('t1')!.isRunning = false;
    fake.emit({ kind: 'run.completed', threadId: 't1', runId: 'y' });
    await clock.advance(300);
    expect(fake.sends).toHaveLength(1);
  });

  it('ignores events for other threads', async () => {
    const coordinator = make();
    fake.threads.get('t1')!.isRunning = true;
    await coordinator.submit(req('sel_a'));
    fake.threads.get('t1')!.isRunning = false;
    fake.emit({ kind: 'run.completed', threadId: 't2', runId: 'x' });
    await clock.advance(300);
    expect(fake.sends).toHaveLength(0);
  });

  it('treats THREAD_BUSY from send as busy and queues', async () => {
    const coordinator = make();
    fake.sendErrors.push(new FakeApiError('THREAD_BUSY'));
    expect(await coordinator.submit(req('sel_a'))).toEqual({ status: 'queued' });
    await clock.advance(5000);
    expect(fake.sends).toHaveLength(1);
  });

  it('treats a pending plan approval as busy', async () => {
    const coordinator = make();
    fake.threads.get('t1')!.planApprovalPending = true;
    expect(await coordinator.submit(req('sel_a'))).toEqual({ status: 'queued' });
    fake.threads.get('t1')!.planApprovalPending = false;
    await clock.advance(5000);
    expect(fake.sends).toHaveLength(1);
  });

  it('falls back to polling when the host cannot subscribe', async () => {
    const coordinator = make({ omitSubscribe: true });
    fake.threads.get('t1')!.isRunning = true;
    expect(await coordinator.submit(req('sel_a'))).toEqual({ status: 'queued' });
    await clock.advance(5000);
    expect(fake.sends).toHaveLength(0); // still running
    fake.threads.get('t1')!.isRunning = false;
    await clock.advance(5000);
    expect(fake.sends).toHaveLength(1);
  });

  it('does not subscribe when the capability is not advertised', async () => {
    const coordinator = make({ capabilities: ['threads.send', 'threads.permissions'] });
    fake.threads.get('t1')!.isRunning = true;
    await coordinator.submit(req('sel_a'));
    expect(fake.state.subscribeCalls).toBe(0);
    fake.threads.get('t1')!.isRunning = false;
    await clock.advance(5000);
    expect(fake.sends).toHaveLength(1);
  });

  it('works against an older host that does not report isRunning (relies on THREAD_BUSY)', async () => {
    const coordinator = make({ omitIsRunning: true });
    fake.threads.get('t1')!.isRunning = true; // the fake send still throws THREAD_BUSY
    expect(await coordinator.submit(req('sel_a'))).toEqual({ status: 'queued' });
    fake.threads.get('t1')!.isRunning = false;
    await clock.advance(5000);
    expect(fake.sends).toHaveLength(1);
  });

  it('holds exactly one pending slot per artifact', async () => {
    const coordinator = make();
    fake.threads.get('t1')!.isRunning = true;
    expect(await coordinator.submit(req('sel_a'))).toEqual({ status: 'queued' });
    const second = await coordinator.submit(req('sel_b'));
    expect(second).toMatchObject({ status: 'rejected', reason: 'busy' });
    expect((second as { message: string }).message).toContain('already waiting');
    // A retry of the queued selection is still acknowledged, not duplicated.
    expect(await coordinator.submit(req('sel_a'))).toEqual({ status: 'queued' });
    expect(coordinator.pendingCount).toBe(1);
  });

  it('allows a new pending slot once the earlier one drained', async () => {
    const coordinator = make();
    fake.threads.get('t1')!.isRunning = true;
    await coordinator.submit(req('sel_a'));
    fake.threads.get('t1')!.isRunning = false;
    await clock.advance(5000);
    fake.threads.get('t1')!.isRunning = true;
    expect(await coordinator.submit(req('sel_b'))).toEqual({ status: 'queued' });
  });

  it('keeps slots independent per artifact', async () => {
    const coordinator = make();
    fake.threads.get('t1')!.isRunning = true;
    fake.threads.get('t2')!.isRunning = true;
    expect(await coordinator.submit(req('sel_a', 'p1', 'art-1', 't1'))).toEqual({ status: 'queued' });
    expect(await coordinator.submit(req('sel_b', 'p2', 'art-2', 't2'))).toEqual({ status: 'queued' });
    expect(coordinator.pendingCount).toBe(2);
  });

  it('serializes two concurrent submits for one artifact', async () => {
    const coordinator = make();
    const [a, b] = await Promise.all([coordinator.submit(req('sel_a')), coordinator.submit(req('sel_b'))]);
    expect([a.status, b.status].sort()).toEqual(['rejected', 'sent']);
    expect(fake.sends).toHaveLength(1);
  });
});

describe('failure mapping', () => {
  const cases: [string, 'busy' | 'invalid' | 'unavailable' | 'failed', RegExp][] = [
    ['IDEMPOTENCY_CONFLICT', 'failed', /clash|earlier/i],
    ['INVALID_ARGUMENT', 'invalid', /too long|accept/i],
    ['THREAD_NOT_FOUND', 'unavailable', /archived or deleted/i],
    ['RUN_FAILED', 'failed', /start|thread/i],
    ['PLUGIN_UNAVAILABLE', 'unavailable', /not available/i],
    ['SOMETHING_ELSE', 'failed', /could not send/i],
  ];
  it.each(cases)('maps %s to a clear rejected message', async (code, reason, message) => {
    const coordinator = make();
    fake.sendErrors.push(new FakeApiError(code));
    const outcome = await coordinator.submit(req('sel_a'));
    expect(outcome).toMatchObject({ status: 'rejected', reason });
    expect((outcome as { message: string }).message).toMatch(message);
    expect((outcome as { message: string }).message.length).toBeLessThan(200);
    expect(coordinator.pendingCount).toBe(0);
  });

  it('rejects with the archived-or-deleted message when the thread no longer exists (archived threads are deleted by the host)', async () => {
    const coordinator = make();
    fake.threads.delete('t1');
    expect(await coordinator.submit(req('sel_a'))).toMatchObject({ status: 'rejected', reason: 'unavailable', message: THREAD_GONE_MESSAGE });
  });

  it('maps a thrown get() to unavailable without leaving a slot', async () => {
    const coordinator = make();
    (fake.api.threads as any).get = async () => { throw new Error('host down'); };
    expect(await coordinator.submit(req('sel_a'))).toMatchObject({ status: 'rejected', reason: 'unavailable' });
    expect(await coordinator.submit(req('sel_b'))).toMatchObject({ status: 'rejected', reason: 'unavailable' });
  });

  it('reports a deferred failure and frees the slot', async () => {
    const coordinator = make();
    fake.threads.get('t1')!.isRunning = true;
    await coordinator.submit(req('sel_a'));
    fake.threads.get('t1')!.isRunning = false;
    fake.sendErrors.push(new FakeApiError('IDEMPOTENCY_CONFLICT'));
    await clock.advance(5000);
    expect(deferred).toHaveLength(1);
    expect(deferred[0]).toMatchObject({ selectionId: 'sel_a', artifactKey: 'art-1', outcome: { status: 'rejected', reason: 'failed' } });
    expect(coordinator.pendingCount).toBe(0);
    expect(await coordinator.submit(req('sel_b'))).toEqual({ status: 'sent' });
  });

  it('drops a queued comment with the archived-or-deleted message when its thread is archived (thread.removed)', async () => {
    const coordinator = make();
    fake.threads.get('t1')!.isRunning = true;
    await coordinator.submit(req('sel_a'));
    fake.emit({ kind: 'thread.removed', threadId: 't1' });
    await clock.flush();
    expect(coordinator.pendingCount).toBe(0);
    expect(deferred[0]).toMatchObject({ selectionId: 'sel_a', artifactKey: 'art-1', outcome: { status: 'rejected', reason: 'unavailable', message: THREAD_GONE_MESSAGE } });
  });
});

describe('lifecycle', () => {
  it('subscribes lazily, unsubscribes and clears timers once nothing is pending', async () => {
    const coordinator = make();
    await coordinator.submit(req('sel_a')); // immediate send: no subscription needed
    expect(fake.state.subscribeCalls).toBe(0);
    expect(clock.pending).toBe(0);
    fake.threads.get('t1')!.isRunning = true;
    await coordinator.submit(req('sel_b'));
    expect(fake.state.subscribeCalls).toBe(1);
    expect(clock.pending).toBe(2); // the backup poll and the slot expiry
    fake.threads.get('t1')!.isRunning = false;
    await clock.advance(5000);
    expect(fake.listenerCount).toBe(0);
    expect(clock.pending).toBe(0);
  });

  it('dispose unsubscribes, clears timers and refuses new work', async () => {
    const coordinator = make();
    fake.threads.get('t1')!.isRunning = true;
    await coordinator.submit(req('sel_a'));
    coordinator.dispose();
    expect(fake.listenerCount).toBe(0);
    expect(fake.state.disposeCalls).toBe(1);
    expect(clock.pending).toBe(0);
    expect(coordinator.pendingCount).toBe(0);
    fake.threads.get('t1')!.isRunning = false;
    fake.emit({ kind: 'run.completed', threadId: 't1', runId: 'x' });
    await clock.advance(10_000);
    expect(fake.sends).toHaveLength(0);
    expect(await coordinator.submit(req('sel_b'))).toMatchObject({ status: 'rejected', reason: 'unavailable' });
    coordinator.dispose(); // idempotent
  });
});

describe('conflict wording (QB3)', () => {
  it('points the user at Retry, which is what the popover offers', async () => {
    const coordinator = make();
    fake.sendErrors.push(new FakeApiError('IDEMPOTENCY_CONFLICT'));
    const outcome = await coordinator.submit(req('sel_a'));
    expect((outcome as { message: string }).message).toMatch(/Retry/);
  });
});

describe('pending slot expiry (A9)', () => {
  it('drops a queued comment after the TTL with a rejection and frees the slot', async () => {
    const coordinator = make();
    fake.threads.get('t1')!.isRunning = true;
    await coordinator.submit(req('sel_a'));
    await clock.advance(PENDING_TTL_MS - 1000);
    expect(coordinator.pendingCount).toBe(1);
    await clock.advance(2000);
    expect(coordinator.pendingCount).toBe(0);
    expect(deferred).toHaveLength(1);
    expect(deferred[0]).toMatchObject({ selectionId: 'sel_a', artifactKey: 'art-1', outcome: { status: 'rejected', reason: 'unavailable', message: expect.stringContaining('waited too long') } });
    expect(fake.listenerCount).toBe(0);
    expect(clock.pending).toBe(0);
  });

  it('does not fire the expiry for a slot that already sent', async () => {
    const coordinator = make();
    fake.threads.get('t1')!.isRunning = true;
    await coordinator.submit(req('sel_a'));
    fake.threads.get('t1')!.isRunning = false;
    await clock.advance(5000);
    await clock.advance(PENDING_TTL_MS);
    expect(deferred).toHaveLength(1);
    expect(deferred[0].outcome).toEqual({ status: 'sent' });
  });
});

describe('dispose notices and status-unknown (A9, QB4)', () => {
  it('reports every dropped queued comment through onDeferredResult when disposed', async () => {
    const coordinator = make();
    fake.threads.get('t1')!.isRunning = true;
    await coordinator.submit(req('sel_a'));
    coordinator.dispose();
    expect(deferred).toHaveLength(1);
    expect(deferred[0]).toMatchObject({ selectionId: 'sel_a', artifactKey: 'art-1', outcome: { status: 'rejected', message: expect.stringContaining('reloaded') } });
  });

  it('survives an onDeferredResult callback that throws', async () => {
    fake = createFakeApi();
    fake.addThread('t1');
    clock = createFakeClock();
    const coordinator = createSendCoordinator({ api: fake.api, ownerPluginId: 'threads-design', clock, onDeferredResult: () => { throw new Error('notice failed'); } });
    fake.threads.get('t1')!.isRunning = true;
    await coordinator.submit(req('sel_a'));
    expect(() => fake.emit({ kind: 'thread.removed', threadId: 't1' })).not.toThrow();
    expect(coordinator.pendingCount).toBe(0);
    await coordinator.submit(req('sel_b')).catch(() => undefined);
    expect(() => coordinator.dispose()).not.toThrow();
  });

  it('does not claim the comment cannot be sent when dispose lands after the send was issued', async () => {
    const coordinator = make();
    let release!: () => void;
    fake.state.gate = new Promise<void>(resolve => { release = resolve; });
    const pending = coordinator.submit(req('sel_a'));
    await clock.flush();
    coordinator.dispose();
    release();
    const outcome = await pending;
    expect(outcome).toMatchObject({ status: 'rejected', reason: 'unavailable' });
    expect((outcome as { message: string }).message).toMatch(/check the thread/i);
    expect((outcome as { message: string }).message).not.toMatch(/cannot be sent/i);
  });

  it('keeps the plain shutting-down message when dispose lands before anything was sent', async () => {
    const coordinator = make();
    const pending = coordinator.submit(req('sel_a'));
    coordinator.dispose();
    const outcome = await pending;
    expect((outcome as { message: string }).message).not.toMatch(/check the thread/i);
    expect(fake.sends).toHaveLength(0);
  });
});

describe('hung sends (QB2)', () => {
  it('times out a never-settling attempt so Retry can start a fresh one with the same key', async () => {
    const coordinator = make();
    fake.state.hangSends = 1;
    const first = coordinator.submit(req('sel_a', 'same prompt'));
    await clock.flush(); // the attempt reaches the hung send before the timeout fires (a run that times out earlier is abandoned)
    await clock.advance(ATTEMPT_TIMEOUT_MS + 100);
    const outcome = await first;
    expect(outcome).toMatchObject({ status: 'rejected', reason: 'failed', message: expect.stringContaining('check the thread') });
    expect(await coordinator.submit(req('sel_a', 'same prompt'))).toEqual({ status: 'sent' });
    expect(fake.sends).toHaveLength(1);
    expect(clock.pending).toBe(0);
  });

  it('returns the in-flight promise to a concurrent submit of the same selection', async () => {
    const coordinator = make();
    let release!: () => void;
    fake.state.gate = new Promise<void>(resolve => { release = resolve; });
    const a = coordinator.submit(req('sel_a'));
    const b = coordinator.submit(req('sel_a'));
    release();
    expect(await a).toEqual(await b);
    expect(fake.sends).toHaveLength(1);
  });
});

describe('attempt timeout vs the Geode submit timeout', () => {
  it('is strictly shorter than the host timeout, derived from the contract constant', () => {
    expect(ATTEMPT_TIMEOUT_MS).toBeLessThan(ARTIFACT_FEEDBACK_SUBMIT_TIMEOUT_MS);
    expect(ATTEMPT_TIMEOUT_MS).toBeGreaterThanOrEqual(5000);
  });

  it('lets the first Retry after Geode times out start a fresh send with the same key', async () => {
    const coordinator = make();
    fake.state.hangSends = 1;
    const first = coordinator.submit(req('sel_a', 'same prompt'));
    await clock.flush(); // the attempt reaches the hung send before the timeout fires
    await clock.advance(ARTIFACT_FEEDBACK_SUBMIT_TIMEOUT_MS); // Geode gives up here
    expect(await first).toMatchObject({ status: 'rejected', message: expect.stringContaining('check the thread') });
    expect(await coordinator.submit(req('sel_a', 'same prompt'))).toEqual({ status: 'sent' });
    expect(fake.sends).toHaveLength(1);
    expect(fake.sends[0].idempotencyKey).toBe(idempotencyKeyFor('t1', 'same prompt'));
  });
});
