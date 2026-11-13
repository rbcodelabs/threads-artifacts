import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DESIGN_PROVIDER_ID,
  DESIGN_PROVIDER_OWNER,
  DESIGN_STORAGE_NAMESPACE,
} from '../src/designArtifactProvider';
import { SIDECAR_DIR } from '../src/selectionFiles';

const read = (file: string) => readFileSync(resolve(__dirname, '..', file), 'utf8');

describe('plugin identity (rename to threads-artifacts)', () => {
  it('declares the new id and display name in the manifest and package', () => {
    const manifest = JSON.parse(read('manifest.json'));
    const pkg = JSON.parse(read('package.json'));
    expect(manifest.id).toBe('threads-artifacts');
    expect(manifest.name).toBe('Artifacts for Agent Threads');
    expect(pkg.name).toBe('threads-artifacts');
  });

  it('registers with the host under the new peer identity', () => {
    expect(DESIGN_PROVIDER_OWNER.pluginId).toBe('threads-artifacts');
    expect(DESIGN_PROVIDER_OWNER.displayName).toBe('Artifacts for Agent Threads');
  });

  it('exports the plugin class under the new name', () => {
    expect(read('src/main.ts')).toContain('export default class ThreadsArtifactsPlugin');
  });
});

describe('persisted names that must NOT change (compatibility)', () => {
  it('keeps the provider id existing artifact refs point at', () => {
    expect(DESIGN_PROVIDER_ID).toBe('agent-threads.design');
  });

  it('keeps the visible storage namespace, so designs stay under Artifacts/threads-design', () => {
    expect(DESIGN_STORAGE_NAMESPACE).toBe('threads-design');
  });

  it('keeps the .threads-design sidecar folder', () => {
    expect(SIDECAR_DIR).toBe('.threads-design');
  });
});
