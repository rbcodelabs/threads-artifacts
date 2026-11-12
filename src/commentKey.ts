import { randomBytes } from 'node:crypto';

/**
 * The install key used to sign comments (spec 13e, design section 2.1). 32 random bytes created on
 * first use and kept in the plugin's own data (`loadData`/`saveData`), never in an artifact: a
 * `comments.json` copied from another machine or hand-edited therefore fails verification and shows
 * up as foreign instead of being trusted.
 */

export const COMMENTS_KEY_FIELD = 'commentsInstallKey';

export interface PluginDataStorage {
  loadData(): Promise<unknown>;
  saveData(data: unknown): Promise<void>;
}

export interface InstallKeyProvider {
  /** A fresh copy each call, so a caller cannot change the key in place. Rejects when plugin data cannot be read or written. */
  getKey(): Promise<Uint8Array>;
}

const HEX_KEY = /^[0-9a-f]{64}$/;

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

export function createInstallKeyProvider(storage: PluginDataStorage, generate: () => Uint8Array = () => randomBytes(32)): InstallKeyProvider {
  let cached: Uint8Array | null = null;
  let pending: Promise<Uint8Array> | null = null;

  const resolve = async (): Promise<Uint8Array> => {
    const data = asRecord(await storage.loadData());
    const stored = asRecord(data[COMMENTS_KEY_FIELD]);
    if (stored.v === 1 && typeof stored.key === 'string' && HEX_KEY.test(stored.key)) return Uint8Array.from(Buffer.from(stored.key, 'hex'));
    const key = Uint8Array.from(generate());
    await storage.saveData({ ...data, [COMMENTS_KEY_FIELD]: { v: 1, key: Buffer.from(key).toString('hex') } });
    return key;
  };

  return {
    async getKey() {
      if (cached === null) {
        // One in-flight creation shared by concurrent callers; a failure is not cached, so the next call retries.
        pending ??= resolve().finally(() => { pending = null; });
        cached = await pending;
      }
      return Uint8Array.from(cached);
    },
  };
}
