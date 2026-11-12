import { constants as fsConstants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import {
  applyEvent,
  COMMENTS_FILE_KIND,
  COMMENTS_SCHEMA_VERSION,
  bodySha256,
  canonicalJson,
  createStoredComment,
  isCommentId,
  isRequestId,
  MAX_COMMENTS,
  MAX_READ_BYTES,
  MAX_WRITE_BYTES,
  mergeBodies,
  MIGRATIONS,
  migrate,
  nextStatus,
  normalizeCommentsFile,
  salvageComments,
  signComment,
  SYSTEM_EVENTS,
  toPublicComment,
  validatePinDraft,
  verifyComment,
} from './commentModel';
import type { CommentsBody, CommentsFile, Migration, NormalizeResult, StoredComment, SystemEvent } from './commentModel';
import { defaultOps, ensureRealDirectory, lstatOrNull, SelectionFileError, SIDECAR_DIR } from './selectionFiles';
import type { FsOps } from './selectionFiles';
import { ARTIFACT_COMMENTS_CAPS } from './geodeArtifactFeedbackV2';
import type {
  ArtifactComment,
  ArtifactCommentProvenance,
  ArtifactCommentsChange,
  ArtifactCommentsChangeReason,
  ArtifactCommentsRejectReason,
  ArtifactCommentsResult,
  ArtifactCommentsSnapshot,
  RemoveCommentInput,
  UpdateCommentInput,
} from './geodeArtifactFeedbackV2';

/**
 * `<artifact root>/.threads-design/comments.json`: the only writer of the pinned-comments file
 * (design sections 2.1 to 2.6, threats T5 to T8). Not wired into any handler yet (P2a does that).
 *
 * The invariant: the store never overwrites a file it could not fully read without first
 * quarantining it, and never silently drops a comment that was valid. Every filesystem path is built
 * from the real root plus fixed names or regex-validated ids; symlinks, hard links and non-regular
 * files are never followed.
 */

export type StoreFsOps = FsOps;
export const defaultStoreFsOps: StoreFsOps = defaultOps;

const COMMENTS_FILE = 'comments.json';
const PREV_FILE = 'comments.prev.json';
const TMP_FILE = /^comments\.[0-9a-f]{16}\.tmp$/;
const QUARANTINE_FILE = /^comments\.corrupt-(\d{8}T\d{9}Z)(?:-(\d+))?\.json$/;
const QUARANTINE_KEEP = 3;
const STALE_TEMP_MS = 60 * 60 * 1000;
const MAX_WRITE_ATTEMPTS = 4; // the first write plus three merge retries
const POLL_MS = 5000;
const NOTICE_MAX = ARTIFACT_COMMENTS_CAPS.maxNoticeUnits;

export type StoreHealth = 'ok' | 'recovered' | 'read-only' | 'unavailable';

export interface Timers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface CommentStoreOptions {
  /** The install key used to sign comments. A rejection makes the store unavailable. */
  readonly keys: { getKey(): Promise<Uint8Array> };
  readonly ops?: StoreFsOps;
  readonly now?: () => Date;
  /** Recorded in the file as `writtenBy`. */
  readonly pluginVersion?: string;
  readonly timers?: Timers;
  readonly pollIntervalMs?: number;
  readonly schema?: { readonly current: number; readonly migrations: Readonly<Record<number, Migration>> };
  readonly limits?: { readonly maxWriteBytes?: number; readonly maxReadBytes?: number };
  readonly randomHex?: (bytes: number) => string;
  /** How long to wait for the signing key before the store reports itself unavailable. Default 5000. */
  readonly keyTimeoutMs?: number;
}

export interface OpenTarget {
  /** Artifact root as given to the view; resolved with the native realpath here. */
  readonly root: string;
  /** `manifest.id`. */
  readonly artifactId: string;
}

export interface SystemTransition {
  readonly id: string;
  readonly event: SystemEvent;
  readonly requestId?: string;
  readonly message?: string;
}

export interface CommentRootHandle {
  readonly root: string;
  snapshot(): Promise<ArtifactCommentsSnapshot>;
  get(id: string): Promise<ArtifactCommentsResult<ArtifactComment>>;
  /** Idempotent by derived id: the same content again returns the existing comment, different content is a conflict. */
  create(draft: unknown): Promise<ArtifactCommentsResult<{ readonly comment: ArtifactComment; readonly created: boolean }>>;
  update(input: UpdateCommentInput): Promise<ArtifactCommentsResult<ArtifactComment>>;
  remove(input: RemoveCommentInput): Promise<ArtifactCommentsResult<{ readonly id: string }>>;
  adopt(ids: readonly string[]): Promise<ArtifactCommentsResult<{ readonly adopted: readonly string[] }>>;
  /** Plugin-raised transitions for the send flow (P2b), applied atomically: all or nothing. */
  transition(items: readonly SystemTransition[]): Promise<ArtifactCommentsResult<{ readonly comments: readonly ArtifactComment[]; readonly stale: readonly string[] }>>;
  /** Selection ids of every stored comment: pass to `pruneSelections` as `protectIds`. */
  protectedSelectionIds(): Promise<string[]>;
  /** At most 8 live listeners; null at the cap. A single stat poll runs while at least one exists. */
  subscribe(listener: (change: ArtifactCommentsChange) => void): { dispose(): void } | null;
  /** One stat check; what the timer calls. Exposed for tests and for a focus-triggered refresh. */
  poll(): Promise<void>;
  dispose(): void;
}

export interface CommentStore {
  /** Never rejects: filesystem problems become `health: "unavailable"` on the returned handle. */
  open(target: OpenTarget): Promise<CommentRootHandle>;
}

// ---------------------------------------------------------------------------------------------
// Process-wide per-root mutex (promise chain)
// ---------------------------------------------------------------------------------------------

const chains = new Map<string, Promise<void>>();
async function withMutex<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  chains.set(key, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (chains.get(key) === tail) chains.delete(key);
  }
}

// ---------------------------------------------------------------------------------------------
// Safe file primitives
// ---------------------------------------------------------------------------------------------

type DiskRead =
  | { readonly kind: 'missing' }
  | { readonly kind: 'unsafe' }
  | { readonly kind: 'oversize'; readonly size: number; readonly sig: string }
  | { readonly kind: 'ok'; readonly bytes: Buffer; readonly sig: string };

const sigOf = (stat: { ino: number | bigint; size: number | bigint; mtimeMs: number }): string => `${String(stat.ino)}:${String(stat.size)}:${stat.mtimeMs}`;
const flagsConst = fsConstants as unknown as Record<string, number | undefined>;
const READ_FLAGS = fsConstants.O_RDONLY | (flagsConst.O_NOFOLLOW ?? 0) | (flagsConst.O_NONBLOCK ?? 0);
const errno = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;

/**
 * Reads a regular, single-link file without following symlinks: lstat first (so a FIFO or device is
 * never opened), O_NOFOLLOW open, fstat must agree (file, nlink 1, same inode), size checked before
 * and during the read.
 */
async function readVerified(ops: StoreFsOps, target: string, maxBytes: number): Promise<DiskRead> {
  const before = await lstatOrNull(ops, target);
  if (before === null) return { kind: 'missing' };
  if (before.isSymbolicLink() || !before.isFile() || before.nlink > 1) return { kind: 'unsafe' };
  const sig = sigOf(before);
  if (before.size > maxBytes) return { kind: 'oversize', size: before.size, sig };
  let handle: Awaited<ReturnType<StoreFsOps['open']>>;
  try {
    handle = await ops.open(target, READ_FLAGS);
  } catch (error) {
    const code = errno(error);
    if (code === 'ENOENT') return { kind: 'missing' };
    if (code === 'ELOOP' || code === 'ENXIO' || code === 'EMLINK' || code === 'EISDIR' || code === 'ENOTDIR') return { kind: 'unsafe' };
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink > 1) return { kind: 'unsafe' };
    if (before.ino && stat.ino && before.ino !== stat.ino) return { kind: 'unsafe' };
    if (stat.size > maxBytes) return { kind: 'oversize', size: stat.size, sig };
    const buffer = Buffer.alloc(stat.size + 1);
    let filled = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
      if (filled > stat.size) return { kind: 'oversize', size: filled, sig };
    }
    return { kind: 'ok', bytes: buffer.subarray(0, filled), sig };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Creates `target` exclusively (never overwrites), mode 0600, fsynced. Removes it again if the write fails. */
async function writeExclusive(ops: StoreFsOps, target: string, data: Uint8Array | string): Promise<void> {
  const handle = await ops.open(target, 'wx', 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await ops.rm(target, { force: true }).catch(() => undefined);
    throw error;
  }
}

class StoreError extends Error {
  constructor(readonly reason: ArtifactCommentsRejectReason, message: string) { super(message); }
}

const rejected = (reason: ArtifactCommentsRejectReason, message: string): { status: 'rejected'; reason: ArtifactCommentsRejectReason; message: string } => ({ status: 'rejected', reason, message: message.slice(0, ARTIFACT_COMMENTS_CAPS.maxMessageUnits) });
const accepted = <T,>(value: T): { status: 'ok'; value: T } => ({ status: 'ok', value });
const clip = (text: string): string => (text.length > NOTICE_MAX ? `${text.slice(0, NOTICE_MAX - 1)}…` : text);

// ---------------------------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------------------------

interface State {
  readonly health: StoreHealth;
  readonly notice: string | null;
  readonly file: CommentsFile;
  /** What the filesystem looked like when this state was read or written (dir identity plus file stat). */
  readonly probe: string;
  /** Fingerprint of comments.json itself, or 'missing'. */
  readonly fileSig: string;
  /** The bytes on disk parsed cleanly, so they are a good candidate for the previous generation. */
  readonly diskValid: boolean;
  /** Size of comments.json as read or last written; a write that does not grow it is allowed past the write cap. */
  readonly bytes?: number;
}

const REASON_RANK: Record<ArtifactCommentsChangeReason, number> = { local: 0, 'send-result': 1, external: 2, recovered: 3 };

export function createCommentStore(options: CommentStoreOptions): CommentStore {
  const ops = options.ops ?? defaultStoreFsOps;
  const now = options.now ?? (() => new Date());
  const timers: Timers = options.timers ?? { setInterval: (fn, ms) => { const t = setInterval(fn, ms); (t as { unref?: () => void }).unref?.(); return t; }, clearInterval: (h) => clearInterval(h as never) };
  const pollMs = options.pollIntervalMs ?? POLL_MS;
  const schema = options.schema ?? { current: COMMENTS_SCHEMA_VERSION, migrations: MIGRATIONS };
  const maxWrite = options.limits?.maxWriteBytes ?? MAX_WRITE_BYTES;
  const maxRead = options.limits?.maxReadBytes ?? MAX_READ_BYTES;
  const hex = options.randomHex ?? ((n: number) => randomBytes(n).toString('hex'));
  const writtenBy = options.pluginVersion ?? 'threads-design';
  const keyTimeoutMs = options.keyTimeoutMs ?? 5000;

  const newStoreId = () => `str_${hex(16)}`;
  const nowIso = () => now().toISOString();

  class CommentRoot implements CommentRootHandle {
    private rootReal: string | null = null;
    private key: Uint8Array | null = null;
    private state!: State;
    private revision = 1;
    private readonly instanceId = newStoreId();
    private readonly listeners = new Set<(change: ArtifactCommentsChange) => void>();
    private timer: unknown = null;
    private pending: { reason: ArtifactCommentsChangeReason; ids: Set<string> | 'all' } | null = null;
    private flushScheduled = false;
    private polling = false;

    constructor(readonly root: string, private readonly artifactId: string) {}

    private get mutexKey(): string { return this.rootReal ?? this.root; }
    private get dir(): string { return path.join(this.rootReal ?? this.root, SIDECAR_DIR); }
    private get commentsPath(): string { return path.join(this.dir, COMMENTS_FILE); }
    private get prevPath(): string { return path.join(this.dir, PREV_FILE); }

    async init(): Promise<void> {
      this.state = await this.loadState(await this.probe().catch(() => 'err'));
    }

    // ---- file state ------------------------------------------------------------------------

    private emptyFile(): CommentsFile {
      const body: CommentsBody = { comments: [], tombstones: [], nextOrdinal: 1 };
      return { schemaVersion: schema.current, kind: COMMENTS_FILE_KIND, artifactId: this.artifactId, storeId: newStoreId(), rev: 0, writtenBy, writtenAt: nowIso(), bodySha256: bodySha256(body), ...body };
    }

    private unavailable(notice: string, probe: string): State {
      return { health: 'unavailable', notice, file: this.emptyFile(), probe, fileSig: 'missing', diskValid: false };
    }

    /** A cheap fingerprint of the sidecar directory and comments.json. Anything that changes it triggers a full reload. */
    private async probe(): Promise<string> {
      try {
        let real = this.rootReal;
        if (real === null) {
          if (!path.isAbsolute(this.root)) return 'noroot';
          real = await ops.realpath(this.root);
        }
        const dir = path.join(real, SIDECAR_DIR);
        const dirStat = await lstatOrNull(ops, dir);
        if (dirStat === null) return 'nodir';
        if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return 'baddir';
        const fileStat = await lstatOrNull(ops, path.join(dir, COMMENTS_FILE));
        if (fileStat === null) return `dir:${String(dirStat.ino)}|missing`;
        if (fileStat.isSymbolicLink()) return `dir:${String(dirStat.ino)}|link`;
        return `dir:${String(dirStat.ino)}|${sigOf(fileStat)}${fileStat.isFile() ? '' : ':notfile'}${fileStat.nlink > 1 ? ':linked' : ''}`;
      } catch {
        return 'err';
      }
    }

    private async ensureKey(): Promise<Uint8Array> {
      if (this.key === null) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('The signing key did not load in time.')), keyTimeoutMs); });
          this.key = Uint8Array.from(await Promise.race([options.keys.getKey(), timeout]));
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      }
      return this.key;
    }

    private async loadState(probe: string): Promise<State> {
      try {
        await this.ensureKey();
      } catch {
        return this.unavailable('Design could not read its signing key, so comments are unavailable.', probe);
      }
      try {
        return await this.readState(probe);
      } catch {
        return this.unavailable('Design could not read the comments file.', probe);
      }
    }

    private async readState(probe: string): Promise<State> {
      if (!path.isAbsolute(this.root)) return this.unavailable('The artifact folder is not a usable path.', probe);
      let real: string;
      try {
        real = await ops.realpath(this.root);
      } catch {
        return this.unavailable('The artifact folder could not be found.', probe);
      }
      this.rootReal = real;
      const dir = path.join(real, SIDECAR_DIR);
      const dirStat = await lstatOrNull(ops, dir);
      if (dirStat === null) return { health: 'ok', notice: null, file: this.emptyFile(), probe, fileSig: 'missing', diskValid: false };
      if (dirStat.isSymbolicLink() || !dirStat.isDirectory() || (await ops.realpath(dir)) !== dir) {
        return this.unavailable('The comments folder is not a plain folder, so Design will not use it.', probe);
      }
      await this.removeStaleTemps();

      const read = await readVerified(ops, this.commentsPath, maxRead);
      if (read.kind === 'unsafe') return this.unavailable('comments.json is a link or not a regular file, so Design will not use it.', probe);
      if (read.kind === 'missing') {
        const prev = await this.readPrev();
        if (prev === null) return { health: 'ok', notice: null, file: this.emptyFile(), probe, fileSig: 'missing', diskValid: false };
        return { health: 'recovered', notice: clip(`comments.json was missing. Design restored ${prev.comments.length} comment(s) from the previous copy.`), file: prev, probe, fileSig: 'missing', diskValid: false };
      }
      if (read.kind === 'oversize') {
        return this.recoverFromCorrupt(null, '', read.sig, probe);
      }

      let text = read.bytes.toString('utf8');
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      let parsed: unknown;
      let corrupt = false;
      try { parsed = JSON.parse(text); } catch { corrupt = true; }

      let normalized: NormalizeResult | null = null;
      let migratedFrom: number | null = null;
      if (!corrupt) {
        const migration = migrate(parsed, schema.migrations, schema.current);
        if (migration.status === 'newer') {
          const lenient = normalizeCommentsFile(parsed, now().getTime());
          return { health: 'read-only', notice: clip('These comments were created by a newer version of Design. They are read-only here.'), file: lenient.ok ? lenient.file : this.emptyFile(), probe, fileSig: read.sig, diskValid: false };
        }
        if (migration.status === 'invalid') corrupt = true;
        else {
          migratedFrom = migration.migratedFrom;
          try {
            normalized = normalizeCommentsFile(migration.value, now().getTime());
          } catch {
            normalized = null;
          }
          if (normalized === null || !normalized.ok) corrupt = true;
          else if (normalized.report.shaMismatch && normalized.report.dropped > 0) corrupt = true;
        }
      }
      if (corrupt || normalized === null || !normalized.ok) return this.recoverFromCorrupt(read.bytes, text, read.sig, probe);

      const { file, report } = normalized;
      const notes: string[] = [];
      let finalFile = file;
      let needsQuarantine = report.needsQuarantine;
      if (report.needsQuarantine) {
        if (report.overCap > 0) notes.push(`Only the first ${MAX_COMMENTS} comments are shown; the rest stay in the saved copy.`);
        if (report.dropped > 0) notes.push(`${report.dropped} unreadable comment(s) were set aside.`);
        if (report.duplicates > 0 || report.clamped > 0 || report.reassigned.length > 0) notes.push('Some comments were repaired.');
      }
      const restored = await this.restoreMissing(file);
      if (restored !== null) {
        finalFile = restored.file;
        needsQuarantine = true;
        notes.push(`Restored ${restored.count} comment(s) that were missing from comments.json.`);
      }
      if (migratedFrom !== null) {
        try {
          await writeExclusive(ops, path.join(dir, `comments.v${migratedFrom}.bak.json`), read.bytes);
        } catch (error) {
          if (errno(error) !== 'EEXIST') return this.readOnlyState('Design could not save a backup before upgrading comments.json, so comments are read-only.', finalFile, probe, read.sig);
        }
      }
      if (!needsQuarantine) return { health: 'ok', notice: null, file: finalFile, probe, fileSig: read.sig, diskValid: true, bytes: read.bytes.length };
      let name: string;
      try {
        name = await this.quarantine(read.bytes);
      } catch {
        return this.readOnlyState('Design could not save a safe copy of a damaged comments file, so comments are read-only.', finalFile, probe, read.sig);
      }
      return { health: 'recovered', notice: clip(`${notes.join(' ')} The original was saved as ${name}.`.trim()), file: finalFile, probe, fileSig: read.sig, diskValid: false, bytes: read.bytes.length };
    }

    private readOnlyState(notice: string, file: CommentsFile, probe: string, fileSig: string): State {
      return { health: 'read-only', notice: clip(notice), file, probe, fileSig, diskValid: false };
    }

    /** The file could not be read as a comments file. Quarantine it, then prefer the previous generation, then salvage. */
    private async recoverFromCorrupt(bytes: Buffer | null, text: string, fileSig: string, probe: string): Promise<State> {
      let name: string;
      try {
        name = bytes === null ? await this.quarantineByRename() : await this.quarantine(bytes);
      } catch {
        const salvaged = this.salvageFile(text);
        return this.readOnlyState('Design could not save a safe copy of a damaged comments file, so comments are read-only.', salvaged, probe, fileSig);
      }
      // Moving the file aside changed what is on disk, so the fingerprint must be taken again.
      if (bytes === null) {
        probe = await this.probe();
        fileSig = 'missing';
      }
      const prev = await this.readPrev();
      if (prev !== null) {
        // The previous generation is older: keep every valid comment that is still readable in the damaged file too.
        const merged = mergeBodies(prev, this.salvageFile(text), now().getTime());
        const comments = merged.comments.slice(0, MAX_COMMENTS);
        const newer = comments.length - prev.comments.length;
        const kept = newer > 0 ? ` and kept ${newer} newer comment(s) from the damaged file` : '';
        return { health: 'recovered', notice: clip(`Design restored ${prev.comments.length} comment(s) from the previous copy${kept}. The damaged file was saved as ${name}.`), file: { ...prev, comments, tombstones: merged.tombstones, nextOrdinal: merged.nextOrdinal }, probe, fileSig, diskValid: false };
      }
      const salvaged = this.salvageFile(text);
      const count = salvaged.comments.length;
      const notice = count > 0
        ? `Design recovered ${count} comment(s) from a damaged file. The original was saved as ${name}.`
        : `Design could not read comments.json. It was saved as ${name} and the list starts empty.`;
      return { health: 'recovered', notice: clip(notice), file: salvaged, probe, fileSig, diskValid: false };
    }

    private salvageFile(text: string): CommentsFile {
      if (text === '') return this.emptyFile();
      const raw = { schemaVersion: schema.current, kind: COMMENTS_FILE_KIND, artifactId: this.artifactId, storeId: newStoreId(), rev: 0, comments: salvageComments(text), tombstones: [], nextOrdinal: 1, writtenBy, writtenAt: nowIso(), bodySha256: '' };
      const result = normalizeCommentsFile(raw, now().getTime());
      return result.ok ? result.file : this.emptyFile();
    }

    private async readPrev(): Promise<CommentsFile | null> {
      try {
        const read = await readVerified(ops, this.prevPath, maxRead);
        if (read.kind !== 'ok') return null;
        const migration = migrate(JSON.parse(read.bytes.toString('utf8')), schema.migrations, schema.current);
        if (migration.status !== 'ok') return null;
        const normalized = normalizeCommentsFile(migration.value, now().getTime());
        if (!normalized.ok || (normalized.report.shaMismatch && normalized.report.dropped > 0)) return null;
        return normalized.file;
      } catch {
        return null;
      }
    }

    /** Comments present in the previous generation of this same store but vanished without a tombstone. */
    private async restoreMissing(file: CommentsFile): Promise<{ file: CommentsFile; count: number } | null> {
      const prev = await this.readPrev();
      if (prev === null || prev.storeId !== file.storeId || prev.rev > file.rev) return null;
      const have = new Set(file.comments.map((c) => c.id));
      const buried = new Set(file.tombstones.map((t) => t.id));
      const missing = prev.comments.filter((c) => !have.has(c.id) && !buried.has(c.id));
      if (missing.length === 0) return null;
      const merged = mergeBodies(file, { comments: missing, tombstones: [], nextOrdinal: 1 }, now().getTime());
      const comments = merged.comments.slice(0, MAX_COMMENTS);
      return { file: { ...file, comments, tombstones: merged.tombstones, nextOrdinal: merged.nextOrdinal }, count: missing.length };
    }

    // ---- quarantine ------------------------------------------------------------------------

    private async quarantineName(): Promise<string> {
      const stamp = nowIso().replace(/[-:.]/g, '');
      for (let n = 0; n < 50; n += 1) {
        const name = `comments.corrupt-${stamp}${n === 0 ? '' : `-${n}`}.json`;
        if ((await lstatOrNull(ops, path.join(this.dir, name))) === null) return name;
      }
      throw new StoreError('failed', 'Too many quarantine copies in one instant.');
    }

    private async quarantine(bytes: Buffer): Promise<string> {
      const name = await this.quarantineName();
      await writeExclusive(ops, path.join(this.dir, name), bytes);
      await this.pruneQuarantine(name);
      return name;
    }

    /** For a file too large to read: move it aside instead of loading it. */
    private async quarantineByRename(): Promise<string> {
      const name = await this.quarantineName();
      await ops.rename(this.commentsPath, path.join(this.dir, name));
      await this.pruneQuarantine(name);
      return name;
    }

    /** Keeps the copy just written plus the newest others, whatever their stamps say (a skewed or planted name must not evict it). */
    private async pruneQuarantine(justWritten: string): Promise<void> {
      try {
        const found: { name: string; stamp: string; n: number }[] = [];
        for (const name of await ops.readdir(this.dir)) {
          const match = QUARANTINE_FILE.exec(name);
          if (match) found.push({ name, stamp: match[1], n: match[2] ? Number(match[2]) : 0 });
        }
        found.sort((a, b) => (a.stamp < b.stamp ? -1 : a.stamp > b.stamp ? 1 : a.n - b.n));
        const others = found.filter((f) => f.name !== justWritten);
        for (const old of others.slice(0, Math.max(0, others.length - (QUARANTINE_KEEP - 1)))) {
          const target = path.join(this.dir, old.name);
          const stat = await lstatOrNull(ops, target);
          if (stat !== null && stat.isFile() && !stat.isSymbolicLink()) await ops.rm(target, { force: true });
        }
      } catch {
        // retention is best effort
      }
    }

    private async removeStaleTemps(): Promise<void> {
      try {
        for (const name of await ops.readdir(this.dir)) {
          if (!TMP_FILE.test(name)) continue;
          const target = path.join(this.dir, name);
          const stat = await lstatOrNull(ops, target);
          if (stat !== null && stat.isFile() && !stat.isSymbolicLink() && Date.now() - stat.mtimeMs > STALE_TEMP_MS) await ops.rm(target, { force: true });
        }
      } catch {
        // a leftover temp file is harmless
      }
    }

    // ---- freshness, events -----------------------------------------------------------------

    /** Re-checks the filesystem before every read and mutation; reloads and notifies when it changed behind our back. */
    private async freshen(): Promise<void> {
      const probe = await this.probe();
      if (probe === this.state.probe && this.state.health !== 'unavailable') return;
      const before = this.state;
      this.state = await this.loadState(probe);
      if (probe === before.probe && before.health === this.state.health) return;
      this.revision += 1;
      this.queueChange(this.state.health === 'recovered' ? 'recovered' : 'external', 'all');
    }

    private queueChange(reason: ArtifactCommentsChangeReason, ids: readonly string[] | 'all'): void {
      if (this.listeners.size === 0) return;
      if (this.pending === null) this.pending = { reason, ids: ids === 'all' ? 'all' : new Set(ids) };
      else {
        if (REASON_RANK[reason] > REASON_RANK[this.pending.reason]) this.pending.reason = reason;
        if (ids === 'all' || this.pending.ids === 'all') this.pending.ids = 'all';
        else for (const id of ids) this.pending.ids.add(id);
      }
      if (this.flushScheduled) return;
      this.flushScheduled = true;
      queueMicrotask(() => {
        this.flushScheduled = false;
        const pending = this.pending;
        this.pending = null;
        if (pending === null) return;
        const ids = pending.ids === 'all' || pending.ids.size > ARTIFACT_COMMENTS_CAPS.maxComments ? 'all' : [...pending.ids];
        const change: ArtifactCommentsChange = { storeId: this.instanceId, revision: this.revision, reason: pending.reason, ids };
        for (const listener of [...this.listeners]) {
          try { listener(change); } catch { /* a listener bug must not break the store */ }
        }
      });
    }

    // ---- reads -----------------------------------------------------------------------------

    private provenanceOf(comment: StoredComment): ArtifactCommentProvenance {
      const key = this.key;
      if (key === null || this.state.file.artifactId !== this.artifactId) return 'foreign';
      return verifyComment(key, this.artifactId, comment) ? 'local' : 'foreign';
    }

    private buildSnapshot(): ArtifactCommentsSnapshot {
      const comments = this.state.file.comments.slice(0, MAX_COMMENTS).map((c) => toPublicComment(c, this.provenanceOf(c)));
      const foreignCount = comments.filter((c) => c.provenance === 'foreign').length;
      let notice = this.state.notice;
      if (foreignCount > 0) notice = clip(`${notice ? `${notice} ` : ''}From another source: ${foreignCount} comment(s). Review before sending.`);
      return { storeId: this.instanceId, revision: this.revision, health: this.state.health, notice, comments, foreignCount };
    }

    private locked<T>(fn: () => Promise<T>): Promise<T> {
      return withMutex(this.mutexKey, async () => {
        await this.freshen();
        return fn();
      });
    }

    snapshot(): Promise<ArtifactCommentsSnapshot> {
      return this.locked(async () => this.buildSnapshot());
    }

    async get(id: string): Promise<ArtifactCommentsResult<ArtifactComment>> {
      if (!isCommentId(id)) return rejected('invalid', 'That is not a comment id.');
      return this.locked(async () => {
        if (this.state.health === 'unavailable') return rejected('unavailable', this.state.notice ?? 'Comments are unavailable.');
        const found = this.state.file.comments.find((c) => c.id === id);
        return found ? accepted(toPublicComment(found, this.provenanceOf(found))) : rejected('not-found', 'That comment no longer exists.');
      });
    }

    protectedSelectionIds(): Promise<string[]> {
      return this.locked(async () => {
        // An answer from a store that could not read (or had to repair) its file would be incomplete, and a
        // caller feeding it to pruneSelections would delete pinned selections. Refuse; the caller skips pruning.
        if (this.state.health !== 'ok') throw new StoreError('unavailable', 'The comment list is not fully known, so selections must not be pruned.');
        return this.state.file.comments.map((c) => c.selectionId);
      });
    }

    // ---- writes ----------------------------------------------------------------------------

    private writable(): ReturnType<typeof rejected> | null {
      if (this.state.health === 'unavailable') return rejected('unavailable', this.state.notice ?? 'Comments are unavailable.');
      if (this.state.health === 'read-only') return rejected('read-only', this.state.notice ?? 'Comments are read-only.');
      return null;
    }

    private serialize(body: CommentsBody, rev: number, storeId: string): { text: string; file: CommentsFile } {
      const file: CommentsFile = {
        schemaVersion: schema.current,
        kind: COMMENTS_FILE_KIND,
        artifactId: this.artifactId,
        storeId,
        rev,
        writtenBy,
        writtenAt: nowIso(),
        bodySha256: bodySha256(body),
        comments: body.comments,
        tombstones: body.tombstones,
        nextOrdinal: body.nextOrdinal,
      };
      return { text: `${JSON.stringify(file)}\n`, file };
    }

    /**
     * temp file -> verify the file did not change under us (merge and retry if it did) -> copy the
     * current good file to the previous generation -> rename over comments.json. A crash anywhere
     * leaves either the old or the new file, never a partial one.
     */
    private async persist(initial: CommentsBody, ids: readonly string[], reason: ArtifactCommentsChangeReason): Promise<ArtifactCommentsResult<true>> {
      const real = this.rootReal;
      if (real === null) return rejected('unavailable', 'The artifact folder is unavailable.');
      let candidate = initial;
      let base = this.state;
      let merged = false;
      const temps: string[] = [];
      try {
        for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
          if (candidate.comments.length > MAX_COMMENTS) return rejected('limit', 'Resolve or delete older comments to add more.');
          const serialized = this.serialize(candidate, base.file.rev + 1, base.file.storeId);
          const size = Buffer.byteLength(serialized.text);
          if (size > maxWrite && size >= (base.bytes ?? 0)) return rejected('limit', 'The comments file would become too large. Delete some comments first.');
          const dir = await ensureRealDirectory(ops, real, SIDECAR_DIR);
          const tmp = path.join(dir, `comments.${hex(8)}.tmp`);
          temps.push(tmp);
          await writeExclusive(ops, tmp, serialized.text);

          const fresh = await readVerified(ops, this.commentsPath, maxRead);
          if (fresh.kind === 'unsafe') return rejected('unavailable', 'comments.json is not a regular file.');
          const freshSig = fresh.kind === 'missing' ? 'missing' : fresh.sig;
          if (freshSig !== base.fileSig) {
            // Somebody else wrote since we read: merge their content with ours and try again.
            await ops.rm(tmp, { force: true });
            if (fresh.kind !== 'ok') { await this.reload(); return rejected('failed', 'comments.json changed while saving. Try again.'); }
            const other = this.parseFresh(fresh.bytes);
            if (other === null) { await this.reload(); return rejected('failed', 'comments.json changed while saving. Try again.'); }
            candidate = mergeBodies(candidate, other, now().getTime());
            base = { ...base, file: other.file, fileSig: freshSig, diskValid: true, bytes: fresh.bytes.length };
            merged = true;
            continue;
          }

          if ((await ops.realpath(dir)) !== dir) return rejected('unavailable', 'The comments folder moved while saving.');
          if (base.diskValid && fresh.kind === 'ok') {
            const prevTmp = path.join(dir, `comments.${hex(8)}.tmp`);
            temps.push(prevTmp);
            await writeExclusive(ops, prevTmp, fresh.bytes);
            await ops.rename(prevTmp, this.prevPath);
          }
          await ops.rename(tmp, this.commentsPath);

          const probe = await this.probe();
          const stat = await lstatOrNull(ops, this.commentsPath);
          this.state = { health: this.state.health, notice: this.state.notice, file: serialized.file, probe, fileSig: stat === null ? 'missing' : sigOf(stat), diskValid: true, bytes: size };
          this.revision += 1;
          this.queueChange(merged ? 'external' : reason, merged ? 'all' : ids);
          return accepted(true);
        }
        await this.reload();
        return rejected('busy', 'Another copy of Design keeps changing these comments. Try again in a moment.');
      } catch (error) {
        if (error instanceof StoreError) return rejected(error.reason, error.message);
        return rejected(error instanceof SelectionFileError ? 'unavailable' : 'failed', 'The comments could not be saved.');
      } finally {
        for (const temp of temps) await ops.rm(temp, { force: true }).catch(() => undefined);
      }
    }

    private parseFresh(bytes: Buffer): (CommentsBody & { file: CommentsFile }) | null {
      try {
        let text = bytes.toString('utf8');
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
        const migration = migrate(JSON.parse(text), schema.migrations, schema.current);
        if (migration.status !== 'ok') return null;
        const normalized = normalizeCommentsFile(migration.value, now().getTime());
        if (!normalized.ok || normalized.report.needsQuarantine) return null;
        return { comments: normalized.file.comments, tombstones: normalized.file.tombstones, nextOrdinal: normalized.file.nextOrdinal, file: normalized.file };
      } catch {
        return null;
      }
    }

    private async reload(): Promise<void> {
      const probe = await this.probe();
      this.state = await this.loadState(probe);
      this.revision += 1;
      this.queueChange(this.state.health === 'recovered' ? 'recovered' : 'external', 'all');
    }

    private bodyOf(): CommentsBody {
      return { comments: this.state.file.comments, tombstones: this.state.file.tombstones, nextOrdinal: this.state.file.nextOrdinal };
    }

    private replace(list: readonly StoredComment[], next: StoredComment): StoredComment[] {
      return list.map((c) => (c.id === next.id ? next : c));
    }

    private finalComment(id: string): ArtifactComment | null {
      const found = this.state.file.comments.find((c) => c.id === id);
      return found ? toPublicComment(found, this.provenanceOf(found)) : null;
    }

    async create(raw: unknown): Promise<ArtifactCommentsResult<{ readonly comment: ArtifactComment; readonly created: boolean }>> {
      const checked = validatePinDraft(raw);
      if (!checked.ok) return rejected('invalid', checked.reason);
      const draft = checked.draft;
      return this.locked(async () => {
        const blocked = this.writable();
        if (blocked) return blocked;
        const id = `cmt_${draft.selectionId.slice(4)}`;
        const existing = this.state.file.comments.find((c) => c.id === id);
        if (existing) {
          const same = canonicalJson(draftFields(existing)) === canonicalJson(draftFields(draft));
          return same ? accepted({ comment: toPublicComment(existing, this.provenanceOf(existing)), created: false }) : rejected('conflict', 'A different comment already uses this selection.');
        }
        if (this.state.file.comments.length >= MAX_COMMENTS) return rejected('limit', 'Resolve or delete older comments to add more.');
        const key = await this.ensureKey();
        const comment = createStoredComment(draft, { ordinal: this.state.file.nextOrdinal, now: nowIso(), key, artifactId: this.artifactId });
        // Re-pinning an id that was deleted: its tombstone must go, or a reload at the same instant would drop it again.
        const body: CommentsBody = { comments: [...this.state.file.comments, comment], tombstones: this.state.file.tombstones.filter((t) => t.id !== comment.id), nextOrdinal: comment.ordinal + 1 };
        const result = await this.persist(body, [comment.id], 'local');
        if (result.status !== 'ok') return result;
        const final = this.finalComment(comment.id);
        return final ? accepted({ comment: final, created: true }) : rejected('failed', 'The comment could not be saved.');
      });
    }

    async update(input: UpdateCommentInput): Promise<ArtifactCommentsResult<ArtifactComment>> {
      const parsed = parseUpdate(input);
      if (parsed === null) return rejected('invalid', 'That change is not valid.');
      return this.locked(async () => {
        const blocked = this.writable();
        if (blocked) return blocked;
        const found = this.state.file.comments.find((c) => c.id === parsed.id);
        if (!found) return rejected('not-found', 'That comment no longer exists.');
        if (found.version !== parsed.expectedVersion) return rejected('conflict', 'That comment changed. Refresh and try again.');
        const key = await this.ensureKey();
        const local = this.provenanceOf(found) === 'local';
        let next: StoredComment | null;
        if (parsed.text !== undefined) {
          if (!local) return rejected('foreign', 'Adopt this comment before editing its text.');
          next = applyEvent(found, 'edit-text', { now: nowIso(), text: parsed.text });
          if (next) next = { ...next, sig: signComment(key, this.artifactId, next) };
        } else {
          next = applyEvent(found, parsed.event!, { now: nowIso() });
        }
        if (next === null) return rejected('invalid-transition', 'That change is not allowed for a comment in this state.');
        const body: CommentsBody = { ...this.bodyOf(), comments: this.replace(this.state.file.comments, next) };
        const result = await this.persist(body, [found.id], 'local');
        if (result.status !== 'ok') return result;
        const final = this.finalComment(found.id);
        return final ? accepted(final) : rejected('not-found', 'That comment no longer exists.');
      });
    }

    async remove(input: RemoveCommentInput): Promise<ArtifactCommentsResult<{ readonly id: string }>> {
      if (typeof input !== 'object' || input === null || !isCommentId(input.id) || !isVersion(input.expectedVersion)) return rejected('invalid', 'That change is not valid.');
      const { id, expectedVersion } = input;
      return this.locked(async () => {
        const blocked = this.writable();
        if (blocked) return blocked;
        const found = this.state.file.comments.find((c) => c.id === id);
        if (!found) return rejected('not-found', 'That comment no longer exists.');
        if (found.version !== expectedVersion) return rejected('conflict', 'That comment changed. Refresh and try again.');
        if (nextStatus(found.status, 'remove') !== 'deleted') return rejected('invalid-transition', 'A comment that is being sent cannot be deleted.');
        const body: CommentsBody = { comments: this.state.file.comments.filter((c) => c.id !== id), tombstones: [...this.state.file.tombstones.filter((t) => t.id !== id), { id, at: nowIso() }], nextOrdinal: this.state.file.nextOrdinal };
        const result = await this.persist(body, [id], 'local');
        if (result.status !== 'ok') return result;
        await this.removeSelectionFiles(found.selectionId);
        return accepted({ id });
      });
    }

    /** Best effort: deletes the comment's own selection files, built only from the regex-validated selection id. */
    private async removeSelectionFiles(selectionId: string): Promise<void> {
      try {
        const real = this.rootReal;
        if (real === null || !/^sel_[0-9a-f]{32}$/.test(selectionId)) return;
        const selections = path.join(real, SIDECAR_DIR, 'selections');
        const stat = await lstatOrNull(ops, selections);
        if (stat === null || stat.isSymbolicLink() || !stat.isDirectory() || (await ops.realpath(selections)) !== selections) return;
        for (const ext of ['json', 'png']) {
          const target = path.join(selections, `${selectionId}.${ext}`);
          const file = await lstatOrNull(ops, target);
          if (file !== null && file.isFile() && !file.isSymbolicLink()) await ops.rm(target, { force: true });
        }
      } catch {
        // leaving a sidecar behind is harmless
      }
    }

    async adopt(ids: readonly string[]): Promise<ArtifactCommentsResult<{ readonly adopted: readonly string[] }>> {
      if (!Array.isArray(ids) || !ids.every(isCommentId)) return rejected('invalid', 'Those are not comment ids.');
      if (ids.length > ARTIFACT_COMMENTS_CAPS.maxBatch) return rejected('limit', `Adopt at most ${ARTIFACT_COMMENTS_CAPS.maxBatch} comments at a time.`);
      return this.locked(async () => {
        const blocked = this.writable();
        if (blocked) return blocked;
        const key = await this.ensureKey();
        const wanted = new Set(ids);
        const adopted: string[] = [];
        const at = nowIso();
        const comments = this.state.file.comments.map((c) => {
          if (!wanted.has(c.id) || this.provenanceOf(c) === 'local') return c;
          adopted.push(c.id);
          const bumped = { ...c, version: c.version + 1, updatedAt: at };
          return { ...bumped, sig: signComment(key, this.artifactId, bumped) };
        });
        if (adopted.length === 0) return accepted({ adopted });
        const result = await this.persist({ ...this.bodyOf(), comments }, adopted, 'local');
        return result.status === 'ok' ? accepted({ adopted: ids.filter((id) => adopted.includes(id)) }) : result;
      });
    }

    async transition(items: readonly SystemTransition[]): Promise<ArtifactCommentsResult<{ readonly comments: readonly ArtifactComment[]; readonly stale: readonly string[] }>> {
      if (!Array.isArray(items) || items.length === 0 || items.length > ARTIFACT_COMMENTS_CAPS.maxComments) return rejected('invalid', 'Those changes are not valid.');
      const seen = new Set<string>();
      for (const item of items) {
        if (typeof item !== 'object' || item === null || !isCommentId(item.id) || !SYSTEM_EVENTS.includes(item.event) || seen.has(item.id)) return rejected('invalid', 'Those changes are not valid.');
        if (item.requestId !== undefined && !isRequestId(item.requestId)) return rejected('invalid', 'Those changes are not valid.');
        if (item.message !== undefined && typeof item.message !== 'string') return rejected('invalid', 'Those changes are not valid.');
        seen.add(item.id);
      }
      return this.locked(async () => {
        const blocked = this.writable();
        if (blocked) return blocked;
        let comments = this.state.file.comments;
        const at = nowIso();
        const stale: string[] = [];
        const appliedIds: string[] = [];
        for (const item of items) {
          const found = comments.find((c) => c.id === item.id);
          if (!found) return rejected('not-found', 'That comment no longer exists.');
          if ((item.event === 'batch-issued' || item.event === 'batch-resend') && this.provenanceOf(found) !== 'local') return rejected('foreign', 'Adopt this comment before sending it.');
          // A result that belongs to a different batch request than the one that issued this comment is stale: skip it, not the others.
          if ((item.event === 'delivered' || item.event === 'send-failed' || item.event === 'expired') && (item.requestId ?? null) !== (found.send.lastBatchRequestId ?? null)) {
            stale.push(item.id);
            continue;
          }
          const next = applyEvent(found, item.event, { now: at, requestId: item.requestId ?? null, message: item.message ?? null });
          if (next === null) return rejected('invalid-transition', 'That change is not allowed for a comment in this state.');
          comments = this.replace(comments, next);
          appliedIds.push(item.id);
        }
        if (appliedIds.length === 0) return accepted({ comments: [], stale });
        const issuing = items.every((i) => i.event === 'batch-issued' || i.event === 'batch-resend');
        const result = await this.persist({ ...this.bodyOf(), comments }, appliedIds, issuing ? 'local' : 'send-result');
        if (result.status !== 'ok') return result;
        return accepted({ comments: appliedIds.map((id) => this.finalComment(id)).filter((c): c is ArtifactComment => c !== null), stale });
      });
    }

    // ---- subscriptions ---------------------------------------------------------------------

    subscribe(listener: (change: ArtifactCommentsChange) => void): { dispose(): void } | null {
      if (this.listeners.size >= ARTIFACT_COMMENTS_CAPS.maxSubscribersPerRoot) return null;
      const wrapper = (change: ArtifactCommentsChange) => listener(change);
      this.listeners.add(wrapper);
      if (this.timer === null) this.timer = timers.setInterval(() => { void this.poll(); }, pollMs);
      let disposed = false;
      return {
        dispose: () => {
          if (disposed) return;
          disposed = true;
          this.listeners.delete(wrapper);
          if (this.listeners.size === 0) this.stopTimer();
        },
      };
    }

    private stopTimer(): void {
      if (this.timer !== null) { timers.clearInterval(this.timer); this.timer = null; }
    }

    /** A tick that arrives while the previous one is still running is dropped: a slow disk must not build a queue of polls. */
    async poll(): Promise<void> {
      if (this.polling) return;
      this.polling = true;
      try {
        await withMutex(this.mutexKey, () => this.freshen()).catch(() => undefined);
      } finally {
        this.polling = false;
      }
    }

    dispose(): void {
      this.listeners.clear();
      this.pending = null;
      this.stopTimer();
    }
  }

  return {
    async open(target: OpenTarget): Promise<CommentRootHandle> {
      const handle = new CommentRoot(target.root, target.artifactId);
      await withMutex(target.root, () => handle.init());
      return handle;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

const isVersion = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1;

const UPDATE_ACTIONS = { resolve: 'resolve', dismiss: 'dismiss', reopen: 'reopen', unqueue: 'unqueue' } as const;

function parseUpdate(input: unknown): { id: string; expectedVersion: number; event?: 'resolve' | 'dismiss' | 'reopen' | 'unqueue'; text?: string } | null {
  if (typeof input !== 'object' || input === null) return null;
  const { id, expectedVersion, change } = input as Record<string, unknown>;
  if (!isCommentId(id) || !isVersion(expectedVersion) || typeof change !== 'object' || change === null) return null;
  const record = change as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, 'text')) {
    const text = record.text;
    if (typeof text !== 'string' || text.length < 1 || text.length > ARTIFACT_COMMENTS_CAPS.maxTextUnits) return null;
    return { id, expectedVersion, text };
  }
  const action = record.action;
  if (typeof action !== 'string' || !Object.prototype.hasOwnProperty.call(UPDATE_ACTIONS, action)) return null;
  return { id, expectedVersion, event: UPDATE_ACTIONS[action as keyof typeof UPDATE_ACTIONS] };
}

/** The fields a replayed `create` must reproduce exactly (timestamps of later changes are not compared). */
function draftFields(c: { selectionId: string; createdAt: string; artifactRevision: number; viewSessionId: string; kind: string; text: string; anchor: unknown; label: string; hasScreenshot: boolean; redacted: boolean }) {
  return { selectionId: c.selectionId, createdAt: c.createdAt, artifactRevision: c.artifactRevision, viewSessionId: c.viewSessionId, kind: c.kind, text: c.text, anchor: c.anchor, label: c.label, hasScreenshot: c.hasScreenshot, redacted: c.redacted };
}
