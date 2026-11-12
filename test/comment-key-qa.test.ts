import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COMMENTS_KEY_FIELD, createPluginDataGuard, InstallKeyError } from '../src/commentKey';
import type { PluginDataStorage } from '../src/commentKey';
import { createCommentStore, defaultStoreFsOps } from '../src/commentStore';
import type { CommentRootHandle, CommentStoreOptions } from '../src/commentStore';
import type { ArtifactCommentsResult } from '../src/geodeArtifactFeedbackV2';
import { ARTIFACT_ID, KEY, NOW, pinDraft } from './helpers/commentFixtures';

/**
 * Independent QA pass over createPluginDataGuard (src/commentKey.ts) and the store's key timeout and
 * poll overlap. Tests whose name starts with "BUG:" fail on purpose: they pin a defect in src/.
 */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const never = () => new Promise<never>(() => undefined);
const HEX64 = /^[0-9a-f]{64}$/;
const hexOf = (key: Uint8Array) => Buffer.from(key).toString('hex');
const VALID = { v: 1, key: 'ab'.repeat(32) };

/** In-memory plugin storage with a write log. Everything crossing the boundary is cloned, like real JSON. */
function memory(initial: unknown, hooks: { load?: (n: number) => Promise<void> | void; save?: (n: number, data: unknown) => Promise<void> | void } = {}) {
  let data: unknown = initial === undefined ? undefined : structuredClone(initial);
  const saves: Record<string, unknown>[] = [];
  let loads = 0;
  let attempts = 0;
  const storage: PluginDataStorage = {
    loadData: async () => { loads += 1; await hooks.load?.(loads); return data === undefined ? undefined : structuredClone(data); },
    saveData: async (next: unknown) => { attempts += 1; await hooks.save?.(attempts, next); data = structuredClone(next); saves.push(structuredClone(next) as Record<string, unknown>); },
  };
  return { storage, saves, get data() { return data as Record<string, any>; }, set data(v: unknown) { data = v; }, get loads() { return loads; }, get attempts() { return attempts; } };
}

// ---------------------------------------------------------------------------------------------
// Malformed key variants: always fail closed, never write, never regenerate
// ---------------------------------------------------------------------------------------------

describe('guard: malformed stored key variants all fail closed', () => {
  const cases: [string, unknown][] = [
    ['array', []],
    ['array holding a valid-looking field', [VALID]],
    ['empty string', ''],
    ['boolean true', true],
    ['boolean false', false],
    ['zero', 0],
    ['key 63 chars', { v: 1, key: 'a'.repeat(63) }],
    ['key 65 chars', { v: 1, key: 'a'.repeat(65) }],
    ['key empty', { v: 1, key: '' }],
    ['key uppercase hex', { v: 1, key: 'A'.repeat(64) }],
    ['key with trailing newline', { v: 1, key: `${'a'.repeat(64)}\n` }],
    ['key with leading space', { v: 1, key: ` ${'a'.repeat(63)}` }],
    ['key with a NUL', { v: 1, key: `${'a'.repeat(63)}\u0000` }],
    ['key 1 MiB of hex', { v: 1, key: 'a'.repeat(1024 * 1024) }],
    ['key is a number', { v: 1, key: 12345 }],
    ['key is an array of the right string', { v: 1, key: ['ab'.repeat(32)] }],
    ['key is an object with toString', { v: 1, key: { toString: () => 'ab'.repeat(32) } }],
    ['v is the string "1"', { v: '1', key: 'ab'.repeat(32) }],
    ['v is missing', { key: 'ab'.repeat(32) }],
    ['v is 0', { v: 0, key: 'ab'.repeat(32) }],
    ['v is 1.5', { v: 1.5, key: 'ab'.repeat(32) }],
    ['v is an array [1]', { v: [1], key: 'ab'.repeat(32) }],
    ['key under a different name', { v: 1, secret: 'ab'.repeat(32) }],
  ];
  it.each(cases)('rejects malformed and leaves storage untouched (%s)', async (_label, bad) => {
    const m = memory({ keep: 'me', [COMMENTS_KEY_FIELD]: bad });
    const before = JSON.stringify(m.data);
    const guard = createPluginDataGuard(m.storage);
    for (let i = 0; i < 3; i += 1) await expect(guard.getKey()).rejects.toMatchObject({ name: 'InstallKeyError', code: 'malformed' });
    expect(m.attempts, 'no save attempted').toBe(0);
    expect(JSON.stringify(m.data)).toBe(before);
    // settings code can still read its own data and write it back; the broken field is preserved verbatim
    expect(await guard.loadData()).toEqual({ keep: 'me' });
    await guard.saveData({ keep: 'changed' });
    expect(m.data.keep).toBe('changed');
    expect(JSON.stringify(m.data[COMMENTS_KEY_FIELD])).toBe(JSON.stringify(bad));
    await expect(guard.getKey()).rejects.toMatchObject({ code: 'malformed' });
  });

  it('a prototype-named own key and an inherited key field are not read as the key', async () => {
    const inherited = Object.create({ [COMMENTS_KEY_FIELD]: VALID }) as Record<string, unknown>;
    const m = memory(undefined);
    const guard = createPluginDataGuard({ loadData: async () => inherited, saveData: m.storage.saveData });
    const key = await guard.getKey();
    expect(hexOf(key)).not.toBe(VALID.key);
    expect(m.data[COMMENTS_KEY_FIELD].key).toBe(hexOf(key));
  });

  it('Object.prototype carrying the field is ignored (own-property check)', async () => {
    (Object.prototype as Record<string, unknown>)[COMMENTS_KEY_FIELD] = VALID;
    try {
      const m = memory({});
      const key = await createPluginDataGuard(m.storage).getKey();
      expect(hexOf(key)).not.toBe(VALID.key);
      expect(Object.prototype.hasOwnProperty.call(m.data, COMMENTS_KEY_FIELD)).toBe(true);
      expect(m.data[COMMENTS_KEY_FIELD].key).toBe(hexOf(key));
    } finally {
      delete (Object.prototype as Record<string, unknown>)[COMMENTS_KEY_FIELD];
    }
  });

  it('hostile JSON ("__proto__" member) in plugin data does not pollute Object.prototype or change the key', async () => {
    const hostile = JSON.parse(`{"__proto__":{"polluted":true},"theme":"dark","${COMMENTS_KEY_FIELD}":${JSON.stringify(VALID)}}`);
    const m = memory(undefined);
    m.data = hostile;
    const guard = createPluginDataGuard(m.storage);
    expect(hexOf(await guard.getKey())).toBe(VALID.key);
    await guard.saveData(await guard.loadData());
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(m.data[COMMENTS_KEY_FIELD]).toEqual(VALID);
  });

  it('a valid key with extra members is accepted and the extras survive a settings save', async () => {
    const m = memory({ [COMMENTS_KEY_FIELD]: { ...VALID, note: 'x' }, a: 1 });
    const guard = createPluginDataGuard(m.storage);
    expect(hexOf(await guard.getKey())).toBe(VALID.key);
    await guard.saveData({ a: 2 });
    expect(m.data[COMMENTS_KEY_FIELD]).toEqual({ ...VALID, note: 'x' });
  });

  it('a field explicitly set to undefined counts as first use (JSON cannot hold it, so a real file never has it)', async () => {
    const m = memory({ [COMMENTS_KEY_FIELD]: undefined });
    expect(await createPluginDataGuard(m.storage).getKey()).toHaveLength(32);
  });

  it.each([['a string', 'legacy'], ['an array', [1, 2]], ['a number', 42]])('plugin data that is %s is first use, not a crash', async (_l, data) => {
    const m = memory(undefined);
    m.data = data;
    expect(await createPluginDataGuard(m.storage).getKey()).toHaveLength(32);
    expect(m.data[COMMENTS_KEY_FIELD].key).toMatch(HEX64);
  });
});

// ---------------------------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------------------------

describe('guard: concurrency', () => {
  it('200 interleaved getKey, loadData, saveData and update calls with random storage latency: one key, FIFO order, no save ever drops the key', async () => {
    let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const m = memory({ theme: 'start' }, { load: () => sleep(Math.floor(rnd() * 3)), save: () => sleep(Math.floor(rnd() * 3)) });
    const guard = createPluginDataGuard(m.storage, { timeoutMs: 2000 });
    const jobs: Promise<unknown>[] = [];
    const keys: string[] = [];
    let last = 'start';
    for (let i = 0; i < 200; i += 1) {
      const pick = i % 4;
      if (pick === 0) jobs.push(guard.getKey().then((k) => keys.push(hexOf(k))));
      else if (pick === 1) jobs.push(guard.loadData());
      else if (pick === 2) { last = `s${i}`; jobs.push(guard.saveData({ theme: `s${i}`, junk: [i] })); }
      else { last = `u${i}`; jobs.push(guard.update(() => ({ theme: `u${i}` }))); }
    }
    await Promise.all(jobs);
    expect(new Set(keys).size).toBe(1);
    expect(m.data[COMMENTS_KEY_FIELD].key).toBe(keys[0]);
    expect(m.data.theme).toBe(last);
    const firstWithKey = m.saves.findIndex((s) => s[COMMENTS_KEY_FIELD] !== undefined);
    for (const save of m.saves.slice(firstWithKey)) expect(save[COMMENTS_KEY_FIELD], 'a save after key creation lacked the key').toEqual(m.data[COMMENTS_KEY_FIELD]);
  });

  it('saveData before any key exists writes settings only, then getKey adds a key without losing them', async () => {
    const m = memory({});
    const guard = createPluginDataGuard(m.storage);
    await guard.saveData({ theme: 'dark' });
    expect(m.data[COMMENTS_KEY_FIELD]).toBeUndefined();
    const key = await guard.getKey();
    expect(m.data.theme).toBe('dark');
    expect(m.data[COMMENTS_KEY_FIELD].key).toBe(hexOf(key));
  });

  it('a getKey that is queued behind a failing saveData still creates the key afterwards', async () => {
    let failFirst = true;
    const m = memory({}, { save: () => { if (failFirst) { failFirst = false; throw new Error('disk full'); } } });
    const guard = createPluginDataGuard(m.storage);
    const results = await Promise.allSettled([guard.saveData({ a: 1 }), guard.getKey()]);
    expect(results[0].status).toBe('rejected');
    expect(results[1].status).toBe('fulfilled');
    expect(m.data[COMMENTS_KEY_FIELD].key).toMatch(HEX64);
  });

  it('two guards over the same storage that call getKey at once can disagree (documents why there must be exactly one guard)', async () => {
    const m = memory({}, { load: () => sleep(5) });
    const a = createPluginDataGuard(m.storage);
    const b = createPluginDataGuard(m.storage);
    const [ka, kb] = await Promise.all([a.getKey(), b.getKey()]);
    // Not asserting equality: this is the known limit of an in-process serializer. At most one of them matches storage.
    const stored = m.data[COMMENTS_KEY_FIELD].key;
    expect([hexOf(ka), hexOf(kb)].filter((k) => k === stored).length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Hung and failing storage
// ---------------------------------------------------------------------------------------------

describe('guard: hung and failing storage', () => {
  it('saveData is refused (and nothing is written) when the current data cannot be read', async () => {
    const m = memory({ theme: 'dark', [COMMENTS_KEY_FIELD]: VALID });
    let broken = true;
    const guard = createPluginDataGuard({ loadData: () => (broken ? Promise.reject(new Error('EIO')) : m.storage.loadData()), saveData: m.storage.saveData });
    await expect(guard.saveData({ theme: 'light' })).rejects.toMatchObject({ code: 'unreadable' });
    await expect(guard.update((c) => ({ ...c, theme: 'light' }))).rejects.toMatchObject({ code: 'unreadable' });
    expect(m.attempts).toBe(0);
    broken = false;
    await guard.saveData({ theme: 'light' });
    expect(m.data).toEqual({ theme: 'light', [COMMENTS_KEY_FIELD]: VALID });
  });

  it('saveData is refused when loadData hangs (timeout) and the update callback is never invoked', async () => {
    const m = memory({});
    let called = false;
    const guard = createPluginDataGuard({ loadData: never, saveData: m.storage.saveData }, { timeoutMs: 20 });
    await expect(guard.saveData({ a: 1 })).rejects.toMatchObject({ code: 'timeout' });
    await expect(guard.update(() => { called = true; return {}; })).rejects.toMatchObject({ code: 'timeout' });
    expect(called).toBe(false);
    expect(m.attempts).toBe(0);
  });

  it('synchronous throws from storage become unreadable / unwritable, not raw exceptions', async () => {
    const guard = createPluginDataGuard({ loadData: () => { throw new Error('sync'); }, saveData: () => { throw new Error('sync'); } });
    await expect(guard.getKey()).rejects.toMatchObject({ code: 'unreadable' });
    const guard2 = createPluginDataGuard({ loadData: async () => ({}), saveData: () => { throw new Error('sync'); } });
    await expect(guard2.getKey()).rejects.toMatchObject({ code: 'unwritable' });
    await expect(guard2.saveData({})).rejects.toMatchObject({ code: 'unwritable' });
  });

  it('non-Error rejections (strings, undefined) are mapped to InstallKeyError', async () => {
    for (const reason of ['boom', undefined, null, 0]) {
      const guard = createPluginDataGuard({ loadData: () => Promise.reject(reason), saveData: async () => undefined });
      await expect(guard.getKey()).rejects.toBeInstanceOf(InstallKeyError);
    }
  });

  it('a throwing update callback saves nothing and the queue keeps going', async () => {
    const m = memory({ a: 1, [COMMENTS_KEY_FIELD]: VALID });
    const guard = createPluginDataGuard(m.storage);
    await expect(guard.update(() => { throw new Error('caller bug'); })).rejects.toThrow('caller bug');
    expect(m.attempts).toBe(0);
    await guard.update((c) => ({ ...c, a: 2 }));
    expect(m.data.a).toBe(2);
  });

  it('the update callback never sees the key field and cannot change it by mutating its argument', async () => {
    const m = memory({ a: 1, [COMMENTS_KEY_FIELD]: VALID });
    const guard = createPluginDataGuard(m.storage);
    await guard.update((c) => { expect(COMMENTS_KEY_FIELD in c).toBe(false); (c as Record<string, unknown>)[COMMENTS_KEY_FIELD] = 'evil'; return c; });
    expect(m.data[COMMENTS_KEY_FIELD]).toEqual(VALID);
  });

  it('500 settings saves with hostile shapes never remove or alter a stored key', async () => {
    const m = memory({ [COMMENTS_KEY_FIELD]: VALID });
    const guard = createPluginDataGuard(m.storage);
    const shapes: unknown[] = [{}, null, undefined, 'x', 7, [], [1], { [COMMENTS_KEY_FIELD]: null }, { [COMMENTS_KEY_FIELD]: 'evil' }, { [COMMENTS_KEY_FIELD]: { v: 1, key: 'f'.repeat(64) } }, JSON.parse('{"__proto__":{"x":1}}')];
    for (let i = 0; i < 500; i += 1) await guard.saveData(shapes[i % shapes.length]);
    expect(m.data[COMMENTS_KEY_FIELD]).toEqual(VALID);
    expect(hexOf(await guard.getKey())).toBe(VALID.key);
  });

  it('observed: saveData of a non-object replaces the settings with {} (key kept); callers are expected to pass an object', async () => {
    const m = memory({ theme: 'dark', [COMMENTS_KEY_FIELD]: VALID });
    await createPluginDataGuard(m.storage).saveData('oops');
    expect(m.data).toEqual({ [COMMENTS_KEY_FIELD]: VALID });
  });

  it('observed: an injected generate() of the wrong length persists a key the next start reads as malformed', async () => {
    const m = memory({});
    const key = await createPluginDataGuard(m.storage, { generate: () => new Uint8Array(16).fill(3) }).getKey();
    expect(key).toHaveLength(16);
    await expect(createPluginDataGuard(m.storage).getKey()).rejects.toMatchObject({ code: 'malformed' });
  });

  it('a throwing generate() rejects that call only', async () => {
    const m = memory({});
    let boom = true;
    const guard = createPluginDataGuard(m.storage, { generate: () => { if (boom) throw new Error('rng'); return new Uint8Array(32).fill(5); } });
    await expect(guard.getKey()).rejects.toThrow('rng');
    expect(m.attempts).toBe(0);
    boom = false;
    expect(hexOf(await guard.getKey())).toBe('05'.repeat(32));
  });

  it('BUG: a key save that timed out and lands late cannot replace the key a later getKey created and handed out', async () => {
    // First saveData is slow (120 ms) and times out at 30 ms. The retry reads the file before the slow
    // write lands, creates key B and saves it. The slow write then lands and puts key A on disk, while
    // B (in memory) already signed comments. After a restart the plugin reads A and every comment is foreign.
    const m = memory({}, { save: (n) => (n === 1 ? sleep(120) : undefined) });
    let n = 0;
    const guard = createPluginDataGuard(m.storage, { timeoutMs: 30, generate: () => new Uint8Array(32).fill(++n) });
    await expect(guard.getKey()).rejects.toMatchObject({ code: 'timeout' });
    const handedOut = hexOf(await guard.getKey());
    await sleep(250);
    const restarted = hexOf(await createPluginDataGuard(m.storage).getKey());
    expect(restarted, 'the key on disk after the late write differs from the key used this session').toBe(handedOut);
  });

  it('a timed-out settings save that lands late does not revert a newer settings save', async () => {
    const m = memory({ [COMMENTS_KEY_FIELD]: VALID }, { save: (n) => (n === 1 ? sleep(120) : undefined) });
    const guard = createPluginDataGuard(m.storage, { timeoutMs: 30 });
    await expect(guard.saveData({ v: 'old' })).rejects.toMatchObject({ code: 'timeout' });
    await guard.saveData({ v: 'new' });
    await sleep(250);
    expect(m.data.v).toBe('new');
  });
});

// ---------------------------------------------------------------------------------------------
// Store: key timeout and poll overlap
// ---------------------------------------------------------------------------------------------

describe('store: key timeout and poll overlap', () => {
  let base: string;
  let root: string;
  const handles: CommentRootHandle[] = [];
  const clock = { t: Date.parse(NOW) };
  beforeEach(async () => {
    base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'td-keyqa-')));
    root = path.join(base, 'artifact');
    await fs.mkdir(root);
  });
  afterEach(async () => {
    for (const h of handles.splice(0)) h.dispose();
    await fs.rm(base, { recursive: true, force: true });
  });
  const reason = <T,>(r: ArtifactCommentsResult<T>) => (r.status === 'rejected' ? r.reason : 'ok');
  async function open(extra: Partial<CommentStoreOptions> = {}) {
    const h = await createCommentStore({ keys: { getKey: async () => KEY }, now: () => new Date(clock.t), pluginVersion: 'qa', ...extra }).open({ root, artifactId: ARTIFACT_ID });
    handles.push(h);
    return h;
  }

  it('a key that resolves after the store gave up is not used for that call, and the next call gets it', async () => {
    let calls = 0;
    const h = await open({ keyTimeoutMs: 25, keys: { getKey: async () => { calls += 1; if (calls === 1) { await sleep(80); } return KEY; } } });
    expect((await h.snapshot()).health).toBe('unavailable');
    await sleep(120);
    expect(await fs.readdir(root)).toEqual([]);
    expect((await h.snapshot()).health).toBe('ok');
    expect(reason(await h.create(pinDraft(1)))).toBe('ok');
  });

  it('a getKey that throws synchronously, rejects with a non-Error, or hangs all leave the store unavailable and write nothing', async () => {
    for (const getKey of [() => { throw new Error('sync'); }, () => Promise.reject('str'), () => Promise.reject(undefined), never] as (() => Promise<Uint8Array>)[]) {
      const h = await open({ keyTimeoutMs: 20, keys: { getKey } });
      expect((await h.snapshot()).health).toBe('unavailable');
      expect(reason(await h.create(pinDraft(1)))).toBe('unavailable');
      h.dispose();
    }
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('the guard feeding the store: hung loadData surfaces as unavailable within the guard timeout and recovers', async () => {
    let hang = true;
    const m = memory({});
    const guard = createPluginDataGuard({ loadData: () => (hang ? never() : m.storage.loadData()), saveData: m.storage.saveData }, { timeoutMs: 25 });
    const started = Date.now();
    const h = await open({ keys: guard, keyTimeoutMs: 1000 });
    expect(Date.now() - started).toBeLessThan(900);
    expect((await h.snapshot()).health).toBe('unavailable');
    hang = false;
    expect((await h.snapshot()).health).toBe('ok');
    expect(reason(await h.create(pinDraft(1)))).toBe('ok');
    expect(m.data[COMMENTS_KEY_FIELD].key).toMatch(HEX64);
  });

  it('while the key is hung, concurrent operations each fail within roughly one timeout (no unbounded queue)', async () => {
    const h = await open({ keyTimeoutMs: 30, keys: { getKey: never } });
    const started = Date.now();
    const results = await Promise.all([h.create(pinDraft(1)), h.create(pinDraft(2)), h.snapshot(), h.adopt([]), h.protectedSelectionIds().catch(() => 'rej')]);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(reason(results[0] as ArtifactCommentsResult<unknown>)).toBe('unavailable');
  });

  it('50 simultaneous polls run one freshen; a failing poll does not wedge the flag; the next tick runs', async () => {
    const seed = await open();
    await seed.create(pinDraft(1));
    seed.dispose();
    let lstats = 0;
    let armed = false;
    let fail = false;
    const real = defaultStoreFsOps;
    const ops = { ...real, lstat: async (p: string) => { if (armed) { lstats += 1; await sleep(15); if (fail) throw new Error('EIO'); } return real.lstat(p); } } as unknown as CommentStoreOptions['ops'];
    const h = await open({ ops });
    armed = true;
    await Promise.all(Array.from({ length: 50 }, () => h.poll()));
    const one = lstats;
    expect(one).toBeGreaterThan(0);
    expect(one).toBeLessThanOrEqual(4);
    fail = true;
    await h.poll();
    fail = false;
    const before = lstats;
    await h.poll();
    expect(lstats, 'a poll after a failed poll must still run').toBeGreaterThan(before);
  });

  it('a poll dropped while another is running does not lose an external edit: the next tick sees it', async () => {
    const seed = await open();
    await seed.create(pinDraft(1));
    const h = await open();
    const other = await open();
    const changes: string[] = [];
    h.subscribe((c) => changes.push(c.reason));
    await other.create(pinDraft(2));
    await Promise.all([h.poll(), h.poll(), h.poll()]);
    await h.poll();
    expect((await h.snapshot()).comments).toHaveLength(2);
  });

  it('poll after dispose is harmless', async () => {
    const h = await open();
    h.dispose();
    await expect(h.poll()).resolves.toBeUndefined();
    await expect(h.poll()).resolves.toBeUndefined();
  });

  it('the key timeout timer is cleared on success (no timer left behind)', async () => {
    const active = (process as unknown as { getActiveResourcesInfo(): string[] }).getActiveResourcesInfo;
    const timersBefore = active.call(process).filter((r) => r === 'Timeout').length;
    const h = await open({ keyTimeoutMs: 60_000 });
    await h.snapshot();
    const timersAfter = active.call(process).filter((r) => r === 'Timeout').length;
    expect(timersAfter).toBeLessThanOrEqual(timersBefore);
    fsSync.existsSync(root);
  });
});
