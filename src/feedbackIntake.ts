import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { AgentThreadsApiV1 } from './contracts';
import { parseDesignManifest, type DesignArtifactManifest } from './designArtifact';
import { DESIGN_ARTIFACT_KIND } from './designArtifactProvider';
import type { ArtifactFeedbackTarget } from './geodeArtifactFeedback';
import { THREAD_GONE_MESSAGE } from './threadGone';

/**
 * Intake: decide whether a feedback target really is a Design static artifact owned by one of our
 * threads, and which thread. Nothing in the request is trusted for this: the root is resolved with
 * realpath and must sit inside the vault (the exact folder is pinned by the thread's artifact ref), the manifest on disk names the thread, and
 * the thread's own artifact list must still reference the same folder.
 */

const MAX_MANIFEST_BYTES = 64 * 1024;
export const NOT_A_DESIGN_MESSAGE = 'This artifact was not created by Design, so its comments cannot be sent to a thread.';
export const STORAGE_UNKNOWN_MESSAGE = 'Agent Threads has no storage location recorded for this design, so its comments cannot be sent to a thread.';
const UNAVAILABLE_MESSAGE = 'Agent Threads is not available right now. Try again in a moment.';

export interface IntakeDeps {
  readonly api: Pick<AgentThreadsApiV1, 'threads' | 'artifacts'>;
  /** Vault base path. Design storage (hidden or the user's visible folder) must live inside it; the exact folder is pinned by the thread's own artifact ref. */
  readonly vaultRoot: () => string | undefined;
}

export type IntakeResult =
  | {
      readonly ok: true;
      readonly threadId: string;
      /** Real (symlink-free) artifact root. */
      readonly root: string;
      readonly title: string;
      /** True when either the host target or the manifest says `permissions.vault: read`. */
      readonly vaultRead: boolean;
      readonly manifest: DesignArtifactManifest;
    }
  | { readonly ok: false; readonly reason: 'unsupported' | 'unavailable'; readonly message: string };

const unsupported = (): IntakeResult => ({ ok: false, reason: 'unsupported', message: NOT_A_DESIGN_MESSAGE });
const unavailable = (message = UNAVAILABLE_MESSAGE): IntakeResult => ({ ok: false, reason: 'unavailable', message });

async function realpathOrNull(target: string): Promise<string | null> {
  try {
    return await fs.realpath(target);
  } catch {
    return null;
  }
}

const isStrictlyInside = (candidate: string, parent: string): boolean => candidate.startsWith(`${parent}${path.sep}`);

async function readManifest(root: string): Promise<DesignArtifactManifest | null> {
  const file = path.join(root, 'artifact.json');
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_MANIFEST_BYTES) return null;
    return parseDesignManifest(JSON.parse(await fs.readFile(file, 'utf8')));
  } catch {
    return null;
  }
}

export async function resolveFeedbackTarget(target: ArtifactFeedbackTarget, deps: IntakeDeps): Promise<IntakeResult> {
  if (target.runtime !== 'static') return unsupported();
  const root = await realpathOrNull(target.root);
  if (root === null) return unavailable('The design folder could not be found.');

  const vaultBase = deps.vaultRoot();
  const vault = vaultBase ? await realpathOrNull(vaultBase) : null;
  if (vault === null) return unavailable();
  if (!isStrictlyInside(root, vault)) return unsupported();

  const manifest = await readManifest(root);
  if (!manifest || manifest.runtime !== 'static' || manifest.id !== target.artifactId) return unsupported();

  try {
    const thread = await deps.api.threads.get(manifest.createdByThreadId);
    if (!thread) return unavailable(THREAD_GONE_MESSAGE);
    const refs = await deps.api.artifacts.list(manifest.createdByThreadId);
    const ref = refs.find(candidate => candidate.kind === DESIGN_ARTIFACT_KIND && candidate.id === manifest.id);
    if (!ref) return unsupported();
    if (!ref.storageRoot) return { ok: false, reason: 'unsupported', message: STORAGE_UNKNOWN_MESSAGE };
    if ((await realpathOrNull(ref.storageRoot)) !== root) return unsupported();
  } catch {
    return unavailable();
  }

  const vaultPermission = (manifest.permissions as { vault?: unknown }).vault;
  return {
    ok: true,
    threadId: manifest.createdByThreadId,
    root,
    title: manifest.title,
    vaultRead: target.vaultRead || vaultPermission === 'read',
    manifest,
  };
}
