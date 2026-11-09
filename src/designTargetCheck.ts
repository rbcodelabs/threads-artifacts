import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseDesignManifest } from './designArtifact';
import type { ArtifactFeedbackTarget } from './geodeArtifactFeedback';

/**
 * Cheap synchronous "is this plausibly a Design static artifact?" check behind `canHandle`, so the
 * Pick button is not offered on other plugins' static artifacts (spec 13c limitation, QA B1).
 * It is advisory only: `submit` still performs the full intake. It reads the manifest (small, local)
 * and caches each answer briefly; any problem means "no", never an exception.
 */

const MAX_MANIFEST_BYTES = 64 * 1024;
const DEFAULT_TTL_MS = 5000;
const MAX_CACHE_ENTRIES = 64;

export interface DesignTargetCheckOptions {
  readonly vaultRoot: () => string | undefined;
  readonly now?: () => number;
  readonly ttlMs?: number;
}

function check(target: ArtifactFeedbackTarget, vaultBase: string | undefined): boolean {
  if (!target || target.runtime !== 'static' || typeof target.root !== 'string' || !path.isAbsolute(target.root)) return false;
  if (!vaultBase) return false;
  const vault = fs.realpathSync.native(vaultBase);
  const root = fs.realpathSync.native(target.root);
  if (!root.startsWith(`${vault}${path.sep}`)) return false;
  const manifestPath = path.join(root, 'artifact.json');
  const stat = fs.lstatSync(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_MANIFEST_BYTES) return false;
  const manifest = parseDesignManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
  return manifest.runtime === 'static' && manifest.id === target.artifactId;
}

export function createDesignTargetCheck(options: DesignTargetCheckOptions): (target: ArtifactFeedbackTarget) => boolean {
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? DEFAULT_TTL_MS;
  const cache = new Map<string, { value: boolean; at: number }>();
  return target => {
    try {
      const key = `${target.root}\0${target.artifactId}`;
      const hit = cache.get(key);
      if (hit && now() - hit.at < ttl) return hit.value;
      let value = false;
      try {
        value = check(target, options.vaultRoot());
      } catch {
        value = false;
      }
      if (cache.size >= MAX_CACHE_ENTRIES) cache.clear();
      cache.set(key, { value, at: now() });
      return value;
    } catch {
      return false;
    }
  };
}
