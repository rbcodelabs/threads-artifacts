import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createArtifactFeedbackHandler } from '../src/artifactFeedbackHandler';
import { createArtifactCommentsProvider, type CommentsProviderController } from '../src/artifactCommentsProvider';
import { createCommentStore, type CommentStore } from '../src/commentStore';
import { buildDesignManifest } from '../src/designArtifact';
import type { ArtifactFeedbackRequest, ArtifactFeedbackTarget } from '../src/geodeArtifactFeedback';
import type { ArtifactCommentsChange, ArtifactCommentsProvider } from '../src/geodeArtifactFeedbackV2';
import { defaultOps, readSelectionJson } from '../src/selectionFiles';
import { createSendCoordinator } from '../src/sendCoordinator';
import { createFakeApi } from './helpers/fakeApi';
import { createFakeClock } from './helpers/fakeClock';
import { fileOf, KEY, stored } from './helpers/commentFixtures';
import { OTHER_SELECTION_ID, SELECTION_ID, validRequest } from './helpers/feedbackFixtures';

/** QA probes for the P2a fix pass (f53d22d): cleanup ownership, replay without createdAt, early subscribe, bounded read, labels. */

const T0 = Date.parse('2026-11-08T20:01:00.000Z');
const HOUR = 3_600_000;
const CMT = `cmt_${SELECTION_ID.slice(4)}`;
let clockMs = T0;
let base: string;
let root: string;
let target: ArtifactFeedbackTarget;
let controller: CommentsProviderController;
let provider: ArtifactCommentsProvider;
let warnings: string[];
let keyReads: number;
const ctx = () => ({ signal: new AbortController().signal });
const sidecar = () => path.join(root, '.threads-design');
const selections = () => path.join(sidecar(), 'selections');
const exists = (p: string) => fsSync.existsSync(p);
const sel = (ext: string, id = SELECTION_ID) => path.join(selections(), `${id}.${ext}`);
const wait = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

function ok<T>(r: { status: string; value?: T; reason?: string; message?: string }): T {
  if (r.status !== 'ok') throw new Error(`expected ok, got ${r.status} ${r.reason} ${r.message}`);
  return r.value as T;
}

function request(patch: Record<string, unknown> = {}, selectionPatch: Record<string, unknown> = {}): ArtifactFeedbackRequest {
  const req = validRequest(patch) as any;
  req.artifact.root = root;
  req.selection = { ...req.selection, ...selectionPatch };
  return req;
}
const noShot = { screenshot: null, screenshotOmitted: 'too-large' };

function fakeFor() {
  const fake = createFakeApi();
  fake.addThread('t1', { artifacts: [{ providerId: 'agent-threads.design', kind: 'design-static', schemaVersion: 2, id: 'design-t1', title: 'Landing', data: {}, storageRoot: root }] });
  return fake;
}

function build(opts: { store?: CommentStore; retention?: number; activate?: boolean } = {}) {
  controller?.dispose();
  const fake = fakeFor();
  const store = opts.store ?? createCommentStore({ keys: { getKey: async () => { keyReads++; return KEY; } }, now: () => new Date(clockMs) });
  controller = createArtifactCommentsProvider({ api: fake.api, vaultRoot: () => base, store, now: () => clockMs, retention: opts.retention, warn: (message) => { warnings.push(message); } });
  if (opts.activate !== false) controller.activate();
  provider = controller.provider;
  return fake;
}

/** Wraps a store so that the Nth create call (1-based) waits for `gate` before it runs. */
function stallingStore(stallCall: number, gate: Promise<void>): { store: CommentStore; created: () => number } {
  const real = createCommentStore({ keys: { getKey: async () => KEY }, now: () => new Date(clockMs) });
  let calls = 0;
  const store = {
    ...real,
    open: async (input: any) => {
      const handle: any = await real.open(input);
      return new Proxy(handle, {
        get(h: any, prop) {
          if (prop !== 'create') return typeof h[prop] === 'function' ? h[prop].bind(h) : h[prop];
          return async (draft: any) => {
            calls += 1;
            if (calls === stallCall) await gate;
            return h.create(draft);
          };
        },
      });
    },
  } as CommentStore;
  return { store, created: () => calls };
}

beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'td-qa-fix-')));
  root = path.join(base, '.geode', 'artifacts', 'design-t1');
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, 'artifact.json'), JSON.stringify(buildDesignManifest('t1', 'Landing')));
  await fs.writeFile(path.join(root, 'index.html'), '<main><h1 id="hero-title">Build faster</h1></main>\n');
  clockMs = T0;
  warnings = [];
  keyReads = 0;
  build();
  target = { root, artifactId: 'design-t1', title: 'Landing', runtime: 'static', vaultRead: false };
});
afterEach(async () => { controller.dispose(); await fs.rm(base, { recursive: true, force: true }); });

describe('cleanup ownership under concurrent same-id saves', () => {
  /** First caller writes files then stalls before create; second caller runs to completion; then the first resumes. */
  async function race(first: ArtifactFeedbackRequest, second: ArtifactFeedbackRequest) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    build({ store: stallingStore(1, gate).store });
    const a = provider.save(target, { request: first }, ctx());
    await wait();
    const b = await provider.save(target, { request: second }, ctx());
    release();
    return { a: await a, b };
  }

  it('both with screenshots, different text: loser conflicts, winner keeps json, png and its selection snapshot', async () => {
    const { a, b } = await race(request({ comment: 'B' }), request({ comment: 'A' }));
    expect(b.status).toBe('ok');
    expect(a).toMatchObject({ status: 'rejected', reason: 'conflict' });
    expect(exists(sel('json')) && exists(sel('png'))).toBe(true);
    const detail = ok<any>(await provider.get(target, CMT, ctx()));
    expect(detail.comment.text).toBe('A');
    expect(detail.comment.hasScreenshot).toBe(true);
    expect(detail.selection).not.toBeNull();
  });

  it('winner has no screenshot, loser added a png first: the orphan png goes, the json stays', async () => {
    const { a, b } = await race(request({ comment: 'B' }), request({ comment: 'A', ...noShot }));
    expect(b.status).toBe('ok');
    expect(a).toMatchObject({ status: 'rejected', reason: 'conflict' });
    expect(ok<any>(await provider.get(target, CMT, ctx())).comment.hasScreenshot).toBe(false);
    expect(exists(sel('json'))).toBe(true);
    expect(exists(sel('png')), 'orphan png left behind').toBe(false);
  });

  it('winner has a screenshot, loser had none: nothing is removed', async () => {
    const { a, b } = await race(request({ comment: 'B', ...noShot }), request({ comment: 'A' }));
    expect(b.status).toBe('ok');
    expect(a).toMatchObject({ status: 'rejected', reason: 'conflict' });
    expect(exists(sel('json')) && exists(sel('png'))).toBe(true);
    expect(ok<any>(await provider.get(target, CMT, ctx())).selection).not.toBeNull();
  });

  it('identical content in both: both ok, one comment, files intact', async () => {
    const { a, b } = await race(request(), request());
    expect(a.status).toBe('ok');
    expect(b.status).toBe('ok');
    expect(ok<any>(await provider.list(target, ctx())).comments).toHaveLength(1);
    expect(exists(sel('json')) && exists(sel('png'))).toBe(true);
  });

  it('a v1 Send record for the same selection id survives a pin save that is refused (limit) and one that conflicts', async () => {
    // v1 Send writes the record first.
    const coordinator = createSendCoordinator({ api: fakeFor().api, ownerPluginId: 'threads-design', clock: createFakeClock() });
    const fake = fakeFor();
    const handler = createArtifactFeedbackHandler({ api: fake.api, coordinator, vaultRoot: () => base, boundarySecret: 's' });
    expect((await handler.submit(request(), { signal: ctx().signal })).status).toBe('accepted');
    coordinator.dispose();
    const record = await fs.readFile(sel('json'), 'utf8');
    expect(JSON.parse(record).contractVersion).toBe(1);

    // limit: 200 comments planted
    await fs.writeFile(path.join(sidecar(), 'comments.json'), JSON.stringify(fileOf(Array.from({ length: 200 }, (_, n) => stored(n + 1000)))));
    build();
    expect(await provider.save(target, { request: request() }, ctx())).toMatchObject({ status: 'rejected', reason: 'limit' });
    expect(await fs.readFile(sel('json'), 'utf8')).toBe(record);
    expect(exists(sel('png'))).toBe(true);
  });

  it('a pin saved on top of an existing v1 Send record keeps that record and reads its selection back', async () => {
    const coordinator = createSendCoordinator({ api: fakeFor().api, ownerPluginId: 'threads-design', clock: createFakeClock() });
    const handler = createArtifactFeedbackHandler({ api: fakeFor().api, coordinator, vaultRoot: () => base, boundarySecret: 's' });
    await handler.submit(request(), { signal: ctx().signal });
    coordinator.dispose();
    const record = await fs.readFile(sel('json'), 'utf8');
    ok(await provider.save(target, { request: request() }, ctx()));
    expect(await fs.readFile(sel('json'), 'utf8')).toBe(record);
    expect(ok<any>(await provider.get(target, CMT, ctx())).selection).not.toBeNull();
  });

  it('a refused save that created its own files and no comment exists removes exactly those', async () => {
    await fs.mkdir(sidecar(), { recursive: true });
    await fs.writeFile(path.join(sidecar(), 'comments.json'), JSON.stringify(fileOf(Array.from({ length: 200 }, (_, n) => stored(n + 1000)))));
    build();
    // an unrelated, older selection stays
    await fs.mkdir(selections(), { recursive: true });
    await fs.writeFile(sel('json', OTHER_SELECTION_ID), '{}');
    expect(await provider.save(target, { request: request() }, ctx())).toMatchObject({ reason: 'limit' });
    expect(exists(sel('json')) || exists(sel('png'))).toBe(false);
    expect(exists(sel('json', OTHER_SELECTION_ID))).toBe(true);
  });
});

describe('replay is idempotent on content, not on the host clock (P1 store change)', () => {
  it('a retry an hour later with a different capturedAt is ok, created:false, and createdAt stays the first host time', async () => {
    const first = ok<any>(await provider.save(target, { request: request({}, { capturedAt: new Date(T0 - 20 * HOUR).toISOString() }) }, ctx()));
    expect(first.comment.createdAt).toBe(new Date(T0).toISOString());
    clockMs = T0 + HOUR;
    const retry = ok<any>(await provider.save(target, { request: request({}, { capturedAt: new Date(T0 - 19 * HOUR).toISOString() }) }, ctx()));
    expect(retry.created).toBe(false);
    expect(retry.comment.createdAt).toBe(new Date(T0).toISOString());
    expect(retry.comment.version).toBe(first.comment.version);
    expect(ok<any>(await provider.list(target, ctx())).comments).toHaveLength(1);
  });

  it.each([
    ['text', { comment: 'Changed text.' }, {}],
    ['selector', {}, { selector: '#other' }],
    ['alternates', {}, { selectorAlternates: ['x > y'] }],
    ['route', {}, { route: '/b.html' }],
    ['tag', {}, { tag: 'h2' }],
    ['artifactRevision', {}, { artifactRevision: 8 }],
    ['viewSessionId', {}, { viewSessionId: 'view-2' }],
    ['landmark', {}, { landmark: 'Footer' }],
    ['rect', {}, { boundingBox: { viewport: { x: 1, y: 2, width: 3, height: 4 }, document: { x: 9, y: 9, width: 30, height: 40 } } }],
    ['screenshot presence', { screenshot: null, screenshotOmitted: 'too-large' }, {}],
    ['redacted flag', {}, { redacted: true }],
    ['accessible name (label)', {}, { a11y: { role: 'heading', name: 'Other name', tabIndex: null } }],
  ])('real conflict is still a conflict when %s differs', async (_name, patch, selPatch) => {
    ok(await provider.save(target, { request: request() }, ctx()));
    clockMs += HOUR;
    const result = await provider.save(target, { request: request(patch, selPatch) }, ctx());
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'rejected', reason: 'conflict' });
    expect(ok<any>(await provider.get(target, CMT, ctx())).comment.text).toBe('Make this heading larger.');
  });

  it('a retry after the pin was resolved still returns the existing comment and does not reopen it', async () => {
    const saved = ok<any>(await provider.save(target, { request: request() }, ctx()));
    ok(await provider.update(target, { id: CMT, expectedVersion: saved.comment.version, change: { action: 'resolve' } }, ctx()));
    clockMs += HOUR;
    const retry = ok<any>(await provider.save(target, { request: request() }, ctx()));
    expect(retry).toMatchObject({ created: false, comment: { status: 'resolved' } });
  });

  it('a retry after the user edited the text is a conflict (the stored text is the truth)', async () => {
    const saved = ok<any>(await provider.save(target, { request: request() }, ctx()));
    ok(await provider.update(target, { id: CMT, expectedVersion: saved.comment.version, change: { text: 'Edited.' } }, ctx()));
    expect(await provider.save(target, { request: request() }, ctx())).toMatchObject({ status: 'rejected', reason: 'conflict' });
  });

  it('pin, delete, pin again gets a fresh createdAt and a new ordinal (tombstone path unaffected)', async () => {
    const one = ok<any>(await provider.save(target, { request: request() }, ctx()));
    ok(await provider.remove(target, { id: CMT, expectedVersion: one.comment.version }, ctx()));
    clockMs += HOUR;
    const two = ok<any>(await provider.save(target, { request: request() }, ctx()));
    expect(two.created).toBe(true);
    expect(two.comment.createdAt).toBe(new Date(clockMs).toISOString());
    expect(two.comment.ordinal).toBeGreaterThan(one.comment.ordinal);
  });

  it('createdAt follows the host clock, never the embedder capturedAt; skew still bounds capturedAt', async () => {
    const saved = ok<any>(await provider.save(target, { request: request({}, { capturedAt: new Date(T0 + 23 * HOUR).toISOString() }) }, ctx()));
    expect(saved.comment.createdAt).toBe(new Date(T0).toISOString());
    const bad = `sel_${'7'.repeat(32)}`;
    expect(await provider.save(target, { request: request({}, { selectionId: bad, capturedAt: new Date(T0 + 25 * HOUR).toISOString() }) }, ctx())).toMatchObject({ status: 'rejected', reason: 'invalid' });
  });

  it('the list order and ordinals are unaffected: three pins at advancing host times', async () => {
    for (let n = 1; n <= 3; n++) {
      clockMs += 1000;
      ok(await provider.save(target, { request: request({}, { selectionId: `sel_${n.toString(16).padStart(32, '0')}` }) }, ctx()));
    }
    const comments = ok<any>(await provider.list(target, ctx())).comments;
    expect(comments.map((c: any) => c.ordinal)).toEqual([1, 2, 3]);
    expect(comments.map((c: any) => c.createdAt)).toEqual([...comments.map((c: any) => c.createdAt)].sort());
  });
});

describe('subscribe before activation and the listener cap', () => {
  it('a subscription made before activate() touches nothing, then attaches on activation and hears the first change', async () => {
    build({ activate: false });
    const seen: ArtifactCommentsChange[] = [];
    const getSpy = vi.spyOn(fakeFor().api.threads, 'get');
    const sub = provider.subscribe(target, (c) => { seen.push(c); });
    await wait();
    expect(keyReads).toBe(0);
    expect(exists(sidecar())).toBe(false);
    expect(getSpy).not.toHaveBeenCalled();
    controller.activate();
    await wait();
    ok(await provider.save(target, { request: request() }, ctx()));
    await wait();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toMatchObject({ reason: 'local' });
    sub.dispose();
  });

  it('disposed before activation never attaches; disposing the controller first drops the queued subscription', async () => {
    build({ activate: false });
    const seen: ArtifactCommentsChange[] = [];
    provider.subscribe(target, (c) => { seen.push(c); }).dispose();
    provider.subscribe(target, (c) => { seen.push(c); });
    controller.dispose();
    controller.activate();
    await wait();
    expect(exists(sidecar())).toBe(false);
    expect(seen).toEqual([]);
    expect(provider.subscribe(target, () => undefined)).toHaveProperty('dispose');
  });

  it('a subscription for a target that is not a Design artifact stays silent after activation', async () => {
    build({ activate: false });
    const seen: unknown[] = [];
    provider.subscribe({ ...target, root: base }, (c) => { seen.push(c); });
    controller.activate();
    await wait();
    expect(seen).toEqual([]);
    expect(exists(path.join(base, '.threads-design'))).toBe(false);
  });

  it('eight listeners attach; the ninth and tenth get exactly one synthetic recovered/all event and no later changes', async () => {
    const heard: ArtifactCommentsChange[][] = Array.from({ length: 10 }, () => []);
    const subs = heard.map((bucket) => provider.subscribe(target, (c) => { bucket.push(c); }));
    await wait(300);
    ok(await provider.save(target, { request: request() }, ctx()));
    await wait(300);
    const refused = heard.filter((bucket) => bucket.length === 1 && bucket[0].reason === 'recovered' && bucket[0].ids === 'all' && bucket[0].revision === 0);
    const attached = heard.filter((bucket) => bucket.some((c) => c.reason === 'local'));
    expect(attached).toHaveLength(8);
    expect(refused.length).toBe(2);
    for (const bucket of refused) {
      expect(bucket[0].storeId).toMatch(/^str_[0-9a-f]{32}$/);
      expect(bucket).toHaveLength(1);
    }
    subs.forEach((s) => s.dispose());
  });

  it('disposing an attached listener frees a slot for a later one', async () => {
    const subs = Array.from({ length: 8 }, () => provider.subscribe(target, () => undefined));
    await wait(300);
    subs[0].dispose();
    const late: ArtifactCommentsChange[] = [];
    provider.subscribe(target, (c) => { late.push(c); });
    await wait(300);
    ok(await provider.save(target, { request: request() }, ctx()));
    await wait(300);
    expect(late.some((c) => c.reason === 'local')).toBe(true);
    expect(late.some((c) => c.reason === 'recovered')).toBe(false);
  });

  it('a listener that throws on the synthetic event does not escape', async () => {
    const subs = Array.from({ length: 8 }, () => provider.subscribe(target, () => undefined));
    await wait(300);
    const extra = provider.subscribe(target, () => { throw new Error('boom'); });
    await wait(300);
    expect(warnings.some((w) => w.includes('threw') || w.includes('Too many'))).toBe(true);
    extra.dispose();
    subs.forEach((s) => s.dispose());
  });
});

describe('bounded sidecar read', () => {
  const CAP = 256 * 1024;
  async function planted(bytes: Buffer) {
    await fs.mkdir(selections(), { recursive: true });
    await fs.writeFile(sel('json'), bytes);
  }
  /** Ops whose lstat and fstat report a tiny file while the real file is bigger: a file that grew after the size check. */
  const lying = () => ({
    ...defaultOps,
    lstat: (async (p: string, o?: any) => { const s: any = await fs.lstat(p, o); return p.endsWith('.json') && p.includes('selections') ? Object.assign(Object.create(Object.getPrototypeOf(s)), s, { size: 10 }) : s; }) as typeof fs.lstat,
    open: (async (p: string, flags: any, mode?: any) => {
      const h: any = await fs.open(p, flags, mode);
      return new Proxy(h, { get(t: any, prop) { if (prop === 'stat') return async () => { const s = await t.stat(); return Object.assign(Object.create(Object.getPrototypeOf(s)), s, { size: 10 }); }; return typeof t[prop] === 'function' ? t[prop].bind(t) : t[prop]; } });
    }) as typeof fs.open,
  });

  it('exactly the cap is read; one byte more is refused', async () => {
    await planted(Buffer.alloc(CAP, 0x20));
    expect((await readSelectionJson(root, SELECTION_ID))?.length).toBe(CAP);
    await planted(Buffer.alloc(CAP + 1, 0x20));
    expect(await readSelectionJson(root, SELECTION_ID)).toBeNull();
  });

  it('a file that grew after the size checks is refused without being buffered whole', async () => {
    await planted(Buffer.alloc(40 * 1024 * 1024, 0x20));
    const rss = process.memoryUsage().rss;
    expect(await readSelectionJson(root, SELECTION_ID, lying() as never)).toBeNull();
    expect(process.memoryUsage().rss - rss).toBeLessThan(30 * 1024 * 1024);
  });

  it('a small file under the lying ops still reads fully (multi-byte text intact)', async () => {
    await planted(Buffer.from('{"a":"héllo \u{1F600}"}'));
    expect(await readSelectionJson(root, SELECTION_ID, lying() as never)).toBe('{"a":"héllo \u{1F600}"}');
  });

  it('an empty file reads as empty text, a missing file as null', async () => {
    await planted(Buffer.alloc(0));
    expect(await readSelectionJson(root, SELECTION_ID)).toBe('');
    await fs.rm(sel('json'));
    expect(await readSelectionJson(root, SELECTION_ID)).toBeNull();
  });
});

describe('labels and store open', () => {
  const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

  it.each([118, 119, 120, 121, 125])('a label cut near the limit never splits an emoji (accessible name of %i units)', async (n) => {
    const name = 'a'.repeat(n - 4) + '\u{1F600}'.repeat(4);
    const saved = ok<any>(await provider.save(target, { request: request({}, { selectionId: `sel_${n.toString(16).padStart(32, '0')}`, a11y: { role: 'heading', name, tabIndex: null } }) }, ctx()));
    expect(saved.comment.label.length).toBeLessThanOrEqual(120);
    expect(lone.test(saved.comment.label)).toBe(false);
  });

  it('a name made only of 4-unit emoji and a 1-unit tag still stays within 120 and well formed', async () => {
    const saved = ok<any>(await provider.save(target, { request: request({}, { a11y: { role: 'heading', name: '\u{1F600}'.repeat(60), tabIndex: null } }) }, ctx()));
    expect(saved.comment.label.length).toBeLessThanOrEqual(120);
    expect(lone.test(saved.comment.label)).toBe(false);
    expect(saved.comment.label.endsWith('…')).toBe(true);
  });

  it('a store whose open rejects once is retried on the next call instead of being cached as failed', async () => {
    const real = createCommentStore({ keys: { getKey: async () => KEY }, now: () => new Date(clockMs) });
    let opens = 0;
    const flaky = { open: async (input: any) => { opens += 1; if (opens === 1) throw new Error('disk hiccup'); return real.open(input); } } as CommentStore;
    build({ store: flaky });
    expect(await provider.list(target, ctx())).toMatchObject({ status: 'rejected', reason: 'failed' });
    expect(ok<any>(await provider.list(target, ctx())).comments).toEqual([]);
    expect(opens).toBe(2);
    ok(await provider.save(target, { request: request() }, ctx()));
  });

  it('retention skipped because the store is unhealthy logs once per root, not once per save', async () => {
    const real = createCommentStore({ keys: { getKey: async () => KEY }, now: () => new Date(clockMs) });
    const store = { open: async (input: any) => { const h: any = await real.open(input); return new Proxy(h, { get(t: any, p) { if (p === 'protectedSelectionIds') return async () => { throw new Error('no'); }; return typeof t[p] === 'function' ? t[p].bind(t) : t[p]; } }); } } as CommentStore;
    build({ store });
    for (let n = 1; n <= 3; n++) ok(await provider.save(target, { request: request({}, { selectionId: `sel_${n.toString(16).padStart(32, '0')}` }) }, ctx()));
    expect(warnings.filter((w) => w.includes('retention is skipped'))).toHaveLength(1);
  });
});
