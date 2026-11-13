import { THREAD_GONE_MESSAGE } from '../src/threadGone';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildDesignManifest } from '../src/designArtifact';
import { STORAGE_UNKNOWN_MESSAGE, resolveFeedbackTarget } from '../src/feedbackIntake';
import type { ArtifactFeedbackTarget } from '../src/geodeArtifactFeedback';
import { createFakeApi, FakeApiError } from './helpers/fakeApi';

let base: string;
let vault: string;
let allowed: string;
let fake: ReturnType<typeof createFakeApi>;

beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'td-intake-')));
  vault = path.join(base, 'vault');
  allowed = path.join(vault, '.geode', 'artifacts');
  await fs.mkdir(allowed, { recursive: true });
  fake = createFakeApi();
});
afterEach(async () => { await fs.rm(base, { recursive: true, force: true }); });

async function makeArtifact(parent = allowed, name = 'design-t1', manifestPatch: Record<string, unknown> = {}): Promise<string> {
  const root = path.join(parent, name);
  await fs.mkdir(root, { recursive: true });
  const manifest = { ...buildDesignManifest('t1', 'Landing'), ...manifestPatch };
  await fs.writeFile(path.join(root, 'artifact.json'), JSON.stringify(manifest));
  return root;
}

const designRef = (root: string, patch: Record<string, unknown> = {}) => ({ providerId: 'agent-threads.design', kind: 'design-static', schemaVersion: 2, id: 'design-t1', title: 'Landing', data: {}, storageRoot: root, ...patch });
const target = (root: string, patch: Partial<ArtifactFeedbackTarget> = {}): ArtifactFeedbackTarget => ({ root, artifactId: 'design-t1', title: 'Landing', runtime: 'static', vaultRead: false, ...patch });
const resolve = (t: ArtifactFeedbackTarget, vaultRoot: string = vault) => resolveFeedbackTarget(t, { api: fake.api, vaultRoot: () => vaultRoot });

describe('resolveFeedbackTarget', () => {
  it('maps a design artifact to its creating thread', async () => {
    const root = await makeArtifact();
    fake.addThread('t1', { artifacts: [designRef(root) as never] });
    const result = await resolve(target(root));
    expect(result).toMatchObject({ ok: true, threadId: 't1', root, title: 'Landing', vaultRead: false });
  });

  it('accepts a visible folder with a non-default name (the host owns that setting) (R-B2)', async () => {
    const visible = path.join(vault, 'My Designs', 'threads-design');
    const root = await makeArtifact(visible);
    fake.addThread('t1', { artifacts: [designRef(root) as never] });
    expect((await resolve(target(root))).ok).toBe(true);
  });

  it('requires the thread artifact to record a storageRoot, with a clear message (R-B2, A1)', async () => {
    const root = await makeArtifact();
    fake.addThread('t1', { artifacts: [designRef(root, { storageRoot: undefined }) as never] });
    expect(await resolve(target(root))).toEqual({ ok: false, reason: 'unsupported', message: STORAGE_UNKNOWN_MESSAGE });
  });

  it('rejects a recorded storageRoot that lies outside the vault', async () => {
    const root = await makeArtifact(path.join(base, 'elsewhere'));
    fake.addThread('t1', { artifacts: [designRef(root) as never] });
    expect(await resolve(target(root))).toMatchObject({ ok: false, reason: 'unsupported' });
  });

  it('is unavailable when the vault base path is unknown', async () => {
    const root = await makeArtifact();
    fake.addThread('t1', { artifacts: [designRef(root) as never] });
    expect(await resolve(target(root), '')).toMatchObject({ ok: false, reason: 'unavailable' });
  });

  it('rejects a root outside the vault', async () => {
    const root = await makeArtifact(path.join(base, 'elsewhere'));
    fake.addThread('t1', { artifacts: [designRef(root) as never] });
    expect(await resolve(target(root))).toMatchObject({ ok: false, reason: 'unsupported' });
  });

  it('rejects the storage root itself and a symlink that escapes it', async () => {
    expect(await resolve(target(vault))).toMatchObject({ ok: false });
    const real = await makeArtifact(path.join(base, 'elsewhere'));
    await fs.symlink(real, path.join(allowed, 'design-link'));
    fake.addThread('t1', { artifacts: [designRef(real) as never] });
    expect(await resolve(target(path.join(allowed, 'design-link')))).toMatchObject({ ok: false, reason: 'unsupported' });
  });

  it('rejects a missing folder', async () => {
    expect(await resolve(target(path.join(allowed, 'gone')))).toMatchObject({ ok: false });
  });

  it('only supports design-static manifests whose id matches', async () => {
    const root = await makeArtifact(allowed, 'design-t1', { id: 'design-other' });
    fake.addThread('t1', { artifacts: [designRef(root) as never] });
    expect(await resolve(target(root))).toMatchObject({ ok: false, reason: 'unsupported' });
    const app = await makeArtifact(allowed, 'design-app', { ...buildDesignManifest('t1', 'x', 'nextjs') });
    expect(await resolve(target(app, { artifactId: 'design-t1' }))).toMatchObject({ ok: false, reason: 'unsupported' });
  });

  it('rejects a missing, malformed, symlinked or oversized artifact.json', async () => {
    const root = path.join(allowed, 'design-t1');
    await fs.mkdir(root, { recursive: true });
    expect(await resolve(target(root))).toMatchObject({ ok: false, reason: 'unsupported' });
    await fs.writeFile(path.join(root, 'artifact.json'), '{not json');
    expect(await resolve(target(root))).toMatchObject({ ok: false, reason: 'unsupported' });
    await fs.rm(path.join(root, 'artifact.json'));
    const real = path.join(base, 'real.json');
    await fs.writeFile(real, JSON.stringify(buildDesignManifest('t1', 'x')));
    await fs.symlink(real, path.join(root, 'artifact.json'));
    expect(await resolve(target(root))).toMatchObject({ ok: false, reason: 'unsupported' });
    await fs.rm(path.join(root, 'artifact.json'));
    await fs.writeFile(path.join(root, 'artifact.json'), 'x'.repeat(70_000));
    expect(await resolve(target(root))).toMatchObject({ ok: false, reason: 'unsupported' });
  });

  it('reports a deleted or archived thread (threads.get returns null) as unavailable with the archived-or-deleted wording', async () => {
    const root = await makeArtifact();
    expect(await resolve(target(root))).toMatchObject({ ok: false, reason: 'unavailable', message: THREAD_GONE_MESSAGE });
    expect(THREAD_GONE_MESSAGE).toBe('The thread that created this design was archived or deleted, so the comment could not be sent.');
  });

  it('requires the thread to still own a design-static artifact with this id', async () => {
    const root = await makeArtifact();
    fake.addThread('t1', { artifacts: [] });
    expect(await resolve(target(root))).toMatchObject({ ok: false, reason: 'unsupported' });
    fake.addThread('t1', { artifacts: [designRef(root, { kind: 'design-app' }) as never] });
    expect(await resolve(target(root))).toMatchObject({ ok: false, reason: 'unsupported' });
  });

  it('rejects when the thread artifact points at a different folder', async () => {
    const root = await makeArtifact();
    const other = await makeArtifact(allowed, 'design-copy');
    fake.addThread('t1', { artifacts: [designRef(other) as never] });
    expect(await resolve(target(root))).toMatchObject({ ok: false, reason: 'unsupported' });
  });

  it('accepts a thread artifact reached through a symlink alias of the same folder', async () => {
    const root = await makeArtifact();
    const alias = path.join(base, 'alias');
    await fs.symlink(root, alias);
    fake.addThread('t1', { artifacts: [designRef(alias) as never] });
    expect((await resolve(target(root))).ok).toBe(true);
  });

  it('treats permissions.vault read in the manifest as vault-read even if the request says otherwise', async () => {
    const root = await makeArtifact(allowed, 'design-t1', { permissions: { network: 'none', clipboard: false, vault: 'read' } });
    fake.addThread('t1', { artifacts: [designRef(root) as never] });
    expect(await resolve(target(root, { vaultRead: false }))).toMatchObject({ ok: true, vaultRead: true });
  });

  it('keeps vaultRead true when only the request says so', async () => {
    const root = await makeArtifact();
    fake.addThread('t1', { artifacts: [designRef(root) as never] });
    expect(await resolve(target(root, { vaultRead: true }))).toMatchObject({ ok: true, vaultRead: true });
  });

  it('maps Agent Threads failures to unavailable', async () => {
    const root = await makeArtifact();
    fake.addThread('t1', { artifacts: [designRef(root) as never] });
    (fake.api.threads as any).get = async () => { throw new FakeApiError('PLUGIN_UNAVAILABLE'); };
    expect(await resolve(target(root))).toMatchObject({ ok: false, reason: 'unavailable' });
  });
});
