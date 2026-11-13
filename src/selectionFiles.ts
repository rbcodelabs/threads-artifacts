import * as nodeFs from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { SELECTION_ID_PATTERN } from './elementFeedbackValidation';

/**
 * Writes `<artifact root>/.threads-design/selections/<id>.json` and `<id>.png`.
 *
 * The plugin, not Geode and not the agent, owns these files (spec 13c assumption c). Safety rules
 * (spike B4): never follow a symlink for the sidecar directories or the targets; resolve every
 * directory with the native realpath and require it to equal the path we built (so a symlink,
 * wrong-case or firmlink spelling anywhere in the chain fails closed); write a temp file created
 * with O_EXCL in the same directory and rename it into place, never writing in place; never
 * overwrite an existing file (a repeat of the same selection id is a replay). Node has no
 * `openat`/`renameat`, so a parent-directory swap between the final re-check and the rename remains
 * a documented residual risk; the directory is re-resolved immediately before each rename.
 */

export const SIDECAR_DIR = '.threads-design';
export const SELECTIONS_DIR = 'selections';

export class SelectionFileError extends Error {}

export interface FsOps {
  lstat: typeof fs.lstat;
  mkdir: typeof fs.mkdir;
  open: typeof fs.open;
  readdir: typeof fs.readdir;
  rename: typeof fs.rename;
  rm: typeof fs.rm;
  realpath: (target: string) => Promise<string>;
}

const nativeRealpath = (target: string): Promise<string> =>
  new Promise((resolve, reject) => nodeFs.realpath.native(target, (error, resolved) => (error ? reject(error) : resolve(resolved))));

export const defaultOps: FsOps = { lstat: fs.lstat, mkdir: fs.mkdir, open: fs.open, readdir: fs.readdir, rename: fs.rename, rm: fs.rm, realpath: nativeRealpath };

export interface SelectionFilesInput {
  /** Artifact root as resolved by intake; resolved again here. */
  readonly root: string;
  readonly selectionId: string;
  /** Serialized, validated request (without screenshot bytes). */
  readonly json: string;
  readonly png: Uint8Array | null;
  /** True for `permissions.vault: read`: a PNG is NEVER written, even when bytes are present. */
  readonly vaultRead: boolean;
}

export interface SelectionFilesResult {
  readonly jsonPath: string;
  readonly pngPath: string | null;
  /** True when every requested file already existed (a retry of the same selection id). */
  readonly replay: boolean;
}

export const fileError = (message: string, cause?: unknown): SelectionFileError => {
  const error = new SelectionFileError(message);
  if (cause !== undefined) (error as { cause?: unknown }).cause = cause;
  return error;
};

export async function lstatOrNull(ops: FsOps, target: string) {
  try {
    return await ops.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Ensures `parent/name` is a real directory (not a symlink) whose native realpath equals its literal path. */
export async function ensureRealDirectory(ops: FsOps, parent: string, name: string): Promise<string> {
  const dir = path.join(parent, name);
  let stat = await lstatOrNull(ops, dir);
  if (stat === null) {
    try {
      await ops.mkdir(dir, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    stat = await ops.lstat(dir);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw fileError(`${name} is not a plain directory.`);
  if ((await ops.realpath(dir)) !== dir) throw fileError(`${name} does not resolve to itself.`);
  return dir;
}

/** Writes `data` to `dir/name` unless a regular file is already there. Returns whether it already existed. */
async function writeOnce(ops: FsOps, dir: string, name: string, data: string | Uint8Array): Promise<{ path: string; existed: boolean }> {
  const target = path.join(dir, name);
  const checkTarget = async (): Promise<boolean> => {
    const existing = await lstatOrNull(ops, target);
    if (existing === null) return false;
    if (!existing.isFile()) throw fileError(`${name} exists and is not a regular file.`);
    return true;
  };
  if (await checkTarget()) return { path: target, existed: true };

  const temp = path.join(dir, `.${name}.${randomBytes(8).toString('hex')}.tmp`);
  let handle: Awaited<ReturnType<FsOps['open']>> | undefined;
  try {
    handle = await ops.open(temp, 'wx', 0o600);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    if ((await ops.realpath(dir)) !== dir) throw fileError('The selections directory moved during the write.');
    if (await checkTarget()) {
      await ops.rm(temp, { force: true });
      return { path: target, existed: true };
    }
    await ops.rename(temp, target);
    return { path: target, existed: false };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await ops.rm(temp, { force: true }).catch(() => undefined);
    throw error instanceof SelectionFileError ? error : fileError(`Could not write ${name}.`, error);
  }
}

export async function writeSelectionFiles(input: SelectionFilesInput, ops: FsOps = defaultOps): Promise<SelectionFilesResult> {
  if (!SELECTION_ID_PATTERN.test(input.selectionId)) throw fileError('Invalid selection id.');
  if (!path.isAbsolute(input.root)) throw fileError('The artifact root must be absolute.');
  try {
    const rootReal = await ops.realpath(input.root);
    const sidecar = await ensureRealDirectory(ops, rootReal, SIDECAR_DIR);
    const selections = await ensureRealDirectory(ops, sidecar, SELECTIONS_DIR);
    const writePng = input.png !== null && !input.vaultRead;
    const png = writePng ? await writeOnce(ops, selections, `${input.selectionId}.png`, input.png as Uint8Array) : null;
    const json = await writeOnce(ops, selections, `${input.selectionId}.json`, input.json);
    return { jsonPath: json.path, pngPath: png ? png.path : null, replay: json.existed && (png === null || png.existed) };
  } catch (error) {
    throw error instanceof SelectionFileError ? error : fileError('Could not save the selection files.', error);
  }
}

export const SELECTION_RETENTION = 50;
const SELECTION_FILE = /^(sel_[0-9a-f]{32})\.(json|png)$/;
const SELECTION_TEMP_FILE = /^\.sel_[0-9a-f]{32}\.(json|png)\.[0-9a-f]{16}\.tmp$/;
const STALE_TEMP_MS = 60 * 60 * 1000;

export interface PruneInput {
  readonly root: string;
  /** Number of newest selection ids (json + png pairs) to keep. */
  readonly keep: number;
  /** An id that must survive regardless of age (the one just written). */
  readonly protectId?: string;
  /**
   * Ids that are exempt from retention entirely (every pinned comment's selection id). They are not
   * ranked, so they do not use up any of the `keep` slots; only the unreferenced ids compete for those.
   */
  readonly protectIds?: Iterable<string>;
}

/**
 * Bounded retention for `.threads-design/selections`: keeps the newest `keep` ids and removes older
 * ones, plus interrupted-write temp files older than an hour. Only regular files with the exact
 * sel_<32 hex>.(json|png) shape directly inside the real selections directory are ever deleted, the
 * directory is re-verified before deleting, and any problem simply means nothing is removed.
 */
export async function pruneSelections(input: PruneInput, ops: FsOps = defaultOps): Promise<{ removed: string[] }> {
  const removed: string[] = [];
  try {
    if (!path.isAbsolute(input.root)) return { removed };
    const rootReal = await ops.realpath(input.root);
    const selections = path.join(rootReal, SIDECAR_DIR, SELECTIONS_DIR);
    const verified = async (): Promise<boolean> => {
      for (const dir of [path.join(rootReal, SIDECAR_DIR), selections]) {
        const stat = await lstatOrNull(ops, dir);
        if (stat === null || stat.isSymbolicLink() || !stat.isDirectory() || (await ops.realpath(dir)) !== dir) return false;
      }
      return true;
    };
    if (!(await verified())) return { removed };

    const groups = new Map<string, { files: string[]; newest: number }>();
    const stale: string[] = [];
    const now = Date.now();
    for (const name of await ops.readdir(selections)) {
      const file = path.join(selections, name);
      const match = SELECTION_FILE.exec(name);
      const isTemp = !match && SELECTION_TEMP_FILE.test(name);
      if (!match && !isTemp) continue;
      const stat = await lstatOrNull(ops, file);
      if (stat === null || !stat.isFile() || stat.isSymbolicLink()) continue;
      if (isTemp) {
        if (now - stat.mtimeMs > STALE_TEMP_MS) stale.push(file);
        continue;
      }
      const group = groups.get(match![1]) ?? { files: [], newest: 0 };
      group.files.push(file);
      group.newest = Math.max(group.newest, stat.mtimeMs);
      groups.set(match![1], group);
    }

    const exempt = new Set<string>();
    for (const id of input.protectIds ?? []) if (typeof id === 'string' && SELECTION_ID_PATTERN.test(id)) exempt.add(id);
    const newestFirst = [...groups.entries()].filter(([id]) => !exempt.has(id)).sort((a, b) => b[1].newest - a[1].newest || (a[0] < b[0] ? 1 : -1));
    const keepIds = new Set(newestFirst.slice(0, Math.max(0, input.keep)).map(([id]) => id));
    if (input.protectId) keepIds.add(input.protectId);
    const doomed = [...stale, ...newestFirst.filter(([id]) => !keepIds.has(id)).flatMap(([, group]) => group.files)];
    if (doomed.length === 0 || !(await verified())) return { removed };
    for (const file of doomed) {
      await ops.rm(file, { force: true });
      removed.push(path.basename(file));
    }
  } catch {
    // Retention is best-effort; a failure leaves files in place.
  }
  return { removed };
}
