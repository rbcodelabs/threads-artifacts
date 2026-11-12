import { describe, expect, it } from 'vitest';
import { COMMENTS_KEY_FIELD, createPluginDataGuard, InstallKeyError } from '../src/commentKey';

function memoryStorage(initial: unknown = null, hooks: { delayLoad?: () => Promise<void>; delaySave?: () => Promise<void> } = {}) {
  let data: unknown = initial === null || initial === undefined ? initial : structuredClone(initial);
  const saves: unknown[] = [];
  return {
    saves,
    get data() { return data; },
    set data(next: unknown) { data = next; },
    loadData: async () => { await hooks.delayLoad?.(); return data === undefined || data === null ? data : structuredClone(data); },
    saveData: async (next: unknown) => { await hooks.delaySave?.(); data = structuredClone(next); saves.push(structuredClone(next)); },
  };
}

const HEX64 = /^[0-9a-f]{64}$/;
const hexOf = (key: Uint8Array) => Buffer.from(key).toString('hex');
const storedKey = (storage: { data: unknown }) => ((storage.data as Record<string, { key: string }>)[COMMENTS_KEY_FIELD] ?? { key: undefined }).key;

describe('install key: creation and reuse', () => {
  it('creates 32 random bytes on first use and saves them under the plugin data, keeping other fields', async () => {
    const storage = memoryStorage({ theme: 'dark' });
    const key = await createPluginDataGuard(storage).getKey();
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key).toHaveLength(32);
    const saved = storage.data as Record<string, unknown>;
    expect(saved.theme).toBe('dark');
    const field = saved[COMMENTS_KEY_FIELD] as { v: number; key: string };
    expect(field.v).toBe(1);
    expect(field.key).toMatch(HEX64);
    expect(hexOf(key)).toBe(field.key);
  });

  it('treats a missing field and non-object plugin data as first use', async () => {
    for (const data of [undefined, null, {}, { other: 1 }]) {
      const storage = memoryStorage(data);
      expect(await createPluginDataGuard(storage).getKey()).toHaveLength(32);
      expect(storedKey(storage)).toMatch(HEX64);
    }
  });

  it('reuses the stored key without saving again, across guards', async () => {
    const storage = memoryStorage(null);
    const first = await createPluginDataGuard(storage).getKey();
    const second = await createPluginDataGuard(storage).getKey();
    expect(hexOf(second)).toBe(hexOf(first));
    expect(storage.saves).toHaveLength(1);
  });

  it('shares one creation between concurrent callers', async () => {
    const storage = memoryStorage(undefined);
    const guard = createPluginDataGuard(storage);
    const keys = await Promise.all([guard.getKey(), guard.getKey(), guard.getKey()]);
    expect(new Set(keys.map(hexOf)).size).toBe(1);
    expect(storage.saves).toHaveLength(1);
  });

  it('returns a copy so a caller cannot change the key in place', async () => {
    const guard = createPluginDataGuard(memoryStorage(null));
    const a = await guard.getKey();
    a.fill(0);
    expect(hexOf(await guard.getKey())).not.toBe('0'.repeat(64));
  });
});

describe('install key: fails closed (regenerating would turn every existing comment foreign)', () => {
  it.each([
    ['short key', { v: 1, key: 'ab' }],
    ['non-hex key', { v: 1, key: 'z'.repeat(64) }],
    ['wrong version', { v: 2, key: 'a'.repeat(64) }],
    ['wrong type', 'nope'],
    ['null', null],
    ['number', 5],
    ['empty object', {}],
  ])('rejects with code malformed and leaves the stored value untouched (%s)', async (_label, bad) => {
    const storage = memoryStorage({ keep: 1, [COMMENTS_KEY_FIELD]: bad });
    const guard = createPluginDataGuard(storage);
    await expect(guard.getKey()).rejects.toMatchObject({ name: 'InstallKeyError', code: 'malformed' });
    await expect(guard.getKey()).rejects.toBeInstanceOf(InstallKeyError);
    expect(storage.saves).toEqual([]);
    expect((storage.data as Record<string, unknown>)[COMMENTS_KEY_FIELD]).toEqual(bad);
  });

  it('rejects with code unreadable when plugin data cannot be loaded, and retries next time', async () => {
    let fail = true;
    const storage = memoryStorage({});
    const guard = createPluginDataGuard({
      loadData: async () => { if (fail) throw new Error('disk'); return storage.loadData(); },
      saveData: storage.saveData,
    });
    await expect(guard.getKey()).rejects.toMatchObject({ code: 'unreadable' });
    fail = false;
    expect(await guard.getKey()).toHaveLength(32);
  });

  it('rejects with code unwritable when the new key cannot be saved, and never hands out an unsaved key', async () => {
    let fail = true;
    const storage = memoryStorage({});
    const guard = createPluginDataGuard({
      loadData: storage.loadData,
      saveData: async (next) => { if (fail) throw new Error('disk full'); return storage.saveData(next); },
    });
    await expect(guard.getKey()).rejects.toMatchObject({ code: 'unwritable' });
    fail = false;
    const key = await guard.getKey();
    expect(storedKey(storage)).toBe(hexOf(key));
  });

  it('a key seen earlier in the session that later vanishes from storage is not silently replaced', async () => {
    const storage = memoryStorage(null);
    const guard = createPluginDataGuard(storage);
    const key = await guard.getKey();
    storage.data = { settingsOnly: true }; // somebody wrote plugin data around the guard
    expect(hexOf(await guard.getKey())).toBe(hexOf(key));
    await guard.saveData({ settingsOnly: true });
    expect(storedKey(storage)).toBe(hexOf(key));
  });
});

describe('plugin data guard: the only saveData path', () => {
  it('loadData never exposes the key field, so settings code cannot hold or write it', async () => {
    const storage = memoryStorage({ theme: 'dark' });
    const guard = createPluginDataGuard(storage);
    await guard.getKey();
    expect(await guard.loadData()).toEqual({ theme: 'dark' });
  });

  it('saveData keeps the key when the caller omits it', async () => {
    const storage = memoryStorage({ theme: 'dark' });
    const guard = createPluginDataGuard(storage);
    const key = await guard.getKey();
    await guard.saveData({ theme: 'light' });
    expect(storage.data).toMatchObject({ theme: 'light' });
    expect(storedKey(storage)).toBe(hexOf(key));
    await guard.saveData(null);
    expect(storedKey(storage)).toBe(hexOf(key));
  });

  it('saveData ignores a caller-supplied value for the key field', async () => {
    const storage = memoryStorage(null);
    const guard = createPluginDataGuard(storage);
    const key = await guard.getKey();
    await guard.saveData({ theme: 'x', [COMMENTS_KEY_FIELD]: { v: 1, key: 'f'.repeat(64) } });
    expect(storedKey(storage)).toBe(hexOf(key));
    await guard.saveData({ [COMMENTS_KEY_FIELD]: 'garbage' });
    expect(storedKey(storage)).toBe(hexOf(key));
  });

  it('a settings save that races key creation keeps both the settings and the key', async () => {
    const storage = memoryStorage({ theme: 'dark' });
    const guard = createPluginDataGuard(storage);
    const [key] = await Promise.all([guard.getKey(), guard.saveData({ theme: 'light', extra: 1 })]);
    expect(storage.data).toMatchObject({ theme: 'light', extra: 1 });
    expect(storedKey(storage)).toBe(hexOf(key));
  });

  it('a burst of concurrent settings saves and key reads ends with the last settings and exactly one key', async () => {
    const storage = memoryStorage({}, { delaySave: () => new Promise((r) => setTimeout(r, 2)), delayLoad: () => new Promise((r) => setTimeout(r, 1)) });
    const guard = createPluginDataGuard(storage);
    const keys: Uint8Array[] = [];
    const jobs: Promise<unknown>[] = [];
    for (let i = 0; i < 10; i += 1) {
      jobs.push(guard.saveData({ n: i }));
      jobs.push(guard.getKey().then((k) => keys.push(k)));
    }
    await Promise.all(jobs);
    expect((storage.data as { n: number }).n).toBe(9);
    expect(new Set(keys.map(hexOf)).size).toBe(1);
    expect(storedKey(storage)).toBe(hexOf(keys[0]));
  });

  it('update is an atomic read-modify-write: concurrent updates all land and the key survives', async () => {
    const storage = memoryStorage({ count: 0 }, { delaySave: () => new Promise((r) => setTimeout(r, 1)) });
    const guard = createPluginDataGuard(storage);
    const key = await guard.getKey();
    await Promise.all(Array.from({ length: 20 }, () => guard.update((current) => ({ ...current, count: (current.count as number) + 1 }))));
    expect((storage.data as { count: number }).count).toBe(20);
    expect(storedKey(storage)).toBe(hexOf(key));
  });

  it('saveData refuses to write when the current plugin data cannot be read (it would clobber blind)', async () => {
    const storage = memoryStorage({ theme: 'dark' });
    const guard = createPluginDataGuard({ loadData: async () => { throw new Error('disk'); }, saveData: storage.saveData });
    await expect(guard.saveData({ theme: 'light' })).rejects.toMatchObject({ code: 'unreadable' });
    expect(storage.saves).toEqual([]);
  });

  it('saveData preserves a malformed stored key field as it is instead of overwriting it', async () => {
    const storage = memoryStorage({ [COMMENTS_KEY_FIELD]: { v: 1, key: 'bad' } });
    const guard = createPluginDataGuard(storage);
    await guard.saveData({ theme: 'x' });
    expect((storage.data as Record<string, unknown>)[COMMENTS_KEY_FIELD]).toEqual({ v: 1, key: 'bad' });
  });
});

describe('plugin data guard: timeouts', () => {
  const never = () => new Promise<never>(() => undefined);

  it('getKey rejects with code timeout when loadData hangs, and works once storage answers again', async () => {
    let hang = true;
    const storage = memoryStorage({});
    const guard = createPluginDataGuard({ loadData: () => (hang ? never() : storage.loadData()), saveData: storage.saveData }, { timeoutMs: 25 });
    const started = Date.now();
    await expect(guard.getKey()).rejects.toMatchObject({ code: 'timeout' });
    expect(Date.now() - started).toBeLessThan(1000);
    hang = false;
    expect(await guard.getKey()).toHaveLength(32);
  });

  it('getKey rejects with code timeout when saveData hangs', async () => {
    const storage = memoryStorage({});
    const guard = createPluginDataGuard({ loadData: storage.loadData, saveData: () => never() }, { timeoutMs: 25 });
    await expect(guard.getKey()).rejects.toMatchObject({ code: 'timeout' });
  });

  it('a hung operation does not block the queue forever: later calls still run', async () => {
    let hang = true;
    const storage = memoryStorage({ a: 1 });
    const guard = createPluginDataGuard({ loadData: () => (hang ? never() : storage.loadData()), saveData: storage.saveData }, { timeoutMs: 25 });
    await expect(guard.loadData()).rejects.toMatchObject({ code: 'timeout' });
    hang = false;
    expect(await guard.loadData()).toEqual({ a: 1 });
  });
});
