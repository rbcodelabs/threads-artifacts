import * as path from 'node:path';
import type { AgentThreadsApiV1, PeerIdentity, ThreadArtifactRef } from './contracts';
import type { DesignArtifact } from './designArtifact';
import { DESIGN_ARTIFACT_KIND, DESIGN_PROVIDER_ID, DESIGN_STORAGE_NAMESPACE } from './designArtifactProvider';
import { designFolderName, isVisibleArtifactPath } from './designStorage';

/** Minimal fs surface so migration is testable without touching disk. */
export interface MigrationFs {
  readdir(target: string): Promise<string[]>;
  readFile(target: string): Promise<string>;
  rename(from: string, to: string): Promise<unknown>;
  rmdir(target: string): Promise<unknown>;
}

export interface MigrationResult { migrated: number; skipped: number; failed: number }

export interface MigrationDeps {
  api: { artifacts: Pick<AgentThreadsApiV1['artifacts'], 'list' | 'allocateStorage' | 'update'> };
  fs: MigrationFs;
  owner: PeerIdentity;
  /** Absolute `<vault>/.geode/artifacts` directory. */
  hiddenRoot: string;
}

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const sameDir = (a: string, b: string): boolean => path.resolve(a) === path.resolve(b);

function isUnder(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function readManifest(fs: MigrationFs, dir: string): Promise<{ id: string; title: string; threadId: string } | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(dir, 'artifact.json'))) as Record<string, unknown>;
    if (typeof parsed.id !== 'string' || typeof parsed.createdByThreadId !== 'string') return null;
    return { id: parsed.id, title: typeof parsed.title === 'string' ? parsed.title : '', threadId: parsed.createdByThreadId };
  } catch {
    return null;
  }
}

/** Rebase a stored path from the old root to the new one; paths outside the old root are untouched. */
function rebase(value: string | undefined, from: string, to: string): string | undefined {
  if (value === undefined) return undefined;
  if (sameDir(value, from)) return to;
  return isUnder(from, value) ? path.join(to, path.relative(path.resolve(from), path.resolve(value))) : value;
}

function migratedData(data: DesignArtifact, from: string, to: string): DesignArtifact {
  const next: DesignArtifact = {
    ...data,
    storageRoot: to,
    root: to,
    manifestPath: path.join(to, 'artifact.json'),
    entryPath: path.join(to, path.relative(path.resolve(from), path.resolve(data.entryPath))),
  };
  const capture = rebase(data.lastCapturePath, from, to);
  if (capture !== undefined) next.lastCapturePath = capture;
  return next;
}

async function listOrEmpty(fs: MigrationFs, dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

/**
 * Moves designs this plugin created in the legacy hidden `.geode/artifacts/` area into host-allocated
 * visible folders. Idempotent, never overwrites, never throws: a design that cannot be moved cleanly
 * stays where it is and keeps working. Discovery is by artifact.json identity (never folder name);
 * ownership is confirmed against the host's own artifact record.
 */
export async function migrateHiddenDesigns({ api, fs, owner, hiddenRoot }: MigrationDeps): Promise<MigrationResult> {
  const result: MigrationResult = { migrated: 0, skipped: 0, failed: 0 };
  let names: string[];
  try {
    names = await fs.readdir(hiddenRoot);
  } catch {
    return result;
  }

  for (const name of names) {
    const dir = path.join(hiddenRoot, name);
    const manifest = await readManifest(fs, dir);
    if (!manifest) continue;

    try {
      const refs = await api.artifacts.list(manifest.threadId);
      const ref: ThreadArtifactRef | undefined = refs.find(candidate =>
        candidate.providerId === DESIGN_PROVIDER_ID && candidate.kind === DESIGN_ARTIFACT_KIND && candidate.id === manifest.id);
      const data = ref?.data as DesignArtifact | undefined;
      if (!ref || !data || typeof data.root !== 'string' || !sameDir(data.root, dir)) continue;

      const allocation = await api.artifacts.allocateStorage(manifest.threadId, manifest.id, {
        location: 'visible',
        folderName: designFolderName(manifest.title || ref.title, manifest.id),
        owner: { pluginId: DESIGN_STORAGE_NAMESPACE },
      });
      if (!allocation.success) { result.failed++; continue; }
      // Host without visible storage: nothing can move, and every other design would get the same answer.
      if (!isVisibleArtifactPath(allocation.path) || sameDir(allocation.path, dir)) return result;

      if (await moveDesign({ api, fs, owner }, manifest.threadId, ref, data, dir, allocation.path)) result.migrated++;
      else result.skipped++;
    } catch {
      result.failed++;
    }
  }
  return result;
}

/** Returns false when skipped for a collision; throws (after restoring the original) on any failure. */
async function moveDesign(
  { api, fs, owner }: Pick<MigrationDeps, 'api' | 'fs' | 'owner'>,
  threadId: string,
  ref: ThreadArtifactRef,
  data: DesignArtifact,
  from: string,
  to: string,
): Promise<boolean> {
  const entries = await fs.readdir(from);
  const occupied = new Set(await listOrEmpty(fs, to));
  if (entries.some(entry => occupied.has(entry))) return false;

  const moved: string[] = [];
  const restore = async () => {
    for (const entry of moved.reverse()) {
      try { await fs.rename(path.join(to, entry), path.join(from, entry)); } catch { /* best effort */ }
    }
  };
  try {
    for (const entry of entries) {
      await fs.rename(path.join(from, entry), path.join(to, entry));
      moved.push(entry);
    }
    const updated = await api.artifacts.update(owner, threadId, ref.id, {
      data: migratedData(data, from, to),
      storageRoot: to,
    });
    if (!updated.success) throw new Error(updated.message ?? 'Could not update design artifact.');
  } catch (error) {
    await restore();
    throw error;
  }
  try { await fs.rmdir(from); } catch { /* an emptied leftover directory is harmless */ }
  return true;
}
