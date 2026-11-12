import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createArtifactCommentsProvider, type CommentsProviderController } from '../src/artifactCommentsProvider';
import { createCommentStore } from '../src/commentStore';
import { buildDesignManifest } from '../src/designArtifact';
import type { ArtifactCommentsProvider, ArtifactCommentsChange } from '../src/geodeArtifactFeedbackV2';
import type { ArtifactFeedbackRequest, ArtifactFeedbackTarget } from '../src/geodeArtifactFeedback';
import { writeSelectionFiles } from '../src/selectionFiles';
import { createFakeApi } from './helpers/fakeApi';
import { KEY } from './helpers/commentFixtures';
import { OTHER_SELECTION_ID, SELECTION_ID, validRequest } from './helpers/feedbackFixtures';

const NOW_MS = Date.parse('2026-11-08T20:01:00.000Z');
const CMT = `cmt_${SELECTION_ID.slice(4)}`;
const OTHER_CMT = `cmt_${OTHER_SELECTION_ID.slice(4)}`;

let base: string;
let root: string;
let controller: CommentsProviderController;
let provider: ArtifactCommentsProvider;
let target: ArtifactFeedbackTarget;
const ctx = () => ({ signal: new AbortController().signal });
const selectionsDir = () => path.join(root, '.threads-design', 'selections');
const commentsFile = () => path.join(root, '.threads-design', 'comments.json');
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve)); };

async function makeArtifact(manifestPatch: Record<string, unknown> = {}): Promise<string> {
  const dir = path.join(base, '.geode', 'artifacts', 'design-t1');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'artifact.json'), JSON.stringify({ ...buildDesignManifest('t1', 'Landing'), ...manifestPatch }));
  await fs.writeFile(path.join(dir, 'index.html'), '<main><h1 id="hero-title">Build faster</h1></main>\n');
  return dir;
}

function request(patch: Record<string, unknown> = {}, selectionPatch: Record<string, unknown> = {}): ArtifactFeedbackRequest {
  const req = validRequest(patch) as any;
  req.artifact.root = root;
  req.selection = { ...req.selection, ...selectionPatch };
  return req;
}

const redactedRequest = (selectionId = SELECTION_ID): ArtifactFeedbackRequest => {
  const req = request({ screenshot: null, screenshotOmitted: 'vault-read' }, { selectionId, redacted: true, textAnchor: { tag: 'h1', text: '' }, a11y: { role: 'heading', name: null, tabIndex: null } }) as any;
  req.artifact.vaultRead = true;
  return req;
};

function ok<T>(result: { status: string; value?: T; reason?: string; message?: string }): T {
  if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status} ${result.reason} ${result.message}`);
  return result.value as T;
}

/** Plain structured-cloneable data: survives a clone unchanged and carries no functions or classes. */
function expectDataOnly(value: unknown): void {
  expect(structuredClone(value)).toEqual(value);
  expect(JSON.parse(JSON.stringify(value))).toEqual(JSON.parse(JSON.stringify(structuredClone(value))));
}

beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'td-provider-')));
  root = await makeArtifact();
  const fake = createFakeApi();
  fake.addThread('t1', { artifacts: [{ providerId: 'agent-threads.design', kind: 'design-static', schemaVersion: 2, id: 'design-t1', title: 'Landing', data: {}, storageRoot: root }] });
  const store = createCommentStore({ keys: { getKey: async () => KEY }, now: () => new Date(NOW_MS) });
  controller = createArtifactCommentsProvider({ api: fake.api, vaultRoot: () => base, store, now: () => NOW_MS });
  controller.activate();
  provider = controller.provider;
  target = { root, artifactId: 'design-t1', title: 'Landing', runtime: 'static', vaultRead: false };
});
afterEach(async () => { controller.dispose(); await fs.rm(base, { recursive: true, force: true }); });

describe('provider surface', () => {
  it('advertises pins and batch send, and no text edit (2b-ii)', () => {
    expect(provider.capabilities).toEqual({ pins: true, batchSend: true, textEdit: false });
    expect((provider as any).commitTextEdit).toBeUndefined();
    expect((provider as any).undoTextEdit).toBeUndefined();
    expectDataOnly(provider.capabilities);
  });

  it('list on a fresh artifact is an empty, healthy snapshot and does not create comments.json', async () => {
    const snapshot = ok<any>(await provider.list(target, ctx()));
    expect(snapshot).toMatchObject({ health: 'ok', comments: [], foreignCount: 0, notice: null });
    expect(snapshot.storeId).toMatch(/^str_[0-9a-f]{32}$/);
    expectDataOnly(snapshot);
    expect(fsSync.existsSync(commentsFile())).toBe(false);
  });

  it('sendBatch is not available until P2b and says so without touching comments', async () => {
    const result = await provider.sendBatch(target, { requestId: `req_${'a'.repeat(32)}`, ids: [CMT], resend: false, anchorStates: {} }, ctx());
    expect(result).toMatchObject({ status: 'rejected', reason: 'unavailable' });
    expect(fsSync.existsSync(commentsFile())).toBe(false);
  });
});

describe('save (pins)', () => {
  it('saves an open pin with a derived id, anchor from the selection, and writes the selection files', async () => {
    const saved = ok<any>(await provider.save(target, { request: request() }, ctx()));
    expect(saved.created).toBe(true);
    expect(saved.comment).toMatchObject({
      id: CMT, selectionId: SELECTION_ID, ordinal: 1, version: 1, kind: 'pin', status: 'open', provenance: 'local',
      text: 'Make this heading larger.', createdAt: '2026-11-08T20:01:00.000Z', artifactRevision: 7, viewSessionId: 'view-1',
      hasScreenshot: true, redacted: false, label: 'h1 "Build faster"',
      anchor: { route: '/index.html', tag: 'h1', selector: '#hero-title', selectorAlternates: ['main > h1', 'h1.title.big'], textAnchor: { tag: 'h1', text: 'Build faster' }, landmark: 'Hero', lastRect: { x: 10, y: 120, width: 300, height: 40 } },
    });
    expectDataOnly(saved);
    expect(fsSync.existsSync(path.join(selectionsDir(), `${SELECTION_ID}.json`))).toBe(true);
    expect(fsSync.existsSync(path.join(selectionsDir(), `${SELECTION_ID}.png`))).toBe(true);
    const listed = ok<any>(await provider.list(target, ctx()));
    expect(listed.comments.map((c: any) => c.id)).toEqual([CMT]);
  });

  it('is idempotent: the same request again returns the existing comment; changed content is a conflict (T6)', async () => {
    ok(await provider.save(target, { request: request() }, ctx()));
    const again = ok<any>(await provider.save(target, { request: request({ submittedAt: '2026-11-08T20:00:30.000Z' }) }, ctx()));
    expect(again.created).toBe(false);
    expect(again.comment.ordinal).toBe(1);
    const different = await provider.save(target, { request: request({ comment: 'A different request.' }) }, ctx());
    expect(different).toMatchObject({ status: 'rejected', reason: 'conflict' });
    expect(ok<any>(await provider.list(target, ctx())).comments).toHaveLength(1);
  });

  it('rejects invalid requests without writing anything', async () => {
    const bad = await provider.save(target, { request: { ...request(), comment: '' } as never }, ctx());
    expect(bad).toMatchObject({ status: 'rejected', reason: 'invalid' });
    expect(await provider.save(target, undefined as never, ctx())).toMatchObject({ status: 'rejected', reason: 'invalid' });
    expect(await provider.save(target, { request: null } as never, ctx())).toMatchObject({ status: 'rejected', reason: 'invalid' });
    expect(fsSync.existsSync(path.join(root, '.threads-design'))).toBe(false);
  });

  it('refuses a selection captured more than 24 hours from now (forged capturedAt, T6)', async () => {
    const old = request({}, { capturedAt: '2026-11-06T20:00:00.000Z' });
    expect(await provider.save(target, { request: old }, ctx())).toMatchObject({ status: 'rejected', reason: 'invalid' });
    const future = request({}, { capturedAt: '2026-11-10T20:00:00.000Z' });
    expect(await provider.save(target, { request: future }, ctx())).toMatchObject({ status: 'rejected', reason: 'invalid' });
    expect(fsSync.existsSync(path.join(selectionsDir(), `${SELECTION_ID}.json`))).toBe(false);
  });

  it('vault-read pin has no PNG, no text anchor and a tag-only label (T11)', async () => {
    root = await makeArtifact({ permissions: { network: 'none', clipboard: false, vault: 'read' } });
    const saved = ok<any>(await provider.save({ ...target, vaultRead: true }, { request: redactedRequest() }, ctx()));
    expect(saved.comment).toMatchObject({ hasScreenshot: false, redacted: true, label: 'h1', anchor: { textAnchor: { tag: 'h1', text: '' }, landmark: null } });
    expect(fsSync.existsSync(path.join(selectionsDir(), `${SELECTION_ID}.png`))).toBe(false);
    expect(fsSync.existsSync(path.join(selectionsDir(), `${SELECTION_ID}.json`))).toBe(true);
    const detail = ok<any>(await provider.get(target, CMT, ctx()));
    expect(detail.selection).toMatchObject({ redacted: true, textAnchor: { text: '' }, a11y: { name: null } });
    expect(JSON.stringify(detail)).not.toContain('Build faster');
  });

  it('vault-read artifact refuses a PNG even if bytes are present and a non-redacted selection', async () => {
    root = await makeArtifact({ permissions: { network: 'none', clipboard: false, vault: 'read' } });
    expect(await provider.save(target, { request: request() }, ctx())).toMatchObject({ status: 'rejected', reason: 'invalid' });
    const withPng = redactedRequest() as any;
    withPng.screenshot = (validRequest() as any).screenshot;
    withPng.screenshotOmitted = null;
    const saved = ok<any>(await provider.save({ ...target, vaultRead: true }, { request: withPng }, ctx()));
    expect(saved.comment.hasScreenshot).toBe(false);
    expect(fsSync.existsSync(path.join(selectionsDir(), `${SELECTION_ID}.png`))).toBe(false);
  });

  it('a rejected save (read-only store) removes the selection files it just wrote', async () => {
    // Make the store read-only by planting a newer schema: saves are refused with read-only.
    controller.dispose();
    await fs.mkdir(path.join(root, '.threads-design'), { recursive: true });
    await fs.writeFile(commentsFile(), JSON.stringify({ schemaVersion: 999, kind: 'threads-design.comments', artifactId: 'design-t1', storeId: `str_${'1'.repeat(32)}`, rev: 1, nextOrdinal: 1, comments: [], tombstones: [], writtenBy: 'x', writtenAt: '2026-11-12T10:00:00.000Z', bodySha256: 'x' }));
    const fake = createFakeApi();
    fake.addThread('t1', { artifacts: [{ providerId: 'agent-threads.design', kind: 'design-static', schemaVersion: 2, id: 'design-t1', title: 'Landing', data: {}, storageRoot: root }] });
    controller = createArtifactCommentsProvider({ api: fake.api, vaultRoot: () => base, store: createCommentStore({ keys: { getKey: async () => KEY } }), now: () => NOW_MS });
    controller.activate();
    const result = await controller.provider.save(target, { request: request() }, ctx());
    expect(result).toMatchObject({ status: 'rejected', reason: 'read-only' });
    expect(fsSync.existsSync(path.join(selectionsDir(), `${SELECTION_ID}.json`))).toBe(false);
    expect(fsSync.existsSync(path.join(selectionsDir(), `${SELECTION_ID}.png`))).toBe(false);
  });
});

describe('get', () => {
  it('returns the comment and its validated selection snapshot', async () => {
    ok(await provider.save(target, { request: request() }, ctx()));
    const detail = ok<any>(await provider.get(target, CMT, ctx()));
    expect(detail.comment.id).toBe(CMT);
    expect(detail.selection).toMatchObject({ selectionId: SELECTION_ID, tag: 'h1', selector: '#hero-title', redacted: false });
    expectDataOnly(detail);
  });

  it('returns selection null when the sidecar was pruned, and rejects bad or unknown ids', async () => {
    ok(await provider.save(target, { request: request() }, ctx()));
    await fs.rm(path.join(selectionsDir(), `${SELECTION_ID}.json`));
    expect(ok<any>(await provider.get(target, CMT, ctx())).selection).toBeNull();
    expect(await provider.get(target, OTHER_CMT, ctx())).toMatchObject({ status: 'rejected', reason: 'not-found' });
    expect(await provider.get(target, '../../etc/passwd', ctx())).toMatchObject({ status: 'rejected', reason: 'invalid' });
  });

  it('returns selection null for a tampered sidecar (wrong shape, wrong id, symlink)', async () => {
    ok(await provider.save(target, { request: request() }, ctx()));
    const file = path.join(selectionsDir(), `${SELECTION_ID}.json`);
    await fs.writeFile(file, JSON.stringify({ selection: { selectionId: OTHER_SELECTION_ID } }));
    expect(ok<any>(await provider.get(target, CMT, ctx())).selection).toBeNull();
    await fs.writeFile(file, 'not json');
    expect(ok<any>(await provider.get(target, CMT, ctx())).selection).toBeNull();
    const outside = path.join(base, 'outside.json');
    await fs.writeFile(outside, JSON.stringify({ selection: (request() as any).selection }));
    await fs.rm(file);
    await fs.symlink(outside, file);
    expect(ok<any>(await provider.get(target, CMT, ctx())).selection).toBeNull();
  });
});

describe('update, remove, adopt', () => {
  it('resolves with the current version, rejects stale versions, and walks the transition table', async () => {
    const saved = ok<any>(await provider.save(target, { request: request() }, ctx()));
    const resolved = ok<any>(await provider.update(target, { id: CMT, expectedVersion: saved.comment.version, change: { action: 'resolve' } }, ctx()));
    expect(resolved).toMatchObject({ status: 'resolved', version: 2 });
    expectDataOnly(resolved);
    expect(await provider.update(target, { id: CMT, expectedVersion: 1, change: { action: 'reopen' } }, ctx())).toMatchObject({ status: 'rejected', reason: 'conflict' });
    expect(await provider.update(target, { id: CMT, expectedVersion: 2, change: { action: 'resolve' } }, ctx())).toMatchObject({ status: 'rejected', reason: 'invalid-transition' });
    expect(ok<any>(await provider.update(target, { id: CMT, expectedVersion: 2, change: { action: 'reopen' } }, ctx()))).toMatchObject({ status: 'open', version: 3 });
    expect(ok<any>(await provider.update(target, { id: CMT, expectedVersion: 3, change: { text: 'Shorter.' } }, ctx())).text).toBe('Shorter.');
    expect(await provider.update(target, { id: 'bogus', expectedVersion: 1, change: { action: 'resolve' } }, ctx())).toMatchObject({ status: 'rejected', reason: 'invalid' });
  });

  it('remove deletes the comment and its own selection files only', async () => {
    ok(await provider.save(target, { request: request() }, ctx()));
    ok(await provider.save(target, { request: request({}, { selectionId: OTHER_SELECTION_ID }) }, ctx()));
    expect(await provider.remove(target, { id: CMT, expectedVersion: 5 }, ctx())).toMatchObject({ status: 'rejected', reason: 'conflict' });
    expect(ok<any>(await provider.remove(target, { id: CMT, expectedVersion: 1 }, ctx()))).toEqual({ id: CMT });
    expect(fsSync.existsSync(path.join(selectionsDir(), `${SELECTION_ID}.json`))).toBe(false);
    expect(fsSync.existsSync(path.join(selectionsDir(), `${OTHER_SELECTION_ID}.json`))).toBe(true);
    expect(ok<any>(await provider.list(target, ctx())).comments.map((c: any) => c.id)).toEqual([OTHER_CMT]);
  });

  it('adopt on a local comment is an idempotent no-op', async () => {
    ok(await provider.save(target, { request: request() }, ctx()));
    expect(ok<any>(await provider.adopt(target, { ids: [CMT] }, ctx())).adopted).toEqual([]);
    expect(await provider.adopt(target, { ids: Array.from({ length: 21 }, () => CMT) }, ctx())).toMatchObject({ status: 'rejected', reason: 'invalid' });
    expect(await provider.adopt(target, { ids: ['nope'] }, ctx())).toMatchObject({ status: 'rejected', reason: 'invalid' });
  });
});

describe('target checks', () => {
  it('rejects targets that are not Design artifacts, as unavailable, without touching the disk', async () => {
    const other = path.join(base, 'elsewhere');
    await fs.mkdir(other, { recursive: true });
    for (const bad of [{ ...target, root: other }, { ...target, runtime: 'nextjs' as never }, { ...target, artifactId: 'someone-elses' }, { ...target, root: 'relative' }]) {
      expect(await provider.list(bad, ctx())).toMatchObject({ status: 'rejected', reason: 'unavailable' });
    }
    expect(fsSync.existsSync(path.join(other, '.threads-design'))).toBe(false);
  });

  it('answers unavailable and never opens the store before activation or after dispose (T12)', async () => {
    controller.dispose();
    const fake = createFakeApi();
    fake.addThread('t1', { artifacts: [{ providerId: 'agent-threads.design', kind: 'design-static', schemaVersion: 2, id: 'design-t1', title: 'Landing', data: {}, storageRoot: root }] });
    let keyReads = 0;
    const store = createCommentStore({ keys: { getKey: async () => { keyReads++; return KEY; } } });
    const inactive = createArtifactCommentsProvider({ api: fake.api, vaultRoot: () => base, store, now: () => NOW_MS });
    expect(await inactive.provider.list(target, ctx())).toMatchObject({ status: 'rejected', reason: 'unavailable' });
    expect(await inactive.provider.save(target, { request: request() }, ctx())).toMatchObject({ status: 'rejected', reason: 'unavailable' });
    expect(inactive.provider.subscribe(target, () => undefined)).toHaveProperty('dispose');
    await settle();
    expect(keyReads).toBe(0);
    expect(fsSync.existsSync(path.join(root, '.threads-design'))).toBe(false);
    inactive.activate();
    ok(await inactive.provider.list(target, ctx()));
    inactive.dispose();
    expect(await inactive.provider.list(target, ctx())).toMatchObject({ status: 'rejected', reason: 'unavailable' });
  });
});

describe('subscribe', () => {
  it('delivers one coalesced change for a burst, as data, and stops after dispose', async () => {
    ok(await provider.list(target, ctx()));
    const seen: ArtifactCommentsChange[] = [];
    const subscription = provider.subscribe(target, (change) => { seen.push(change); });
    await settle();
    await Promise.all([
      provider.save(target, { request: request() }, ctx()),
      provider.save(target, { request: request({}, { selectionId: OTHER_SELECTION_ID }) }, ctx()),
    ]);
    await settle();
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen.length).toBeLessThanOrEqual(2);
    const ids = new Set(seen.flatMap((c) => (c.ids === 'all' ? [] : [...c.ids])));
    expect(ids).toEqual(new Set([CMT, OTHER_CMT]));
    expect(seen.every((c) => c.reason === 'local' && /^str_[0-9a-f]{32}$/.test(c.storeId))).toBe(true);
    expectDataOnly(seen);
    subscription.dispose();
    subscription.dispose();
    seen.length = 0;
    ok(await provider.update(target, { id: CMT, expectedVersion: 1, change: { action: 'resolve' } }, ctx()));
    await settle();
    expect(seen).toEqual([]);
  });

  it('a listener that throws does not break the provider or other listeners', async () => {
    ok(await provider.list(target, ctx()));
    const seen: string[] = [];
    provider.subscribe(target, () => { throw new Error('boom'); });
    provider.subscribe(target, (c) => { seen.push(c.reason); });
    await settle();
    ok(await provider.save(target, { request: request() }, ctx()));
    await settle();
    expect(seen).toEqual(['local']);
  });

  it('disposing before the subscription attached leaves no listener behind', async () => {
    const seen: ArtifactCommentsChange[] = [];
    const subscription = provider.subscribe(target, (change) => { seen.push(change); });
    subscription.dispose();
    await settle();
    ok(await provider.save(target, { request: request() }, ctx()));
    await settle();
    expect(seen).toEqual([]);
  });
});

describe('selection retention protects pinned comments', () => {
  it('keeps selection files of every comment while unreferenced ones follow the retention rule', async () => {
    controller.dispose();
    const fake = createFakeApi();
    fake.addThread('t1', { artifacts: [{ providerId: 'agent-threads.design', kind: 'design-static', schemaVersion: 2, id: 'design-t1', title: 'Landing', data: {}, storageRoot: root }] });
    controller = createArtifactCommentsProvider({ api: fake.api, vaultRoot: () => base, store: createCommentStore({ keys: { getKey: async () => KEY } }), now: () => NOW_MS, retention: 1 });
    controller.activate();
    const stray = `sel_${'a'.repeat(32)}`;
    const newerStray = `sel_${'c'.repeat(32)}`;
    await writeSelectionFiles({ root, selectionId: stray, json: '{}', png: null, vaultRead: false });
    await fs.utimes(path.join(selectionsDir(), `${stray}.json`), new Date(NOW_MS - 3_600_000), new Date(NOW_MS - 3_600_000));
    await writeSelectionFiles({ root, selectionId: newerStray, json: '{}', png: null, vaultRead: false });
    const ids = [SELECTION_ID, OTHER_SELECTION_ID, `sel_${'b'.repeat(32)}`];
    for (const id of ids) ok(await controller.provider.save(target, { request: request({}, { selectionId: id }) }, ctx()));
    for (const id of ids) expect(fsSync.existsSync(path.join(selectionsDir(), `${id}.json`))).toBe(true);
    expect(fsSync.existsSync(path.join(selectionsDir(), `${stray}.json`))).toBe(false);
    expect(fsSync.existsSync(path.join(selectionsDir(), `${newerStray}.json`))).toBe(true);
  });
});
