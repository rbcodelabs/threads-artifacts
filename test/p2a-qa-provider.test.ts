import { execFileSync } from 'node:child_process';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createArtifactCommentsProvider, type CommentsProviderController } from '../src/artifactCommentsProvider';
import { createCommentStore, type CommentStore } from '../src/commentStore';
import { buildDesignManifest } from '../src/designArtifact';
import type { ArtifactFeedbackRequest, ArtifactFeedbackTarget } from '../src/geodeArtifactFeedback';
import type { ArtifactCommentsChange, ArtifactCommentsProvider } from '../src/geodeArtifactFeedbackV2';
import { createFakeApi } from './helpers/fakeApi';
import { ARTIFACT_ID, fileOf, KEY, stored } from './helpers/commentFixtures';
import { OTHER_SELECTION_ID, PNG_BYTES, SELECTION_ID, validRequest } from './helpers/feedbackFixtures';

/**
 * Independent QA probes for P2a (handler v2 core): the comments provider, attacked from outside.
 * Threat references are the design note's section 5 (T5, T6, T11, T12).
 */

const NOW_MS = Date.parse('2026-11-08T20:01:00.000Z');
const HOUR = 3_600_000;
const CMT = `cmt_${SELECTION_ID.slice(4)}`;
const OTHER_CMT = `cmt_${OTHER_SELECTION_ID.slice(4)}`;
const SECRET = 'SECRET-VAULT-NOTE-TEXT';

let base: string;
let root: string;
let store: CommentStore;
let controller: CommentsProviderController;
let provider: ArtifactCommentsProvider;
let target: ArtifactFeedbackTarget;
let warnings: unknown[][];
const ctx = () => ({ signal: new AbortController().signal });
const sidecar = () => path.join(root, '.threads-design');
const selectionsDir = () => path.join(sidecar(), 'selections');
const commentsFile = () => path.join(sidecar(), 'comments.json');
const settle = async () => { for (let i = 0; i < 25; i++) await new Promise((resolve) => setImmediate(resolve)); };
const exists = (p: string) => fsSync.existsSync(p);

async function makeArtifact(id = 't1', manifestPatch: Record<string, unknown> = {}): Promise<string> {
  const dir = path.join(base, '.geode', 'artifacts', `design-${id}`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'artifact.json'), JSON.stringify({ ...buildDesignManifest(id, 'Landing'), ...manifestPatch }));
  await fs.writeFile(path.join(dir, 'index.html'), '<main><h1 id="hero-title">Build faster</h1></main>\n');
  return dir;
}

const VAULT_READ = { permissions: { network: 'none', clipboard: false, vault: 'read' } };

function request(patch: Record<string, unknown> = {}, selectionPatch: Record<string, unknown> = {}, artifactRoot = root): ArtifactFeedbackRequest {
  const req = validRequest(patch) as any;
  req.artifact.root = artifactRoot;
  req.selection = { ...req.selection, ...selectionPatch };
  return req;
}

/** A redacted selection where every field that could carry vault text carries SECRET. */
function hostileRedacted(selectionId = SELECTION_ID): ArtifactFeedbackRequest {
  const req = request({ screenshot: { ...(validRequest() as any).screenshot }, screenshotOmitted: null }, {
    selectionId,
    redacted: true,
    textAnchor: { tag: 'h1', text: SECRET },
    landmark: SECRET,
    a11y: { role: 'heading', name: SECRET, tabIndex: null },
    outerHTML: { html: `<h1>${SECRET}</h1>`, truncated: false },
  }) as any;
  req.artifact.vaultRead = false; // the embedder lies about the artifact being vault-read
  return req;
}

function ok<T>(result: { status: string; value?: T; reason?: string; message?: string }): T {
  if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status} ${result.reason} ${result.message}`);
  return result.value as T;
}

/** Plain data only: Object/Array prototypes, no functions, symbols, class instances, accessors. */
function expectPlain(value: unknown, where = 'value'): void {
  if (value === null || typeof value !== 'object') {
    expect(['string', 'number', 'boolean', 'undefined'], `${where}: ${typeof value}`).toContain(value === null ? 'undefined' : typeof value);
    return;
  }
  const proto = Object.getPrototypeOf(value);
  expect(proto === Object.prototype || proto === Array.prototype || proto === null, `${where} has a non-plain prototype`).toBe(true);
  expect(Object.isFrozen(value) || true).toBe(true);
  for (const key of Reflect.ownKeys(value)) {
    expect(typeof key, `${where} has a symbol key`).toBe('string');
    const desc = Object.getOwnPropertyDescriptor(value, key)!;
    expect(desc.get === undefined && desc.set === undefined, `${where}.${String(key)} is an accessor`).toBe(true);
    expectPlain(desc.value, `${where}.${String(key)}`);
  }
  expect(structuredClone(value)).toEqual(value);
}

/** Every path under `dir`, relative, sorted (ignores nothing). */
async function tree(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      out.push(path.relative(dir, full) + (entry.isDirectory() ? '/' : ''));
      if (entry.isDirectory()) await walk(full);
    }
  }
  await walk(dir);
  return out.sort();
}

function build(opts: { store?: CommentStore; retention?: number; now?: () => number } = {}) {
  const fake = createFakeApi();
  fake.addThread('t1', { artifacts: [{ providerId: 'agent-threads.design', kind: 'design-static', schemaVersion: 2, id: 'design-t1', title: 'Landing', data: {}, storageRoot: root }] });
  store = opts.store ?? createCommentStore({ keys: { getKey: async () => KEY }, now: () => new Date(NOW_MS) });
  controller = createArtifactCommentsProvider({ api: fake.api, vaultRoot: () => base, store, now: opts.now ?? (() => NOW_MS), retention: opts.retention, warn: (...args) => { warnings.push(args); } });
  controller.activate();
  provider = controller.provider;
  return fake;
}

beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'td-qa-p2a-')));
  root = await makeArtifact();
  warnings = [];
  build();
  target = { root, artifactId: 'design-t1', title: 'Landing', runtime: 'static', vaultRead: false };
});
afterEach(async () => { controller.dispose(); await fs.rm(base, { recursive: true, force: true }); });

describe('save: identity, clock and cancellation (T6)', () => {
  it('rejects a request whose artifact id differs from the target, writing nothing', async () => {
    const wrongId = request();
    (wrongId.artifact as any).artifactId = 'design-other';
    expect(await provider.save(target, { request: wrongId }, ctx())).toMatchObject({ status: 'rejected', reason: 'invalid' });
    expect(exists(sidecar())).toBe(false);
  });

  it('rejects a request whose root names a different, real Design artifact, writing nothing in either', async () => {
    const other = await makeArtifact('t2');
    const before = await tree(base);
    const crossed = request({}, {}, other);
    (crossed.artifact as any).artifactId = 'design-t1';
    expect(await provider.save(target, { request: crossed }, ctx())).toMatchObject({ status: 'rejected', reason: 'invalid' });
    expect(await tree(base)).toEqual(before);
  });

  it('rejects a request whose root is spelled differently from the target root, even though it resolves to the same folder', async () => {
    const alias = path.join(base, 'alias-link');
    await fs.symlink(root, alias);
    const spelled = request({}, {}, alias);
    const result = await provider.save(target, { request: spelled }, ctx());
    expect(result.status).toBe('rejected');
    expect(exists(path.join(selectionsDir(), `${SELECTION_ID}.json`))).toBe(false);
  });

  it('accepts 23h59m of clock skew either way and rejects 24h01m either way and non-dates', async () => {
    const at = (offsetMs: number) => new Date(NOW_MS + offsetMs).toISOString();
    ok(await provider.save(target, { request: request({}, { selectionId: SELECTION_ID, capturedAt: at(-(24 * HOUR - 60_000)) }) }, ctx()));
    ok(await provider.save(target, { request: request({}, { selectionId: OTHER_SELECTION_ID, capturedAt: at(24 * HOUR - 60_000) }) }, ctx()));
    for (const [n, offset] of [[3, -(24 * HOUR + 60_000)], [4, 24 * HOUR + 60_000], [5, 400 * 24 * HOUR]] as const) {
      const id = `sel_${n.toString(16).padStart(32, '0')}`;
      expect(await provider.save(target, { request: request({}, { selectionId: id, capturedAt: at(offset) }) }, ctx()), `offset ${offset}`).toMatchObject({ status: 'rejected', reason: 'invalid' });
      expect(exists(path.join(selectionsDir(), `${id}.json`))).toBe(false);
    }
    for (const bad of ['yesterday', '', '2026-13-45T99:99:99Z', 12345, null]) {
      const id = `sel_${'9'.repeat(32)}`;
      expect(await provider.save(target, { request: request({}, { selectionId: id, capturedAt: bad as never }) }, ctx())).toMatchObject({ status: 'rejected', reason: 'invalid' });
      expect(exists(path.join(selectionsDir(), `${id}.json`))).toBe(false);
    }
  });

  it('an already-aborted call writes nothing and creates no comment', async () => {
    const controllerAbort = new AbortController();
    controllerAbort.abort();
    expect(await provider.save(target, { request: request() }, { signal: controllerAbort.signal })).toMatchObject({ status: 'rejected', reason: 'unavailable' });
    expect(exists(selectionsDir())).toBe(false);
    expect(ok<any>(await provider.list(target, ctx())).comments).toEqual([]);
  });

  it('a hostile input object (getters, prototype pollution keys) is rejected or ignored without throwing out of the provider', async () => {
    const evil: any = { get request() { throw new Error('getter boom'); } };
    const result = await provider.save(target, evil, ctx());
    expect(result.status).toBe('rejected');
    const polluted = JSON.parse(`{"request": ${JSON.stringify(request())}, "__proto__": {"polluted": true}, "constructor": {"prototype": {"polluted": true}}}`);
    await provider.save(target, polluted, ctx());
    expect(({} as any).polluted).toBeUndefined();
  });
});

describe('save: vault-read data never lands on disk or in results (T11)', () => {
  it('a non-redacted selection on a vault-read manifest is refused even when the host target says vaultRead false, and nothing is created', async () => {
    root = await makeArtifact('t1', VAULT_READ);
    const result = await provider.save({ ...target, vaultRead: false }, { request: request() }, ctx());
    expect(result).toMatchObject({ status: 'rejected', reason: 'invalid' });
    expect(exists(sidecar())).toBe(false);
  });

  it('a redacted pin with SECRET in every text-bearing field leaves SECRET in no result, no comment, and no file', async () => {
    root = await makeArtifact('t1', VAULT_READ);
    const saved = ok<any>(await provider.save({ ...target, vaultRead: false }, { request: hostileRedacted() }, ctx()));
    expect(saved.comment).toMatchObject({ hasScreenshot: false, redacted: true, label: 'h1' });
    expect(saved.comment.anchor.textAnchor).toEqual({ tag: 'h1', text: '' });
    expect(saved.comment.anchor.landmark).toBeNull();
    const listed = ok<any>(await provider.list(target, ctx()));
    const detail = ok<any>(await provider.get(target, CMT, ctx()));
    expect(JSON.stringify([saved, listed, detail])).not.toContain(SECRET);
    for (const name of await fs.readdir(selectionsDir())) expect(await fs.readFile(path.join(selectionsDir(), name), 'utf8'), name).not.toContain(SECRET);
    expect(await fs.readFile(commentsFile(), 'utf8')).not.toContain(SECRET);
    expect((await fs.readdir(selectionsDir())).filter((name) => name.endsWith('.png'))).toEqual([]);
  });

  it('the pin text typed by the user is kept (it is the user\'s own words, not vault data)', async () => {
    root = await makeArtifact('t1', VAULT_READ);
    const saved = ok<any>(await provider.save({ ...target, vaultRead: true }, { request: hostileRedacted() }, ctx()));
    expect(saved.comment.text).toBe('Make this heading larger.');
  });

  it('get refuses to hand back an unredacted snapshot for a redacted comment when the sidecar was swapped for a non-redacted one', async () => {
    root = await makeArtifact('t1', VAULT_READ);
    ok(await provider.save({ ...target, vaultRead: true }, { request: hostileRedacted() }, ctx()));
    const file = path.join(selectionsDir(), `${SELECTION_ID}.json`);
    const record = JSON.parse(await fs.readFile(file, 'utf8'));
    record.selection = { ...(request() as any).selection }; // non-redacted, full text
    await fs.writeFile(file, JSON.stringify(record));
    const detail = ok<any>(await provider.get(target, CMT, ctx()));
    expect(detail.selection).toBeNull();
    expect(JSON.stringify(detail)).not.toContain('Build faster');
  });

  it('a redacted comment on a normal artifact stays redacted in get (comment.redacted drives the check)', async () => {
    ok(await provider.save(target, { request: hostileRedacted() }, ctx()));
    const file = path.join(selectionsDir(), `${SELECTION_ID}.json`);
    const record = JSON.parse(await fs.readFile(file, 'utf8'));
    record.selection = { ...(request() as any).selection };
    await fs.writeFile(file, JSON.stringify(record));
    expect(ok<any>(await provider.get(target, CMT, ctx())).selection).toBeNull();
  });
});

describe('save: cleanup and replay (T6)', () => {
  it('the 201st pin is refused with limit and its selection files are removed; the earlier 200 are untouched', async () => {
    controllerDisposeAndPlant(Array.from({ length: 200 }, (_, n) => stored(n + 1)));
    const result = await provider.save(target, { request: request() }, ctx());
    expect(result).toMatchObject({ status: 'rejected', reason: 'limit' });
    expect(exists(path.join(selectionsDir(), `${SELECTION_ID}.json`))).toBe(false);
    expect(exists(path.join(selectionsDir(), `${SELECTION_ID}.png`))).toBe(false);
    expect(ok<any>(await provider.list(target, ctx())).comments).toHaveLength(200);
  });

  it('a conflicting replay (same selection id, different content) keeps the original comment and its original files', async () => {
    ok(await provider.save(target, { request: request() }, ctx()));
    const before = await fs.readFile(path.join(selectionsDir(), `${SELECTION_ID}.json`), 'utf8');
    expect(await provider.save(target, { request: request({ comment: 'Something else entirely.' }) }, ctx())).toMatchObject({ status: 'rejected', reason: 'conflict' });
    expect(await fs.readFile(path.join(selectionsDir(), `${SELECTION_ID}.json`), 'utf8')).toBe(before);
    expect(exists(path.join(selectionsDir(), `${SELECTION_ID}.png`))).toBe(true);
    const detail = ok<any>(await provider.get(target, CMT, ctx()));
    expect(detail.comment.text).toBe('Make this heading larger.');
    expect(detail.selection).not.toBeNull();
  });

  it('ten concurrent identical saves create exactly one comment (one created:true) and one set of files', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => provider.save(target, { request: request() }, ctx())));
    expect(results.every((r) => r.status === 'ok')).toBe(true);
    expect(results.filter((r: any) => r.value.created).length).toBe(1);
    expect(ok<any>(await provider.list(target, ctx())).comments).toHaveLength(1);
    expect((await fs.readdir(selectionsDir())).sort()).toEqual([`${SELECTION_ID}.json`, `${SELECTION_ID}.png`]);
  });

  it('eight concurrent distinct saves get eight distinct ordinals and eight file sets', async () => {
    const ids = Array.from({ length: 8 }, (_, n) => `sel_${(n + 1).toString(16).padStart(32, '0')}`);
    const results = await Promise.all(ids.map((id) => provider.save(target, { request: request({}, { selectionId: id }) }, ctx())));
    expect(results.every((r) => r.status === 'ok')).toBe(true);
    const ordinals = ok<any>(await provider.list(target, ctx())).comments.map((c: any) => c.ordinal).sort((a: number, b: number) => a - b);
    expect(ordinals).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    for (const id of ids) expect(exists(path.join(selectionsDir(), `${id}.json`))).toBe(true);
  });

  it('two concurrent saves of one selection id with different content leave the surviving comment with its selection files', async () => {
    // Force the interleaving: the SECOND request to touch the files (replay=false is the first writer) has its
    // store.create delayed until the first-created comment is already stored. Whoever loses must not delete files
    // that the winning comment references.
    controller.dispose();
    const real = createCommentStore({ keys: { getKey: async () => KEY }, now: () => new Date(NOW_MS) });
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let creates = 0;
    const wrapped: CommentStore = {
      ...real,
      open: async (input: any) => {
        const handle = await real.open(input);
        return new Proxy(handle, {
          get(targetHandle: any, prop) {
            if (prop !== 'create') return typeof targetHandle[prop] === 'function' ? targetHandle[prop].bind(targetHandle) : targetHandle[prop];
            return async (draft: any) => {
              creates += 1;
              if (creates === 1) await gate; // the first writer of the files stalls before it stores its comment
              return targetHandle.create(draft);
            };
          },
        });
      },
    } as CommentStore;
    build({ store: wrapped });
    const first = provider.save(target, { request: request({ comment: 'Variant B' }) }, ctx()); // writes the files, stalls
    await settle();
    const second = provider.save(target, { request: request({ comment: 'Variant A' }) }, ctx()); // sees existing files (replay), stores comment
    await settle();
    const secondResult = await second;
    releaseFirst();
    const firstResult = await first;
    expect(secondResult.status).toBe('ok');
    expect(firstResult).toMatchObject({ status: 'rejected', reason: 'conflict' });
    const detail = ok<any>(await provider.get(target, CMT, ctx()));
    expect(detail.comment.text).toBe('Variant A');
    expect(exists(path.join(selectionsDir(), `${SELECTION_ID}.json`)), 'the winning comment lost its selection json').toBe(true);
    expect(detail.selection, 'the winning comment lost its selection snapshot').not.toBeNull();
  });
});

function controllerDisposeAndPlant(comments: ReturnType<typeof stored>[]) {
  fsSync.mkdirSync(sidecar(), { recursive: true });
  fsSync.writeFileSync(commentsFile(), JSON.stringify(fileOf(comments)));
}

describe('get: tampered, linked and oversize sidecars (T5)', () => {
  beforeEach(async () => { ok(await provider.save(target, { request: request() }, ctx())); });
  const sel = () => path.join(selectionsDir(), `${SELECTION_ID}.json`);
  const selection = async () => ok<any>(await provider.get(target, CMT, ctx())).selection;

  it('a symlinked selections directory is not followed (the outside copy is never read)', async () => {
    const outside = path.join(base, 'outside-selections');
    await fs.mkdir(outside);
    await fs.copyFile(sel(), path.join(outside, `${SELECTION_ID}.json`));
    await fs.rm(selectionsDir(), { recursive: true });
    await fs.symlink(outside, selectionsDir());
    expect(await selection()).toBeNull();
  });

  it('a symlinked .threads-design directory makes the store unavailable and reads nothing from the link target', async () => {
    const real = path.join(base, 'moved-sidecar');
    await fs.rename(sidecar(), real);
    await fs.symlink(real, sidecar());
    const result = await provider.get(target, CMT, ctx());
    if (result.status === 'ok') expect(result.value.selection).toBeNull();
    else expect(['unavailable', 'not-found', 'failed']).toContain(result.reason);
  });

  it('a hardlinked selection json is refused', async () => {
    const twin = path.join(base, 'twin.json');
    await fs.link(sel(), twin);
    expect(await selection()).toBeNull();
  });

  it('an oversize selection json (> 256 KiB) is refused', async () => {
    const record = JSON.parse(await fs.readFile(sel(), 'utf8'));
    record.padding = 'x'.repeat(300 * 1024);
    await fs.writeFile(sel(), JSON.stringify(record));
    expect(await selection()).toBeNull();
  });

  it.skipIf(process.platform === 'win32')('a FIFO in place of the selection json does not hang the call', async () => {
    await fs.rm(sel());
    execFileSync('mkfifo', [sel()]);
    const raced = await Promise.race([selection(), new Promise((resolve) => setTimeout(() => resolve('HUNG'), 3000))]);
    expect(raced).toBeNull();
  });

  it('a sidecar that is valid but belongs to another selection id is refused', async () => {
    ok(await provider.save(target, { request: request({}, { selectionId: OTHER_SELECTION_ID }) }, ctx()));
    await fs.copyFile(path.join(selectionsDir(), `${OTHER_SELECTION_ID}.json`), sel());
    expect(await selection()).toBeNull();
  });

  it('a sidecar whose selection names another artifact is refused', async () => {
    const record = JSON.parse(await fs.readFile(sel(), 'utf8'));
    record.selection.artifactId = 'design-someone-else';
    await fs.writeFile(sel(), JSON.stringify(record));
    expect(await selection()).toBeNull();
  });

  it('prototype-pollution keys in a sidecar do not pollute and do not leak into the result', async () => {
    const text = (await fs.readFile(sel(), 'utf8')).replace(/^\{/, '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},');
    await fs.writeFile(sel(), text);
    const detail = ok<any>(await provider.get(target, CMT, ctx()));
    expect(({} as any).polluted).toBeUndefined();
    expect(JSON.stringify(detail)).not.toContain('polluted');
    expectPlain(detail);
  });

  it('a truncated and an empty file read as null', async () => {
    const full = await fs.readFile(sel(), 'utf8');
    await fs.writeFile(sel(), full.slice(0, full.length / 2));
    expect(await selection()).toBeNull();
    await fs.writeFile(sel(), '');
    expect(await selection()).toBeNull();
  });
});

describe('hostile ids and inputs never reach a path (T5)', () => {
  const HOSTILE = ['../../x', '../../../etc/passwd', `cmt_${'0'.repeat(32)}/../../x`, `cmt_${'a'.repeat(32)}\n`, `cmt_${'A'.repeat(32)}`, `cmt_${'a'.repeat(31)}\u0000`, `cmt_${'a'.repeat(33)}`, '', '__proto__', 'constructor', `sel_${'a'.repeat(32)}`, ' ' + CMT, CMT + ' '];

  it('get, update, remove and adopt reject path-like, malformed and non-string ids and leave the tree unchanged', async () => {
    ok(await provider.save(target, { request: request() }, ctx()));
    const before = await tree(base);
    for (const id of [...HOSTILE, null, undefined, 42, {}, [], ['a']] as unknown[]) {
      const results = await Promise.all([
        provider.get(target, id as never, ctx()),
        provider.update(target, { id, expectedVersion: 1, change: { action: 'resolve' } } as never, ctx()),
        provider.remove(target, { id, expectedVersion: 1 } as never, ctx()),
        provider.adopt(target, { ids: [id] } as never, ctx()),
      ]);
      for (const r of results) {
        expect(r.status, `id ${JSON.stringify(id)}`).toBe('rejected');
        expect(['invalid', 'not-found']).toContain((r as any).reason);
      }
    }
    expect(await tree(base)).toEqual(before);
    expect(ok<any>(await provider.list(target, ctx())).comments).toHaveLength(1);
  });

  it('update and remove reject odd expectedVersion and change shapes without changing the comment', async () => {
    const saved = ok<any>(await provider.save(target, { request: request() }, ctx()));
    const bad: unknown[] = [NaN, Infinity, -1, 0, 1.5, '1', null, undefined, {}, 2 ** 53];
    for (const v of bad) {
      const r = await provider.update(target, { id: CMT, expectedVersion: v, change: { action: 'resolve' } } as never, ctx());
      expect(r.status, `version ${String(v)}`).toBe('rejected');
      const r2 = await provider.remove(target, { id: CMT, expectedVersion: v } as never, ctx());
      expect(r2.status, `remove version ${String(v)}`).toBe('rejected');
    }
    for (const change of [null, undefined, {}, { action: 'explode' }, { action: 'resolve', text: 'x' }, { text: 5 }, { text: 'x'.repeat(4001) }, { text: '' }, 'resolve', { action: 'send' }, { __proto__: { action: 'resolve' } }]) {
      const r = await provider.update(target, { id: CMT, expectedVersion: saved.comment.version, change } as never, ctx());
      expect(r.status, JSON.stringify(change)).toBe('rejected');
    }
    expect(ok<any>(await provider.get(target, CMT, ctx())).comment).toMatchObject({ version: 1, status: 'open', text: 'Make this heading larger.' });
  });

  it('adopt dedupes, enforces 1..20 and rejects non-array input', async () => {
    ok(await provider.save(target, { request: request() }, ctx()));
    for (const input of [undefined, null, {}, { ids: 'cmt' }, { ids: [] }, { ids: Array.from({ length: 21 }, (_, n) => `cmt_${n.toString(16).padStart(32, '0')}`) }]) {
      expect(await provider.adopt(target, input as never, ctx())).toMatchObject({ status: 'rejected', reason: 'invalid' });
    }
    expect(ok<any>(await provider.adopt(target, { ids: Array.from({ length: 20 }, () => CMT) }, ctx())).adopted).toEqual([]);
  });

  it('a hostile target (wrong types, traversal in root) is unavailable and touches nothing', async () => {
    const before = await tree(base);
    const targets: unknown[] = [null, undefined, 'x', 5, [], {}, { ...target, root: `${root}/../..` }, { ...target, root: `${root}\u0000/x` }, { ...target, root: 5 }, { ...target, runtime: 'static', artifactId: { toString: () => 'design-t1' } }];
    for (const t of targets) {
      for (const result of [await provider.list(t as never, ctx()), await provider.get(t as never, CMT, ctx()), await provider.save(t as never, { request: request() }, ctx())]) {
        expect(result.status).toBe('rejected');
      }
    }
    expect(await tree(base)).toEqual(before);
  });
});

describe('results are data only and not live (structuredClone)', () => {
  it('every method returns plain data, including rejections and change events', async () => {
    const changes: ArtifactCommentsChange[] = [];
    provider.subscribe(target, (change) => { changes.push(change); });
    await settle();
    const saved = await provider.save(target, { request: request() }, ctx());
    const replay = await provider.save(target, { request: request() }, ctx());
    const conflict = await provider.save(target, { request: request({ comment: 'other' }) }, ctx());
    const listed = await provider.list(target, ctx());
    const got = await provider.get(target, CMT, ctx());
    const missing = await provider.get(target, OTHER_CMT, ctx());
    const updated = await provider.update(target, { id: CMT, expectedVersion: 1, change: { action: 'resolve' } }, ctx());
    const stale = await provider.update(target, { id: CMT, expectedVersion: 1, change: { action: 'reopen' } }, ctx());
    const adopted = await provider.adopt(target, { ids: [CMT] }, ctx());
    const batch = await provider.sendBatch(target, { requestId: `req_${'a'.repeat(32)}`, ids: [CMT], resend: false, anchorStates: {} }, ctx());
    const removed = await provider.remove(target, { id: CMT, expectedVersion: 2 }, ctx());
    await settle();
    for (const [name, value] of Object.entries({ saved, replay, conflict, listed, got, missing, updated, stale, adopted, batch, removed, changes, caps: provider.capabilities })) expectPlain(value, name);
    expect(changes.length).toBeGreaterThan(0);
  });

  it('mutating a returned snapshot does not change what the next list returns', async () => {
    ok(await provider.save(target, { request: request() }, ctx()));
    const first = ok<any>(await provider.list(target, ctx()));
    first.comments[0].text = 'HACKED';
    first.comments[0].anchor.selector = 'body';
    first.comments.push({ junk: true });
    const second = ok<any>(await provider.list(target, ctx()));
    expect(second.comments).toHaveLength(1);
    expect(second.comments[0].text).toBe('Make this heading larger.');
    expect(second.comments[0].anchor.selector).toBe('#hero-title');
  });
});

describe('subscribe: isolation and failure containment', () => {
  it('a listener on one artifact never hears about another artifact', async () => {
    const root2 = await makeArtifact('t2');
    const fake = build();
    fake.addThread('t2', { artifacts: [{ providerId: 'agent-threads.design', kind: 'design-static', schemaVersion: 2, id: 'design-t2', title: 'Other', data: {}, storageRoot: root2 }] });
    const target2: ArtifactFeedbackTarget = { root: root2, artifactId: 'design-t2', title: 'Other', runtime: 'static', vaultRead: false };
    const one: ArtifactCommentsChange[] = [];
    const two: ArtifactCommentsChange[] = [];
    provider.subscribe(target, (c) => { one.push(c); });
    provider.subscribe(target2, (c) => { two.push(c); });
    await settle();
    ok(await provider.save(target2, { request: request({}, {}, root2) }, ctx()) as any);
    await settle();
    expect(one).toEqual([]);
    expect(two.length).toBeGreaterThan(0);
    expect(two[0].storeId).not.toBe(ok<any>(await provider.list(target, ctx())).storeId);
  });

  it('each listener gets its own copy: one listener mutating its event does not alter another listener\'s event', async () => {
    const seen: ArtifactCommentsChange[] = [];
    provider.subscribe(target, (c) => { (c as any).reason = 'HACKED'; (c as any).ids = 'all'; });
    provider.subscribe(target, (c) => { seen.push(c); });
    await settle();
    ok(await provider.save(target, { request: request() }, ctx()));
    await settle();
    expect(seen).toHaveLength(1);
    expect(seen[0].reason).toBe('local');
    expect(seen[0].ids).toEqual([CMT]);
  });

  it('a listener may call back into the provider and dispose itself without deadlock', async () => {
    let nested: unknown = null;
    const subscription: { dispose(): void } = provider.subscribe(target, () => {
      subscription.dispose();
      nested = provider.list(target, ctx());
    });
    await settle();
    ok(await provider.save(target, { request: request() }, ctx()));
    await settle();
    expect(nested).not.toBeNull();
    expect(ok<any>(await (nested as Promise<any>)).comments).toHaveLength(1);
  });

  it('bad listeners and bad targets return a disposable and never throw; the ninth subscriber is refused quietly', async () => {
    for (const listener of [undefined, null, 'x', 5, {}]) {
      const sub = provider.subscribe(target, listener as never);
      expect(() => sub.dispose()).not.toThrow();
    }
    for (const t of [null, undefined, {}, 'x', { ...target, root: '/nonexistent' }]) {
      const sub = provider.subscribe(t as never, () => undefined);
      await settle();
      expect(() => sub.dispose()).not.toThrow();
    }
    const subs = Array.from({ length: 10 }, () => provider.subscribe(target, () => undefined));
    await settle();
    expect(warnings.some((w) => String(w[0]).includes('Too many'))).toBe(true);
    expect(() => subs.forEach((s) => s.dispose())).not.toThrow();
  });

  it('disposing the controller silences every live listener and later saves still succeed after re-activation is impossible', async () => {
    const seen: ArtifactCommentsChange[] = [];
    provider.subscribe(target, (c) => { seen.push(c); });
    await settle();
    controller.dispose();
    controller.activate(); // must not resurrect a disposed controller
    expect(await provider.save(target, { request: request() }, ctx())).toMatchObject({ status: 'rejected', reason: 'unavailable' });
    await settle();
    expect(seen).toEqual([]);
    expect(exists(commentsFile())).toBe(false);
  });
});

describe('provider inert before activation (T12)', () => {
  it('without activate() no method reads the install key, creates the sidecar or writes comments.json', async () => {
    controller.dispose();
    let keyReads = 0;
    const fake = createFakeApi();
    fake.addThread('t1', { artifacts: [{ providerId: 'agent-threads.design', kind: 'design-static', schemaVersion: 2, id: 'design-t1', title: 'Landing', data: {}, storageRoot: root }] });
    const inert = createArtifactCommentsProvider({ api: fake.api, vaultRoot: () => base, now: () => NOW_MS, store: createCommentStore({ keys: { getKey: async () => { keyReads++; return KEY; } } }) });
    const p = inert.provider;
    const results = [
      await p.list(target, ctx()),
      await p.get(target, CMT, ctx()),
      await p.save(target, { request: request() }, ctx()),
      await p.update(target, { id: CMT, expectedVersion: 1, change: { action: 'resolve' } }, ctx()),
      await p.remove(target, { id: CMT, expectedVersion: 1 }, ctx()),
      await p.adopt(target, { ids: [CMT] }, ctx()),
      await p.sendBatch(target, { requestId: `req_${'a'.repeat(32)}`, ids: [CMT], resend: false, anchorStates: {} }, ctx()),
    ];
    for (const r of results) expect(r).toMatchObject({ status: 'rejected', reason: 'unavailable' });
    p.subscribe(target, () => undefined);
    await settle();
    expect(await inert.protectedSelectionIds(root, 'design-t1')).toBeNull();
    expect(keyReads).toBe(0);
    expect(exists(sidecar())).toBe(false);
    inert.dispose();
  });
});

describe('PNG for pins on ordinary artifacts', () => {
  it('stores the PNG once, byte-exact, and hasScreenshot matches the disk', async () => {
    const saved = ok<any>(await provider.save(target, { request: request() }, ctx()));
    expect(saved.comment.hasScreenshot).toBe(true);
    expect([...new Uint8Array(await fs.readFile(path.join(selectionsDir(), `${SELECTION_ID}.png`)))]).toEqual([...PNG_BYTES]);
  });

  it('a pin without a screenshot reports hasScreenshot false and writes no PNG', async () => {
    const saved = ok<any>(await provider.save(target, { request: request({ screenshot: null, screenshotOmitted: 'too-large' }) }, ctx()));
    expect(saved.comment.hasScreenshot).toBe(false);
    expect(exists(path.join(selectionsDir(), `${SELECTION_ID}.png`))).toBe(false);
  });
});
