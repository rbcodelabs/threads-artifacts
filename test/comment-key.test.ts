import { describe, expect, it } from 'vitest';
import { COMMENTS_KEY_FIELD, createInstallKeyProvider } from '../src/commentKey';

function memoryStorage(initial: unknown = null) {
  let data: unknown = initial;
  const saves: unknown[] = [];
  return {
    saves,
    get data() { return data; },
    loadData: async () => data,
    saveData: async (next: unknown) => { data = structuredClone(next); saves.push(structuredClone(next)); },
  };
}

const HEX64 = /^[0-9a-f]{64}$/;

describe('install key kept in plugin data', () => {
  it('creates 32 random bytes on first use and saves them under the plugin data, keeping other fields', async () => {
    const storage = memoryStorage({ theme: 'dark' });
    const key = await createInstallKeyProvider(storage).getKey();
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key).toHaveLength(32);
    const saved = storage.data as Record<string, unknown>;
    expect(saved.theme).toBe('dark');
    const field = saved[COMMENTS_KEY_FIELD] as { v: number; key: string };
    expect(field.v).toBe(1);
    expect(field.key).toMatch(HEX64);
    expect(Buffer.from(key).toString('hex')).toBe(field.key);
  });

  it('reuses the stored key without saving again, across providers', async () => {
    const storage = memoryStorage(null);
    const first = await createInstallKeyProvider(storage).getKey();
    const second = await createInstallKeyProvider(storage).getKey();
    expect(Buffer.from(second).toString('hex')).toBe(Buffer.from(first).toString('hex'));
    expect(storage.saves).toHaveLength(1);
  });

  it('shares one creation between concurrent callers', async () => {
    const storage = memoryStorage(undefined);
    const provider = createInstallKeyProvider(storage);
    const keys = await Promise.all([provider.getKey(), provider.getKey(), provider.getKey()]);
    expect(new Set(keys.map((k) => Buffer.from(k).toString('hex'))).size).toBe(1);
    expect(storage.saves).toHaveLength(1);
  });

  it.each([
    ['short key', { v: 1, key: 'ab' }],
    ['non-hex key', { v: 1, key: 'z'.repeat(64) }],
    ['wrong version', { v: 2, key: 'a'.repeat(64) }],
    ['wrong type', 'nope'],
    ['null', null],
  ])('replaces an invalid stored value (%s) with a fresh key', async (_label, bad) => {
    const storage = memoryStorage({ keep: 1, [COMMENTS_KEY_FIELD]: bad });
    const key = await createInstallKeyProvider(storage).getKey();
    expect(key).toHaveLength(32);
    expect((storage.data as Record<string, unknown>).keep).toBe(1);
    expect(((storage.data as Record<string, { key: string }>)[COMMENTS_KEY_FIELD]).key).toMatch(HEX64);
  });

  it('treats non-object plugin data as empty', async () => {
    for (const data of ['text', 5, [], null, undefined]) {
      const storage = memoryStorage(data);
      expect(await createInstallKeyProvider(storage).getKey()).toHaveLength(32);
    }
  });

  it('rejects when plugin data cannot be loaded or saved, and retries next time', async () => {
    let fail = true;
    let data: unknown = {};
    const storage = {
      loadData: async () => { if (fail) throw new Error('disk'); return data; },
      saveData: async (next: unknown) => { if (fail) throw new Error('disk'); data = next; },
    };
    const provider = createInstallKeyProvider(storage);
    await expect(provider.getKey()).rejects.toThrow();
    fail = false;
    expect(await provider.getKey()).toHaveLength(32);
  });

  it('returns a copy so a caller cannot change the key in place', async () => {
    const provider = createInstallKeyProvider(memoryStorage(null));
    const a = await provider.getKey();
    a.fill(0);
    const b = await provider.getKey();
    expect(Buffer.from(b).toString('hex')).not.toBe('0'.repeat(64));
  });
});
