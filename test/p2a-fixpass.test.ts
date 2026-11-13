import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createArtifactCommentsProvider, type CommentsProviderController } from '../src/artifactCommentsProvider';
import { createCommentStore, type CommentStore } from '../src/commentStore';
import { buildDesignManifest } from '../src/designArtifact';
import type { ArtifactFeedbackRequest, ArtifactFeedbackTarget } from '../src/geodeArtifactFeedback';
import type { ArtifactCommentsChange } from '../src/geodeArtifactFeedbackV2';
import { defaultOps, readSelectionJson, writeSelectionFiles } from '../src/selectionFiles';
import { KEY } from './helpers/commentFixtures';
import { createFakeApi } from './helpers/fakeApi';
import { OTHER_SELECTION_ID, SELECTION_ID, validRequest } from './helpers/feedbackFixtures';

const T0 = Date.parse('2026-11-08T20:01:00.000Z');
let base: string;
let root: string;
let target: ArtifactFeedbackTarget;
let clockMs: number;
let controllers: CommentsProviderController[] = [];
const ctx = () => ({ signal: new AbortController().signal });
const sel = (id = SELECTION_ID) => path.join(root, '.threads-design', 'selections', id);
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

function request(patch: Record<string, unknown> = {}, selectionPatch: Record<string, unknown> = {}): ArtifactFeedbackRequest {
  const req = validRequest(patch) as any;
  req.artifact.root = root;
  req.selection = { ...req.selection, ...selectionPatch };
  return req;
}

function make(opts: { store?: CommentStore; warn?: (m: string, e?: unknown) => void; activate?: boolean } = {}): CommentsProviderController {
  const fake = createFakeApi();
  fake.addThread('t1', { artifacts: [{ providerId: 'agent-threads.design', kind: 'design-static', schemaVersion: 2, id: 'design-t1', title: 'Landing', data: {}, storageRoot: root }] });
  const controller = createArtifactCommentsProvider({
    api: fake.api, vaultRoot: () => base, now: () => clockMs, warn: opts.warn,
    store: opts.store ?? createCommentStore({ keys: { getKey: async () => KEY }, now: () => new Date(clockMs) }),
  });
  if (opts.activate !== false) controller.activate();
  controllers.push(controller);
  return controller;
}

beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'td-fix-')));
  root = path.join(base, '.geode', 'artifacts', 'design-t1');
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, 'artifact.json'), JSON.stringify(buildDesignManifest('t1', 'Landing')));
  target = { root, artifactId: 'design-t1', title: 'Landing', runtime: 'static', vaultRead: false };
  clockMs = T0;
  controllers = [];
});
afterEach(async () => { controllers.forEach((c) => c.dispose()); await fs.rm(base, { recursive: true, force: true }); });

describe('cleanup removes only files this call created', () => {
  it('a conflicting save that adds a screenshot leaves the existing pin json and png intact', async () => {
    const { provider } = make();
    const first = request({ screenshot: null, screenshotOmitted: 'capture-failed' });
    expect((await provider.save(target, { request: first }, ctx())).status).toBe('ok');
    const before = fsSync.readFileSync(`${sel()}.json`, 'utf8');
    expect(fsSync.existsSync(`${sel()}.png`)).toBe(false);
    const conflicting = request({ comment: 'Changed my mind.' }); // different text, and now carries a screenshot
    expect(await provider.save(target, { request: conflicting }, ctx())).toMatchObject({ status: 'rejected', reason: 'conflict' });
    expect(fsSync.readFileSync(`${sel()}.json`, 'utf8')).toBe(before);
    // the png this losing call created for itself is removed, the winner never had one
    expect(fsSync.existsSync(`${sel()}.png`)).toBe(false);
  });

  it('a conflicting save never deletes a png the existing pin owns', async () => {
    const { provider } = make();
    expect((await provider.save(target, { request: request() }, ctx())).status).toBe('ok');
    expect(await provider.save(target, { request: request({ comment: 'Other.' }) }, ctx())).toMatchObject({ reason: 'conflict' });
    expect(fsSync.existsSync(`${sel()}.json`)).toBe(true);
    expect(fsSync.existsSync(`${sel()}.png`)).toBe(true);
  });

  it('a v1 Send record for the same selection id survives a rejected pin save', async () => {
    await writeSelectionFiles({ root, selectionId: SELECTION_ID, json: '{"v1":"send record"}\n', png: new Uint8Array([1, 2, 3]), vaultRead: false });
    await fs.writeFile(path.join(root, '.threads-design', 'comments.json'), JSON.stringify({ schemaVersion: 999, kind: 'threads-design.comments', artifactId: 'design-t1', storeId: `str_${'1'.repeat(32)}`, rev: 1, nextOrdinal: 1, comments: [], tombstones: [], writtenBy: 'x', writtenAt: '2026-11-12T10:00:00.000Z', bodySha256: 'x' }));
    const { provider } = make();
    expect(await provider.save(target, { request: request() }, ctx())).toMatchObject({ status: 'rejected', reason: 'read-only' });
    expect(fsSync.readFileSync(`${sel()}.json`, 'utf8')).toBe('{"v1":"send record"}\n');
    expect(fsSync.existsSync(`${sel()}.png`)).toBe(true);
  });

  it('writeSelectionFiles reports which files it created', async () => {
    const first = await writeSelectionFiles({ root, selectionId: SELECTION_ID, json: '{}', png: new Uint8Array([1]), vaultRead: false });
    expect(first).toMatchObject({ createdJson: true, createdPng: true, replay: false });
    const again = await writeSelectionFiles({ root, selectionId: SELECTION_ID, json: '{}', png: new Uint8Array([1]), vaultRead: false });
    expect(again).toMatchObject({ createdJson: false, createdPng: false, replay: true });
    const noPng = await writeSelectionFiles({ root, selectionId: OTHER_SELECTION_ID, json: '{}', png: null, vaultRead: false });
    expect(noPng).toMatchObject({ createdJson: true, createdPng: false });
  });

  it('even a files-created call keeps them when a comment for that id exists (second guard)', async () => {
    const { provider } = make();
    expect((await provider.save(target, { request: request() }, ctx())).status).toBe('ok');
    // The sidecar was pruned away; a conflicting save re-creates files, then loses. The comment still exists: keep them.
    await fs.rm(`${sel()}.json`);
    await fs.rm(`${sel()}.png`);
    expect(await provider.save(target, { request: request({ comment: 'Other.' }) }, ctx())).toMatchObject({ reason: 'conflict' });
    expect(fsSync.existsSync(`${sel()}.json`)).toBe(true);
  });
});

describe('failed store open is not cached', () => {
  it('retries the open on the next call', async () => {
    const real = createCommentStore({ keys: { getKey: async () => KEY } });
    let opens = 0;
    const store: CommentStore = { open: async (t) => { opens++; if (opens === 1) throw new Error('disk hiccup'); return real.open(t); } };
    const { provider } = make({ store, warn: () => undefined });
    expect(await provider.list(target, ctx())).toMatchObject({ status: 'rejected', reason: 'failed' });
    expect((await provider.list(target, ctx())).status).toBe('ok');
    expect(opens).toBe(2);
  });
});

describe('subscribe before activation', () => {
  it('attaches when the provider is activated and delivers changes', async () => {
    const controller = make({ activate: false });
    const seen: ArtifactCommentsChange[] = [];
    controller.provider.subscribe(target, (c) => { seen.push(c); });
    await settle();
    controller.activate();
    await settle();
    expect((await controller.provider.save(target, { request: request() }, ctx())).status).toBe('ok');
    await settle();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((c) => c.reason === 'local')).toBe(true);
  });

  it('a subscription disposed before activation never attaches', async () => {
    const controller = make({ activate: false });
    const seen: ArtifactCommentsChange[] = [];
    controller.provider.subscribe(target, (c) => { seen.push(c); }).dispose();
    controller.activate();
    await settle();
    await controller.provider.save(target, { request: request() }, ctx());
    await settle();
    expect(seen).toEqual([]);
  });

  it('tells the listener to re-list when the store refuses the subscription (listener cap)', async () => {
    const { provider } = make();
    const seen: ArtifactCommentsChange[] = [];
    for (let i = 0; i < 9; i++) provider.subscribe(target, (c) => { seen.push(c); });
    // Exactly one of the nine is refused by the store (cap 8); attachment order is not guaranteed, so any of them may be it.
    await vi.waitFor(() => expect(seen).toHaveLength(1), { timeout: 5000 });
    expect(seen[0]).toMatchObject({ reason: 'recovered', ids: 'all' });
  });
});

describe('readSelectionJson bounds the read', () => {
  it('rejects a file that grows past the cap after the size check, reading at most cap+1 bytes', async () => {
    await writeSelectionFiles({ root, selectionId: SELECTION_ID, json: 'x'.repeat(300 * 1024), png: null, vaultRead: false });
    const file = `${sel()}.json`;
    let requested = 0;
    const ops = {
      ...defaultOps,
      lstat: (async (p: string) => { const s = await fs.lstat(p); return p === file ? Object.assign(Object.create(Object.getPrototypeOf(s)), s, { size: 10 }) : s; }) as typeof fs.lstat,
      open: (async (p: string, flags?: any, mode?: any) => {
        const h = await fs.open(p, flags, mode);
        if (p !== file) return h;
        return new Proxy(h, {
          get(t, k) {
            if (k === 'stat') return async () => { const s = await t.stat(); return Object.assign(Object.create(Object.getPrototypeOf(s)), s, { size: 10 }); };
            if (k === 'readFile') return async () => { requested += 300 * 1024; return 'x'.repeat(300 * 1024); };
            if (k === 'read') return async (buf: Buffer, off: number, len: number, pos: number) => { requested += len; return t.read(buf, off, len, pos); };
            const v = (t as any)[k];
            return typeof v === 'function' ? v.bind(t) : v;
          },
        });
      }) as typeof fs.open,
    };
    expect(await readSelectionJson(root, SELECTION_ID, ops)).toBeNull();
    expect(requested).toBeLessThanOrEqual(256 * 1024 + 1 + 16 * 1024);
  });
});

describe('labels and timestamps', () => {
  it('truncates by code points: no lone surrogate, within 120 units', async () => {
    const { provider } = make();
    const name = '😀'.repeat(100);
    const saved: any = await provider.save(target, { request: request({}, { a11y: { role: 'heading', name, tabIndex: null } }) }, ctx());
    expect(saved.status).toBe('ok');
    const label: string = saved.value.comment.label;
    expect(label.length).toBeLessThanOrEqual(120);
    expect(label).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
  });

  it('createdAt is the host clock; capturedAt is only the staleness check; a later retry is still idempotent', async () => {
    const { provider } = make();
    const saved: any = await provider.save(target, { request: request() }, ctx());
    expect(saved.value.comment.createdAt).toBe('2026-11-08T20:01:00.000Z');
    clockMs = T0 + 60_000;
    const again: any = await provider.save(target, { request: request({ submittedAt: '2026-11-08T20:01:30.000Z' }) }, ctx());
    expect(again).toMatchObject({ status: 'ok', value: { created: false } });
    expect(again.value.comment.createdAt).toBe('2026-11-08T20:01:00.000Z');
  });
});

describe('unhealthy store', () => {
  it('logs once that pruning was skipped, however many pins are saved', async () => {
    await fs.mkdir(path.join(root, '.threads-design'), { recursive: true });
    await fs.writeFile(path.join(root, '.threads-design', 'comments.json'), '{ this is not json');
    const warn = vi.fn();
    const { provider } = make({ warn });
    expect((await provider.save(target, { request: request() }, ctx())).status).toBe('ok');
    expect((await provider.save(target, { request: request({}, { selectionId: OTHER_SELECTION_ID }) }, ctx())).status).toBe('ok');
    const skipped = warn.mock.calls.filter(([m]) => /retention|pruning/i.test(String(m)));
    expect(skipped).toHaveLength(1);
  });
});
