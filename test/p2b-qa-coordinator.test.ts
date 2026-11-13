import { describe, expect, it } from 'vitest';
import { ATTEMPT_TIMEOUT_MS, createSendCoordinator, PENDING_TTL_MS, POLL_INTERVAL_MS, type DeferredSendResult } from '../src/sendCoordinator';
import { createFakeApi, FakeApiError } from './helpers/fakeApi';
import { createFakeClock } from './helpers/fakeClock';

/**
 * Independent QA of sendCoordinator.cancel / isBusy / the `sending` guard (design 4.2).
 * The races here are the ones the engineer's tests do not drive: cancel while the drain is parked in threads.get
 * (not yet sending), cancel after a THREAD_BUSY bounce, cancel versus TTL / thread.removed, a double drain trigger.
 */

function setup(options: { holdGet?: boolean } = {}) {
  const fake = createFakeApi();
  fake.addThread('t1');
  const clock = createFakeClock();
  const deferred: DeferredSendResult[] = [];
  const gate = { hold: false, fail: false, release: () => undefined as void, promise: Promise.resolve() };
  gate.promise = new Promise<void>(resolve => { gate.release = resolve; });
  const realGet = fake.api.threads.get.bind(fake.api.threads);
  const api = options.holdGet
    ? ({ ...fake.api, threads: { ...fake.api.threads, get: async (id: string) => { if (gate.fail) throw new Error('transient'); if (gate.hold) await gate.promise; return realGet(id); } } } as typeof fake.api)
    : fake.api;
  const coordinator = createSendCoordinator({ api, ownerPluginId: 'threads-design', clock, onDeferredResult: result => deferred.push(result) });
  return { fake, clock, deferred, coordinator, gate };
}

const req = (selectionId: string, prompt = `prompt for ${selectionId}`, artifactKey = 'art-1') => ({ selectionId, artifactKey, threadId: 't1', prompt });

describe('cancel versus a drain that has not started sending', () => {
  it('cancel while the drain is parked in threads.get wins: nothing is sent, one cancelled result, and the slot is free', async () => {
    const { fake, clock, deferred, coordinator, gate } = setup({ holdGet: true });
    fake.threads.get('t1')!.isRunning = true;
    expect(await coordinator.submit(req('req_a'))).toEqual({ status: 'queued' });
    fake.threads.get('t1')!.isRunning = false;
    gate.hold = true;
    fake.emit({ kind: 'run.completed', threadId: 't1', runId: 'r' });
    await clock.advance(300); // drain() now waits inside threads.get
    expect(coordinator.cancel('art-1', 'req_a')).toBe(true);
    gate.hold = false; gate.release();
    await clock.flush(); await clock.advance(POLL_INTERVAL_MS * 3);
    expect(fake.sends).toHaveLength(0);
    expect(deferred).toEqual([{ selectionId: 'req_a', artifactKey: 'art-1', outcome: { status: 'cancelled' } }]);
    expect(coordinator.pendingCount).toBe(0);
    expect(await coordinator.submit(req('req_b'))).toEqual({ status: 'sent' });
  });

  it('cancel while threads.send is in progress is refused, and the single result is sent', async () => {
    const { fake, clock, deferred, coordinator } = setup();
    fake.threads.get('t1')!.isRunning = true;
    await coordinator.submit(req('req_a'));
    fake.threads.get('t1')!.isRunning = false;
    let release!: () => void;
    fake.state.gate = new Promise<void>(resolve => { release = resolve; });
    fake.emit({ kind: 'run.completed', threadId: 't1', runId: 'r' });
    await clock.advance(300);
    expect(coordinator.cancel('art-1', 'req_a')).toBe(false);
    expect(coordinator.isBusy('art-1', 'req_a'), 'same request is not busy with itself').toBe(false);
    expect(coordinator.isBusy('art-1', 'req_b'), 'a different request is busy while the slot is sending').toBe(true);
    release();
    await clock.flush(); await clock.advance(10);
    expect(fake.sends).toHaveLength(1);
    expect(deferred).toEqual([{ selectionId: 'req_a', artifactKey: 'art-1', outcome: { status: 'sent' } }]);
    expect(coordinator.cancel('art-1', 'req_a'), 'too late once sent').toBe(false);
  });

  it('after a THREAD_BUSY bounce in the drain the slot is still held and cancel works again (sending was reset)', async () => {
    const { fake, clock, deferred, coordinator } = setup();
    fake.threads.get('t1')!.isRunning = true;
    await coordinator.submit(req('req_a'));
    fake.threads.get('t1')!.isRunning = false;
    fake.sendErrors.push(new FakeApiError('THREAD_BUSY'));
    fake.emit({ kind: 'run.completed', threadId: 't1', runId: 'r' });
    await clock.advance(300);
    expect(fake.sends).toHaveLength(0);
    expect(coordinator.pendingCount).toBe(1);
    expect(coordinator.cancel('art-1', 'req_a')).toBe(true);
    expect(deferred).toEqual([{ selectionId: 'req_a', artifactKey: 'art-1', outcome: { status: 'cancelled' } }]);
  });

  it('after a transient host error in the drain the slot is kept, cancel works, and the next poll retries', async () => {
    const { fake, clock, deferred, coordinator, gate } = setup({ holdGet: true });
    fake.threads.get('t1')!.isRunning = true;
    await coordinator.submit(req('req_a'));
    fake.threads.get('t1')!.isRunning = false;
    gate.fail = true;
    fake.emit({ kind: 'run.completed', threadId: 't1', runId: 'r' });
    await clock.advance(300);
    expect(fake.sends).toHaveLength(0);
    expect(coordinator.pendingCount).toBe(1);
    gate.fail = false;
    await clock.advance(POLL_INTERVAL_MS + 10);
    expect(fake.sends).toHaveLength(1);
    expect(deferred.map(d => d.outcome.status)).toEqual(['sent']);
    expect(coordinator.cancel('art-1', 'req_a')).toBe(false);
  });

  it('cancel works after a transient host error (sending was reset in finally)', async () => {
    const { fake, clock, deferred, coordinator, gate } = setup({ holdGet: true });
    fake.threads.get('t1')!.isRunning = true;
    await coordinator.submit(req('req_a'));
    fake.threads.get('t1')!.isRunning = false;
    gate.fail = true;
    fake.emit({ kind: 'run.completed', threadId: 't1', runId: 'r' });
    await clock.advance(300);
    expect(coordinator.cancel('art-1', 'req_a')).toBe(true);
    gate.fail = false;
    await clock.advance(POLL_INTERVAL_MS * 3);
    expect(fake.sends).toHaveLength(0);
    expect(deferred).toEqual([{ selectionId: 'req_a', artifactKey: 'art-1', outcome: { status: 'cancelled' } }]);
  });
});

describe('cancel versus other ways a slot ends', () => {
  it('TTL expiry then cancel: exactly one result (rejected), cancel is false', async () => {
    const { fake, clock, deferred, coordinator } = setup();
    fake.threads.get('t1')!.isRunning = true;
    await coordinator.submit(req('req_a'));
    await clock.advance(PENDING_TTL_MS + 1);
    expect(deferred.map(d => d.outcome.status)).toEqual(['rejected']);
    expect(coordinator.cancel('art-1', 'req_a')).toBe(false);
    expect(deferred).toHaveLength(1);
  });

  it('cancel then TTL and thread.removed: still exactly one result (cancelled), nothing later', async () => {
    const { fake, clock, deferred, coordinator } = setup();
    fake.threads.get('t1')!.isRunning = true;
    await coordinator.submit(req('req_a'));
    expect(coordinator.cancel('art-1', 'req_a')).toBe(true);
    fake.emit({ kind: 'thread.removed', threadId: 't1' });
    await clock.advance(PENDING_TTL_MS + 1);
    expect(deferred).toEqual([{ selectionId: 'req_a', artifactKey: 'art-1', outcome: { status: 'cancelled' } }]);
  });

  it('cancel then an immediate submit of another request in the same tick queues the new one and the old one never sends', async () => {
    const { fake, clock, deferred, coordinator } = setup();
    fake.threads.get('t1')!.isRunning = true;
    await coordinator.submit(req('req_a', 'old'));
    expect(coordinator.cancel('art-1', 'req_a')).toBe(true);
    expect(await coordinator.submit(req('req_b', 'new'))).toEqual({ status: 'queued' });
    fake.threads.get('t1')!.isRunning = false;
    fake.emit({ kind: 'run.completed', threadId: 't1', runId: 'r' });
    await clock.advance(300);
    expect(fake.sends.map(s => s.prompt)).toEqual(['new']);
    expect(deferred.map(d => [d.selectionId, d.outcome.status])).toEqual([['req_a', 'cancelled'], ['req_b', 'sent']]);
  });

  it('two completion events and a poll in the same window cause exactly one send', async () => {
    const { fake, clock, deferred, coordinator } = setup();
    fake.threads.get('t1')!.isRunning = true;
    await coordinator.submit(req('req_a'));
    fake.threads.get('t1')!.isRunning = false;
    fake.emit({ kind: 'run.completed', threadId: 't1', runId: 'r1' });
    fake.emit({ kind: 'run.failed', threadId: 't1', runId: 'r2' });
    fake.emit({ kind: 'run.completed', threadId: 't1', runId: 'r3' });
    await clock.advance(POLL_INTERVAL_MS + 300);
    expect(fake.sends).toHaveLength(1);
    expect(deferred).toHaveLength(1);
  });

  it('slots are per artifact: cancelling one artifact leaves the other and isBusy is per artifact', async () => {
    const { fake, coordinator, deferred } = setup();
    fake.threads.get('t1')!.isRunning = true;
    await coordinator.submit(req('req_a', 'pa', 'art-1'));
    await coordinator.submit(req('req_b', 'pb', 'art-2'));
    expect(coordinator.isBusy('art-1', 'req_b')).toBe(true);
    expect(coordinator.isBusy('art-3', 'req_b')).toBe(false);
    expect(coordinator.cancel('art-1', 'req_b'), 'req_b belongs to art-2').toBe(false);
    expect(coordinator.cancel('art-2', 'req_b')).toBe(true);
    expect(coordinator.pendingCount).toBe(1);
    expect(deferred).toEqual([{ selectionId: 'req_b', artifactKey: 'art-2', outcome: { status: 'cancelled' } }]);
  });

  it('a throwing onDeferredResult does not break cancel or the slot map', async () => {
    const fake = createFakeApi();
    fake.addThread('t1');
    const coordinator = createSendCoordinator({ api: fake.api, ownerPluginId: 'threads-design', clock: createFakeClock(), onDeferredResult: () => { throw new Error('listener bug'); } });
    fake.threads.get('t1')!.isRunning = true;
    await coordinator.submit(req('req_a'));
    expect(coordinator.cancel('art-1', 'req_a')).toBe(true);
    expect(coordinator.pendingCount).toBe(0);
    expect(await coordinator.submit(req('req_b'))).toEqual({ status: 'queued' });
  });
});

describe('isBusy', () => {
  it('is false for everything after dispose and for an idle artifact, true only for a DIFFERENT request while one is in flight', async () => {
    const { fake, clock, coordinator } = setup();
    expect(coordinator.isBusy('art-1', 'req_a')).toBe(false);
    let release!: () => void;
    fake.state.gate = new Promise<void>(resolve => { release = resolve; });
    const inFlight = coordinator.submit(req('req_a'));
    await clock.flush();
    expect(coordinator.isBusy('art-1', 'req_a')).toBe(false);
    expect(coordinator.isBusy('art-1', 'req_b')).toBe(true);
    release();
    await inFlight;
    expect(coordinator.isBusy('art-1', 'req_b')).toBe(false);
    coordinator.dispose();
    expect(coordinator.isBusy('art-1', 'req_b')).toBe(false);
    expect(coordinator.cancel('art-1', 'req_b')).toBe(false);
  });

  it('a hung submit past the attempt timeout stops counting as in flight (slot map and inFlight agree)', async () => {
    const { fake, clock, coordinator } = setup();
    fake.state.hangSends = 1;
    const result = coordinator.submit(req('req_a'));
    await clock.flush();
    expect(coordinator.isBusy('art-1', 'req_b')).toBe(true);
    await clock.advance(ATTEMPT_TIMEOUT_MS + 1);
    expect(await result).toMatchObject({ status: 'rejected', reason: 'failed' });
    expect(coordinator.isBusy('art-1', 'req_b')).toBe(false);
  });

  it('BUG B1 (coordinator level): a submit that already reported a timeout must not later create a held slot', async () => {
    const { fake, clock, coordinator, gate } = setup({ holdGet: true });
    fake.threads.get('t1')!.isRunning = true;
    gate.hold = true;
    const result = coordinator.submit(req('req_a'));
    await clock.flush();
    await clock.advance(ATTEMPT_TIMEOUT_MS + 1);
    expect(await result).toMatchObject({ status: 'rejected' });
    gate.hold = false; gate.release();
    await clock.flush();
    expect(coordinator.pendingCount, 'orphan slot after the caller was told it failed').toBe(0);
  });
});


describe('review fixes: an attempt that timed out stays outstanding while its send may still land', () => {
  async function timedOut() {
    const ctxt = setup();
    let release!: () => void;
    ctxt.fake.state.gate = new Promise<void>(resolve => { release = resolve; });
    const first = ctxt.coordinator.submit(req('req_a', 'prompt-one'));
    await ctxt.clock.flush();
    await ctxt.clock.advance(ATTEMPT_TIMEOUT_MS + 1);
    expect(await first).toMatchObject({ status: 'rejected', reason: 'failed', maybeSent: true });
    return { ...ctxt, release };
  }

  it('a retry of the same request with a DIFFERENT prompt is refused as maybe-sent while the first send is outstanding', async () => {
    const { coordinator, fake } = await timedOut();
    expect(await coordinator.submit(req('req_a', 'prompt-two'))).toMatchObject({ status: 'rejected', reason: 'busy', maybeSent: true });
    expect(fake.sends).toHaveLength(0);
  });

  it('the same request with the SAME prompt is allowed (same idempotency key), and a different request is independent', async () => {
    const { coordinator, release, clock, fake } = await timedOut();
    const same = coordinator.submit(req('req_a', 'prompt-one'));
    const other = coordinator.submit(req('req_b', 'other-message', 'art-2'));
    release();
    await clock.flush();
    expect(await same).toEqual({ status: 'sent' });
    expect(await other).toEqual({ status: 'sent' });
    expect(fake.sends.filter(s => s.prompt === 'prompt-one')).toHaveLength(1);
  });

  it('once the outstanding send settles the different prompt is allowed again', async () => {
    const { coordinator, release, clock } = await timedOut();
    release();
    await clock.flush(); await clock.advance(10);
    expect(await coordinator.submit(req('req_a', 'prompt-two'))).toEqual({ status: 'sent' });
  });

  it('a send that never issued (timeout while threads.get hangs) does not block a different prompt', async () => {
    const { fake, clock, coordinator, gate } = setup({ holdGet: true });
    fake.threads.get('t1')!.isRunning = false;
    gate.hold = true;
    const first = coordinator.submit(req('req_a', 'prompt-one'));
    await clock.flush();
    await clock.advance(ATTEMPT_TIMEOUT_MS + 1);
    await first;
    gate.hold = false; gate.release();
    expect(await coordinator.submit(req('req_a', 'prompt-two'))).toEqual({ status: 'sent' });
  });

  it('dispose clears outstanding records', async () => {
    const { coordinator } = await timedOut();
    coordinator.dispose();
    expect(await coordinator.submit(req('req_a', 'prompt-two'))).toMatchObject({ status: 'rejected', reason: 'unavailable' });
  });
});


describe('review fixes: reload mid-send is flagged maybe-sent only when the send was issued', () => {
  it('dispose while threads.send is in flight: the caller learns it may have been sent', async () => {
    const { fake, clock, coordinator } = setup();
    let release!: () => void;
    fake.state.gate = new Promise<void>(resolve => { release = resolve; });
    const first = coordinator.submit(req('req_a', 'p'));
    await clock.flush();
    coordinator.dispose();
    release();
    await clock.flush();
    expect(await first).toMatchObject({ status: 'rejected', reason: 'unavailable', maybeSent: true });
  });

  it('dispose before threads.send was issued (threads.get still pending): not flagged', async () => {
    const { fake, clock, coordinator, gate } = setup({ holdGet: true });
    fake.threads.get('t1')!.isRunning = false;
    gate.hold = true;
    const first = coordinator.submit(req('req_a', 'p'));
    await clock.flush();
    coordinator.dispose();
    gate.hold = false; gate.release();
    await clock.flush();
    const result = await first;
    expect(result).toMatchObject({ status: 'rejected', reason: 'unavailable' });
    expect((result as { maybeSent?: boolean }).maybeSent).toBeUndefined();
    expect(fake.sends).toHaveLength(0);
  });
});
