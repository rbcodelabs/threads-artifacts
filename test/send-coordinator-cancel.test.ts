import { describe, expect, it } from 'vitest';
import { ATTEMPT_TIMEOUT_MS, createSendCoordinator, type DeferredSendResult } from '../src/sendCoordinator';
import { createFakeApi } from './helpers/fakeApi';
import { createFakeClock } from './helpers/fakeClock';

function setup() {
  const fake = createFakeApi();
  fake.addThread('t1');
  const clock = createFakeClock();
  const deferred: DeferredSendResult[] = [];
  const coordinator = createSendCoordinator({ api: fake.api, ownerPluginId: 'threads-design', clock, onDeferredResult: result => deferred.push(result) });
  return { fake, clock, deferred, coordinator };
}

const req = (selectionId: string, prompt = `prompt for ${selectionId}`) => ({ selectionId, artifactKey: 'art-1', threadId: 't1', prompt });

describe('sendCoordinator.cancel (unqueue)', () => {
  it('clears the held slot, reports a cancelled deferred result, and never sends it afterwards', async () => {
    const { fake, clock, deferred, coordinator } = setup();
    fake.threads.get('t1')!.isRunning = true;
    expect(await coordinator.submit(req('req_a'))).toEqual({ status: 'queued' });
    expect(coordinator.pendingCount).toBe(1);

    expect(coordinator.cancel('art-1', 'req_a')).toBe(true);
    expect(coordinator.pendingCount).toBe(0);
    expect(deferred).toEqual([{ selectionId: 'req_a', artifactKey: 'art-1', outcome: { status: 'cancelled' } }]);

    fake.threads.get('t1')!.isRunning = false;
    fake.emit({ kind: 'run.completed', threadId: 't1' } as never);
    await clock.advance(10_000);
    expect(fake.sends).toHaveLength(0);
    expect(clock.pending).toBe(0);
    expect(fake.listenerCount).toBe(0);
  });

  it('frees the slot so a different request is queued instead of rejected busy', async () => {
    const { fake, coordinator } = setup();
    fake.threads.get('t1')!.isRunning = true;
    await coordinator.submit(req('req_a'));
    expect(await coordinator.submit(req('req_b'))).toMatchObject({ status: 'rejected', reason: 'busy' });
    coordinator.cancel('art-1', 'req_a');
    expect(await coordinator.submit(req('req_b'))).toEqual({ status: 'queued' });
  });

  it('does nothing for another selection id, another artifact, or an empty slot', async () => {
    const { fake, deferred, coordinator } = setup();
    fake.threads.get('t1')!.isRunning = true;
    await coordinator.submit(req('req_a'));
    expect(coordinator.cancel('art-1', 'req_other')).toBe(false);
    expect(coordinator.cancel('art-2', 'req_a')).toBe(false);
    expect(coordinator.cancel('art-9', 'req_zzz')).toBe(false);
    expect(coordinator.pendingCount).toBe(1);
    expect(deferred).toEqual([]);
  });

  it('is idempotent: a second cancel is false and reports nothing more', async () => {
    const { fake, deferred, coordinator } = setup();
    fake.threads.get('t1')!.isRunning = true;
    await coordinator.submit(req('req_a'));
    expect(coordinator.cancel('art-1', 'req_a')).toBe(true);
    expect(coordinator.cancel('art-1', 'req_a')).toBe(false);
    expect(deferred).toHaveLength(1);
  });

  it('refuses to cancel while the held message is being sent right now', async () => {
    const { fake, clock, deferred, coordinator } = setup();
    fake.threads.get('t1')!.isRunning = true;
    await coordinator.submit(req('req_a'));
    fake.threads.get('t1')!.isRunning = false;
    let release!: () => void;
    fake.state.gate = new Promise<void>(resolve => { release = resolve; });
    fake.emit({ kind: 'run.completed', threadId: 't1' } as never);
    await clock.advance(300); // settle delay fires, the drain is now inside threads.send
    expect(coordinator.cancel('art-1', 'req_a')).toBe(false);
    release();
    await clock.advance(10);
    expect(fake.sends).toHaveLength(1);
    expect(deferred).toEqual([{ selectionId: 'req_a', artifactKey: 'art-1', outcome: { status: 'sent' } }]);
  });

  it('does not report anything after dispose', async () => {
    const { fake, deferred, coordinator } = setup();
    fake.threads.get('t1')!.isRunning = true;
    await coordinator.submit(req('req_a'));
    coordinator.dispose();
    deferred.length = 0;
    expect(coordinator.cancel('art-1', 'req_a')).toBe(false);
    expect(deferred).toEqual([]);
  });
});

describe('sendCoordinator.isBusy', () => {
  it('is true for a held slot or an in-flight send of a different request, false for the same request or an idle artifact', async () => {
    const { fake, coordinator } = setup();
    expect(coordinator.isBusy('art-1', 'req_a')).toBe(false);
    fake.threads.get('t1')!.isRunning = true;
    await coordinator.submit(req('req_a'));
    expect(coordinator.isBusy('art-1', 'req_b')).toBe(true);
    expect(coordinator.isBusy('art-1', 'req_a')).toBe(false);
    expect(coordinator.isBusy('art-2', 'req_b')).toBe(false);
    coordinator.cancel('art-1', 'req_a');
    expect(coordinator.isBusy('art-1', 'req_b')).toBe(false);
  });
});

describe('uncertain failures are flagged', () => {
  it('a timeout (the message may have been received) carries maybeSent, a definite failure does not', async () => {
    const { fake, clock, coordinator } = setup();
    fake.state.hangSends = 1;
    const hung = coordinator.submit(req('req_a'));
    await clock.flush();
    await clock.advance(ATTEMPT_TIMEOUT_MS + 1);
    expect(await hung).toMatchObject({ status: 'rejected', reason: 'failed', maybeSent: true });
    fake.sendErrors.push(Object.assign(new Error('x'), { code: 'INVALID_ARGUMENT' }));
    const refused = await coordinator.submit(req('req_b'));
    expect(refused).toMatchObject({ status: 'rejected', reason: 'invalid' });
    expect((refused as { maybeSent?: boolean }).maybeSent).toBeUndefined();
  });
});

describe('an abandoned (timed-out) run whose send is still outstanding', () => {
  async function abandoned() {
    const { fake, clock, coordinator } = setup();
    let release!: () => void;
    fake.state.gate = new Promise<void>(resolve => { release = resolve; });
    const first = coordinator.submit(req('req_a', 'prompt one'));
    await clock.flush();
    await clock.advance(ATTEMPT_TIMEOUT_MS + 1);
    expect(await first).toMatchObject({ status: 'rejected', maybeSent: true });
    return { fake, clock, coordinator, release };
  }

  it('a retry of the same request with a DIFFERENT prompt is refused while the first send may still land, and works once it settled', async () => {
    const { fake, clock, coordinator, release } = await abandoned();
    expect(await coordinator.submit(req('req_a', 'prompt two'))).toMatchObject({ status: 'rejected', reason: 'busy', maybeSent: true });
    release();
    await clock.flush();
    expect(fake.sends).toHaveLength(1);
    expect(await coordinator.submit(req('req_a', 'prompt two'))).toEqual({ status: 'sent' });
    expect(fake.sends).toHaveLength(2);
  });

  it('a retry with the SAME prompt is allowed (same idempotency key, so the host dedupes it)', async () => {
    const { fake, clock, coordinator, release } = await abandoned();
    const retry = coordinator.submit(req('req_a', 'prompt one'));
    release();
    await clock.flush();
    expect(await retry).toEqual({ status: 'sent' });
    expect(fake.sends).toHaveLength(1);
  });
});
