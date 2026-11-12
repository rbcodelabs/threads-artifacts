import { randomBytes } from 'node:crypto';

/**
 * The install key used to sign comments (spec 13e, design section 2.1), and the ONLY path through
 * which the plugin may read or write its data (`loadData`/`saveData`).
 *
 * Why one path: the key lives in the plugin's own data next to its settings. If any other code calls
 * `saveData(settings)` with an object that lacks the key field, the next start would mint a new key
 * and every existing comment would verify as foreign. So all plugin data access goes through this
 * guard: `loadData` never exposes the key field, `saveData` and `update` serialize with key creation,
 * read the current data first, and always re-insert the stored key, whatever the caller passes.
 * P2a must route the plugin's settings load/save through `createPluginDataGuard(...)` and never call
 * the raw `loadData/saveData` again.
 *
 * Fail closed: a key field that is present but malformed is an error (`malformed`), never replaced,
 * because replacing it would silently turn every existing comment foreign. Only a missing field is
 * first use. A hung or failing storage call rejects (`timeout`, `unreadable`, `unwritable`) and is
 * retried on the next call; an unsaved key is never handed out.
 */

export const COMMENTS_KEY_FIELD = 'commentsInstallKey';
const DEFAULT_TIMEOUT_MS = 5000;
const HEX_KEY = /^[0-9a-f]{64}$/;

export type InstallKeyErrorCode = 'malformed' | 'unreadable' | 'unwritable' | 'timeout' | 'busy' | 'invalid';

export class InstallKeyError extends Error {
  constructor(readonly code: InstallKeyErrorCode, message: string) {
    super(message);
    this.name = 'InstallKeyError';
  }
}

export interface PluginDataStorage {
  loadData(): Promise<unknown>;
  saveData(data: unknown): Promise<void>;
}

export interface InstallKeyProvider {
  /** A fresh copy each call. Rejects with InstallKeyError; the store treats any rejection as unavailable. */
  getKey(): Promise<Uint8Array>;
}

export interface PluginDataGuard extends InstallKeyProvider {
  /** Plugin data without the key field. */
  loadData(): Promise<Record<string, unknown>>;
  /** Saves `next` with the stored key re-inserted; a caller-supplied key field is ignored. */
  saveData(next: unknown): Promise<void>;
  /** Atomic read-modify-write of the plugin data (key field hidden from `fn`, preserved on write). */
  update(fn: (current: Record<string, unknown>) => Record<string, unknown>): Promise<void>;
}

export interface GuardOptions {
  readonly generate?: () => Uint8Array;
  /** Per storage call. Default 5000. */
  readonly timeoutMs?: number;
  /**
   * How long a call waits for an earlier SAVE that timed out but has not settled yet. Until that save
   * settles (or this wait runs out, which refuses the call as `busy`) nothing else runs: a late write
   * must never land on top of a newer key or settings object. Default 6 x timeoutMs.
   */
  readonly maxQueueWaitMs?: number;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};

const keyFieldOf = (key: Uint8Array) => ({ v: 1, key: Buffer.from(key).toString('hex') });

/** Saving anything but a plain object would reduce the settings to {}: refuse instead. */
function plain(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new InstallKeyError('invalid', message);
  return { ...(value as Record<string, unknown>) };
}

type Parsed = { state: 'absent' } | { state: 'valid'; key: Uint8Array } | { state: 'malformed' };
function parseKeyField(data: Record<string, unknown>): Parsed {
  if (!Object.prototype.hasOwnProperty.call(data, COMMENTS_KEY_FIELD) || data[COMMENTS_KEY_FIELD] === undefined) return { state: 'absent' };
  const field = data[COMMENTS_KEY_FIELD];
  if (typeof field === 'object' && field !== null && (field as { v?: unknown }).v === 1) {
    const key = (field as { key?: unknown }).key;
    if (typeof key === 'string' && HEX_KEY.test(key)) return { state: 'valid', key: Uint8Array.from(Buffer.from(key, 'hex')) };
  }
  return { state: 'malformed' };
}

export function createPluginDataGuard(storage: PluginDataStorage, options: GuardOptions = {}): PluginDataGuard {
  const generate = options.generate ?? (() => randomBytes(32));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxQueueWaitMs = options.maxQueueWaitMs ?? timeoutMs * 6;
  let cached: Uint8Array | null = null;
  let tail: Promise<void> = Promise.resolve();
  /** The latest save that timed out and has not settled yet. */
  let stalledWrite: Promise<void> | null = null;

  const waitForStalledWrite = async (): Promise<void> => {
    const stalled = stalledWrite;
    if (stalled === null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const gaveUp = new Promise<'busy'>((resolve) => { timer = setTimeout(() => resolve('busy'), maxQueueWaitMs); });
    const outcome = await Promise.race([stalled.then(() => 'settled' as const), gaveUp]);
    if (timer !== undefined) clearTimeout(timer);
    if (outcome === 'busy' && stalledWrite === stalled) throw new InstallKeyError('busy', 'An earlier save of plugin data is still in progress.');
  };

  /** Runs one job at a time. A failed or timed-out job never blocks the ones after it. */
  const serial = <T,>(job: () => Promise<T>): Promise<T> => {
    const result = tail.then(async () => { await waitForStalledWrite(); return job(); });
    tail = result.then(() => undefined, () => undefined);
    return result;
  };

  const bounded = <T,>(call: () => Promise<T>, code: 'unreadable' | 'unwritable', what: string): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      let started: Promise<T>;
      try {
        started = call();
      } catch {
        reject(new InstallKeyError(code, `Plugin data could not be ${what}.`));
        return;
      }
      const timer = setTimeout(() => {
        if (code === 'unwritable') {
          // A save we gave up on may still land later: hold the queue until it settles.
          const settled = started.then(() => undefined, () => undefined).then(() => { if (stalledWrite === settled) stalledWrite = null; });
          stalledWrite = settled;
        }
        reject(new InstallKeyError('timeout', `Reading or saving plugin data timed out (${what}).`));
      }, timeoutMs);
      started.then(
        (value) => { clearTimeout(timer); resolve(value); },
        () => { clearTimeout(timer); reject(new InstallKeyError(code, `Plugin data could not be ${what}.`)); },
      );
    });

  const read = async (): Promise<Record<string, unknown>> => asRecord(await bounded(() => storage.loadData(), 'unreadable', 'read'));

  /** Writes `next` (key field removed from the caller's view) with the key field that is stored, or the one we created this session. */
  const write = async (stored: Record<string, unknown>, next: Record<string, unknown>): Promise<void> => {
    const out = { ...next };
    delete out[COMMENTS_KEY_FIELD];
    if (Object.prototype.hasOwnProperty.call(stored, COMMENTS_KEY_FIELD) && stored[COMMENTS_KEY_FIELD] !== undefined) out[COMMENTS_KEY_FIELD] = stored[COMMENTS_KEY_FIELD];
    else if (cached !== null) out[COMMENTS_KEY_FIELD] = keyFieldOf(cached);
    await bounded(() => storage.saveData(out), 'unwritable', 'saved');
  };

  const withoutKey = (data: Record<string, unknown>): Record<string, unknown> => {
    const copy = { ...data };
    delete copy[COMMENTS_KEY_FIELD];
    return copy;
  };

  return {
    getKey() {
      return serial(async () => {
        if (cached !== null) return Uint8Array.from(cached);
        const stored = await read();
        const parsed = parseKeyField(stored);
        if (parsed.state === 'malformed') throw new InstallKeyError('malformed', 'The stored signing key is damaged, so Design will not sign or verify comments.');
        if (parsed.state === 'valid') { cached = parsed.key; return Uint8Array.from(cached); }
        const created = Uint8Array.from(generate());
        if (created.length !== 32) throw new InstallKeyError('invalid', 'The generated signing key has the wrong length.');
        // Saved before it is used: a key that was not persisted would orphan whatever it signed.
        await bounded(() => storage.saveData({ ...stored, [COMMENTS_KEY_FIELD]: keyFieldOf(created) }), 'unwritable', 'saved');
        cached = created;
        return Uint8Array.from(created);
      });
    },
    loadData() {
      return serial(async () => withoutKey(await read()));
    },
    saveData(next: unknown) {
      return serial(async () => write(await read(), plain(next, 'Plugin data must be an object.')));
    },
    update(fn) {
      return serial(async () => {
        const stored = await read();
        await write(stored, plain(fn(withoutKey(stored)), 'The update must return an object.'));
      });
    },
  };
}
