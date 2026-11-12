import { describe, expect, it } from 'vitest';
import { COMMENTS_KEY_FIELD, createPluginDataGuard } from '../src/commentKey';
import type { PluginDataStorage } from '../src/commentKey';

/** Independent QA of the stall-wait fix (1bfa3a5f): wait measured from the stall start, refused once per stall. */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const never = () => new Promise<never>(() => undefined);
const hexOf = (key: Uint8Array) => Buffer.from(key).toString('hex');

function memory(initial: unknown, hooks: { save?: (n: number) => Promise<void> | void; load?: (n: number) => Promise<void> | void } = {}) {
  let data: unknown = structuredClone(initial);
  let attempts = 0;
  let loads = 0;
  const storage: PluginDataStorage = {
    loadData: async () => { loads += 1; await hooks.load?.(loads); return structuredClone(data); },
    saveData: async (next: unknown) => { attempts += 1; await hooks.save?.(attempts); data = structuredClone(next); },
  };
  return { storage, get data() { return data as Record<string, any>; }, get attempts() { return attempts; } };
}
const timed = async <T,>(p: Promise<T>) => { const t = Date.now(); const r = await p.then((v) => ({ ok: true as const, v }), (e) => ({ ok: false as const, e })); return { ...r, ms: Date.now() - t }; };

describe('stall wait: measured from the stall start, refused once per stall', () => {
  it('callers queued behind a save that hangs forever are all refused within about one wait, not N waits', async () => {
    const m = memory({ a: 1 }, { save: (n) => (n === 1 ? never() : undefined) });
    const guard = createPluginDataGuard(m.storage, { timeoutMs: 20, maxQueueWaitMs: 80 });
    await expect(guard.saveData({ a: 2 })).rejects.toMatchObject({ code: 'timeout' });
    const started = Date.now();
    const results = await Promise.all(Array.from({ length: 20 }, () => timed(guard.loadData())));
    const total = Date.now() - started;
    for (const r of results) expect(r.ok === false && (r.e as { code: string }).code).toBe('busy');
    expect(total).toBeLessThan(80 * 2);
    expect(m.data).toEqual({ a: 1 });
  });

  it('after the first refusal every later call is refused immediately (50 calls, each under 25 ms)', async () => {
    const m = memory({}, { save: (n) => (n === 1 ? never() : undefined) });
    const guard = createPluginDataGuard(m.storage, { timeoutMs: 20, maxQueueWaitMs: 40 });
    await expect(guard.saveData({})).rejects.toMatchObject({ code: 'timeout' });
    await expect(guard.loadData()).rejects.toMatchObject({ code: 'busy' });
    for (let i = 0; i < 50; i += 1) {
      const r = await timed(guard.getKey());
      expect(r.ok).toBe(false);
      expect(r.ms).toBeLessThan(25);
    }
  });

  it('a caller arriving after the wait has already elapsed is refused at once (the bound is from the stall start)', async () => {
    const m = memory({}, { save: (n) => (n === 1 ? never() : undefined) });
    const guard = createPluginDataGuard(m.storage, { timeoutMs: 20, maxQueueWaitMs: 50 });
    await expect(guard.saveData({})).rejects.toMatchObject({ code: 'timeout' });
    await sleep(120);
    const r = await timed(guard.saveData({ z: 1 }));
    expect(r.ok).toBe(false);
    expect(r.ms).toBeLessThan(25);
    expect(m.attempts).toBe(1);
  });

  it('callers queued inside the wait all proceed in order when the stalled save lands in time', async () => {
    const order: string[] = [];
    const m = memory({ [COMMENTS_KEY_FIELD]: { v: 1, key: 'ab'.repeat(32) } }, { save: (n) => (n === 1 ? sleep(70) : undefined) });
    const guard = createPluginDataGuard(m.storage, { timeoutMs: 20, maxQueueWaitMs: 400 });
    await expect(guard.saveData({ v: 'stalled' })).rejects.toMatchObject({ code: 'timeout' });
    await Promise.all([
      guard.loadData().then((d) => order.push(`load:${String(d.v)}`)),
      guard.saveData({ v: 'second' }).then(() => order.push('save2')),
      guard.loadData().then((d) => order.push(`load:${String(d.v)}`)),
    ]);
    expect(order).toEqual(['load:stalled', 'save2', 'load:second']);
    await sleep(100);
    expect(m.data.v).toBe('second');
  });

  it('settle then resume: a stall that lands after the refusals lets later calls through and the refusals left no trace', async () => {
    const m = memory({ [COMMENTS_KEY_FIELD]: { v: 1, key: 'ab'.repeat(32) } }, { save: (n) => (n === 1 ? sleep(150) : undefined) });
    const guard = createPluginDataGuard(m.storage, { timeoutMs: 20, maxQueueWaitMs: 40 });
    await expect(guard.saveData({ v: 'stalled' })).rejects.toMatchObject({ code: 'timeout' });
    const refused = await Promise.all([guard.saveData({ v: 'refused' }).catch((e) => e.code), guard.getKey().catch((e) => e.code), guard.update(() => ({ v: 'refused2' })).catch((e) => e.code)]);
    expect(refused).toEqual(['busy', 'busy', 'busy']);
    await sleep(200);
    expect(m.data.v).toBe('stalled');
    await guard.saveData({ v: 'after' });
    expect(m.data.v).toBe('after');
    expect(m.data[COMMENTS_KEY_FIELD]).toEqual({ v: 1, key: 'ab'.repeat(32) });
  });

  it('a second stall after resume gets its own clock and its own once-per-stall refusal', async () => {
    const m = memory({}, { save: (n) => (n === 1 ? sleep(60) : n === 2 ? sleep(300) : undefined) });
    const guard = createPluginDataGuard(m.storage, { timeoutMs: 20, maxQueueWaitMs: 40 });
    await expect(guard.saveData({ v: 1 })).rejects.toMatchObject({ code: 'timeout' });
    await sleep(100); // stall 1 settled
    await expect(guard.saveData({ v: 2 })).rejects.toMatchObject({ code: 'timeout' }); // stall 2 starts now
    const t = await timed(guard.loadData()); // must wait for the new stall, not be refused instantly off the old clock
    expect(t.ok).toBe(false);
    expect(t.ms).toBeGreaterThanOrEqual(10);
    await expect(guard.loadData()).rejects.toMatchObject({ code: 'busy' });
    await sleep(350);
    expect(await guard.loadData()).toEqual({ v: 2 });
  });

  it('a stalled save that fails releases the queue and clears the refusal', async () => {
    let n = 0;
    const m = memory({});
    const guard = createPluginDataGuard({ loadData: m.storage.loadData, saveData: async (d) => { n += 1; if (n === 1) { await sleep(80); throw new Error('EIO'); } await m.storage.saveData(d); } }, { timeoutMs: 20, maxQueueWaitMs: 30 });
    await expect(guard.saveData({ v: 1 })).rejects.toMatchObject({ code: 'timeout' });
    await expect(guard.saveData({ v: 2 })).rejects.toMatchObject({ code: 'busy' });
    await sleep(120);
    await guard.saveData({ v: 3 });
    expect(m.data.v).toBe(3);
  });

  it('the key that lands during the busy period is the key used afterwards, and nothing else was generated', async () => {
    const m = memory({}, { save: (n) => (n === 1 ? sleep(120) : undefined) });
    let g = 0;
    const guard = createPluginDataGuard(m.storage, { timeoutMs: 20, maxQueueWaitMs: 30, generate: () => new Uint8Array(32).fill(++g) });
    await expect(guard.getKey()).rejects.toMatchObject({ code: 'timeout' });
    const results = await Promise.all(Array.from({ length: 10 }, () => guard.getKey().then(hexOf, (e) => e.code)));
    expect(results.every((r) => r === 'busy')).toBe(true);
    await sleep(160);
    expect(hexOf(await guard.getKey())).toBe('01'.repeat(32));
    expect(g).toBe(1);
    expect(hexOf(await createPluginDataGuard(m.storage).getKey())).toBe('01'.repeat(32));
  });

  it('interplay with a timed-out read: a hung load queued behind a landing stall times out as timeout (not busy) and the queue then recovers', async () => {
    let hangLoads = false;
    const m = memory({ v: 0 }, { save: (n) => (n === 1 ? sleep(50) : undefined), load: () => (hangLoads ? never() : undefined) });
    const guard = createPluginDataGuard(m.storage, { timeoutMs: 20, maxQueueWaitMs: 400 });
    await expect(guard.saveData({ v: 1 })).rejects.toMatchObject({ code: 'timeout' });
    hangLoads = true;
    await expect(guard.loadData()).rejects.toMatchObject({ code: 'timeout' });
    hangLoads = false;
    expect(await guard.loadData()).toEqual({ v: 1 });
  });

  it('a read that times out while a stall is active does not create a second stall or extend the first', async () => {
    const m = memory({}, { save: (n) => (n === 1 ? never() : undefined), load: () => undefined });
    const guard = createPluginDataGuard(m.storage, { timeoutMs: 20, maxQueueWaitMs: 60 });
    await expect(guard.saveData({})).rejects.toMatchObject({ code: 'timeout' });
    const started = Date.now();
    await expect(guard.loadData()).rejects.toMatchObject({ code: 'busy' });
    expect(Date.now() - started).toBeLessThan(150);
  });

  it('maxQueueWaitMs 0 and negative refuse at once; NaN refuses promptly; no call ever hangs', async () => {
    for (const wait of [0, -5, Number.NaN]) {
      const m = memory({}, { save: (n) => (n === 1 ? never() : undefined) });
      const guard = createPluginDataGuard(m.storage, { timeoutMs: 20, maxQueueWaitMs: wait });
      await expect(guard.saveData({})).rejects.toMatchObject({ code: 'timeout' });
      const r = await timed(guard.loadData());
      expect(r.ok, `wait=${wait}`).toBe(false);
      expect(r.ms, `wait=${wait}`).toBeLessThan(100);
    }
  });

  it('huge maxQueueWaitMs (Infinity, 2^31, 1e12): never writes over the stall and never hangs; observed behavior is recorded', async () => {
    const observed: Record<string, string> = {};
    for (const wait of [Number.POSITIVE_INFINITY, 2 ** 31, 1e12]) {
      const m = memory({ v: 'start' }, { save: (n) => (n === 1 ? sleep(80) : undefined) });
      const guard = createPluginDataGuard(m.storage, { timeoutMs: 20, maxQueueWaitMs: wait });
      await expect(guard.saveData({ v: 'stalled' })).rejects.toMatchObject({ code: 'timeout' });
      const r = await timed(guard.loadData());
      observed[String(wait)] = r.ok ? `waited ${r.ms}ms then saw ${JSON.stringify(r.v)}` : `refused ${(r.e as { code: string }).code} after ${r.ms}ms`;
      if (r.ok) expect(r.v).toEqual({ v: 'stalled' }); // if it waits, it must wait for the landing
      await sleep(120);
    }
    console.log('huge maxQueueWaitMs observed', JSON.stringify(observed));
  });

  it('a stalled timeout on an UPDATE path: update is refused busy and its callback is not invoked', async () => {
    let called = 0;
    const m = memory({ a: 1 }, { save: (n) => (n === 1 ? never() : undefined) });
    const guard = createPluginDataGuard(m.storage, { timeoutMs: 20, maxQueueWaitMs: 30 });
    await expect(guard.saveData({ a: 2 })).rejects.toMatchObject({ code: 'timeout' });
    await expect(guard.update((c) => { called += 1; return c; })).rejects.toMatchObject({ code: 'busy' });
    expect(called).toBe(0);
  });
});
