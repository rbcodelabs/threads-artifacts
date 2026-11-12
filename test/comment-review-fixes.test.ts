import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeCommentsFile, validatePinDraft } from '../src/commentModel';
import { createCommentStore } from '../src/commentStore';
import type { CommentRootHandle } from '../src/commentStore';
import type { ArtifactCommentsResult } from '../src/geodeArtifactFeedbackV2';
import { ARTIFACT_ID, cmtId, fileOf, KEY, NOW, pinDraft, stored } from './helpers/commentFixtures';

const NOW_MS = Date.parse(NOW);
let base: string;
let root: string;
const handles: CommentRootHandle[] = [];

beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'td-fix-')));
  root = path.join(base, 'artifact');
  await fs.mkdir(root);
});
afterEach(async () => {
  for (const h of handles.splice(0)) h.dispose();
  await fs.rm(base, { recursive: true, force: true });
});

const dir = () => path.join(root, '.threads-design');
const file = () => path.join(dir(), 'comments.json');
async function open(): Promise<CommentRootHandle> {
  const h = await createCommentStore({ keys: { getKey: async () => KEY }, now: () => new Date(NOW_MS), pluginVersion: 'test' }).open({ root, artifactId: ARTIFACT_ID });
  handles.push(h);
  return h;
}
const ok = <T,>(r: ArtifactCommentsResult<T>): T => { if (r.status !== 'ok') throw new Error(`${r.reason}: ${r.message}`); return r.value; };
const reason = <T,>(r: ArtifactCommentsResult<T>) => (r.status === 'rejected' ? r.reason : 'ok');
async function writeDisk(content: unknown, name = 'comments.json') {
  await fs.mkdir(dir(), { recursive: true });
  await fs.writeFile(path.join(dir(), name), typeof content === 'string' ? content : JSON.stringify(content));
}
const readDisk = (name = 'comments.json') => JSON.parse(fsSync.readFileSync(path.join(dir(), name), 'utf8'));

describe('A2: recovery from the previous generation keeps valid newer comments', () => {
  it('a hand edit that breaks one comment leaves 5 valid newer comments: they are kept, and survive the next write', async () => {
    await writeDisk(fileOf([stored(1), stored(2)], { rev: 3 }), 'comments.prev.json');
    const hand = JSON.parse(JSON.stringify(fileOf([stored(1), stored(2), stored(3), stored(4), stored(5), stored(6), stored(7)], { rev: 9 })));
    hand.comments[2].text = ''; // c3 is the one that is broken; its hash is now stale too
    await writeDisk(hand);
    const h = await open();
    const snap = await h.snapshot();
    expect(snap.health).toBe('recovered');
    expect(snap.comments.map((c) => c.id)).toEqual([1, 2, 4, 5, 6, 7].map(cmtId));
    expect(snap.comments.every((c) => c.provenance === 'local')).toBe(true);
    ok(await h.create(pinDraft(8)));
    h.dispose();
    const again = await (await open()).snapshot();
    expect(again.comments.map((c) => c.id)).toEqual([1, 2, 4, 5, 6, 7, 8].map(cmtId));
    expect(fsSync.readdirSync(dir()).filter((n) => /^comments\.corrupt-/.test(n))).toHaveLength(1);
  });

  it('prefers the newer copy of a comment present in both, and keeps comments only prev has', async () => {
    await writeDisk(fileOf([stored(1, { version: 1, text: 'old' }), stored(2)], { rev: 3 }), 'comments.prev.json');
    const hand = JSON.parse(JSON.stringify(fileOf([stored(1, { version: 4, text: 'edited later' }), stored(9)], { rev: 9 })));
    hand.comments.push({ junk: true });
    await writeDisk(hand);
    const snap = await (await open()).snapshot();
    expect(snap.comments.find((c) => c.id === cmtId(1))!.text).toBe('edited later');
    expect(snap.comments.map((c) => c.id).sort()).toEqual([1, 2, 9].map(cmtId).sort());
  });

  it('a truncated current file: complete comments in it are merged with the previous generation', async () => {
    await writeDisk(fileOf([stored(1)], { rev: 2 }), 'comments.prev.json');
    const good = JSON.stringify(fileOf([stored(1), stored(2), stored(3)]));
    await writeDisk(good.slice(0, good.length - 30));
    const snap = await (await open()).snapshot();
    expect(snap.comments.map((c) => c.id)).toEqual([1, 2].map(cmtId));
  });

  it('the quarantine copy exists before the file is overwritten, and holds the original bytes', async () => {
    await writeDisk(fileOf([stored(1)], { rev: 2 }), 'comments.prev.json');
    const hand = JSON.parse(JSON.stringify(fileOf([stored(1), stored(2), stored(3)])));
    hand.comments[0].text = '';
    const original = JSON.stringify(hand);
    await writeDisk(original);
    const h = await open();
    ok(await h.create(pinDraft(4)));
    const q = fsSync.readdirSync(dir()).filter((n) => /^comments\.corrupt-/.test(n));
    expect(q).toHaveLength(1);
    expect(fsSync.readFileSync(path.join(dir(), q[0]), 'utf8')).toBe(original);
  });
});

describe('A3: plugin data goes through the guard only', () => {
  it('no source file except commentKey.ts calls .loadData( or .saveData(', () => {
    const srcDir = path.join(__dirname, '..', 'src');
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const entry of fsSync.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name.endsWith('.ts') && entry.name !== 'commentKey.ts') {
          const lines = fsSync.readFileSync(p, 'utf8').split('\n');
          lines.forEach((line, i) => { if (/\.(loadData|saveData)\s*\(/.test(line)) offenders.push(`${path.relative(srcDir, p)}:${i + 1}: ${line.trim()}`); });
        }
      }
    };
    walk(srcDir);
    expect(offenders).toEqual([]);
  });
});

describe('A4: transition results are tied to the batch request that issued them', () => {
  const R1 = `req_${'1'.repeat(32)}`;
  const R2 = `req_${'2'.repeat(32)}`;

  async function pendingPair() {
    const h = await open();
    for (const n of [1, 2, 3]) ok(await h.create(pinDraft(n)));
    ok(await h.transition([{ id: cmtId(1), event: 'batch-issued', requestId: R1 }, { id: cmtId(2), event: 'batch-issued', requestId: R1 }, { id: cmtId(3), event: 'batch-issued', requestId: R2 }]));
    return h;
  }

  it.each(['delivered', 'send-failed', 'expired'] as const)('%s with the wrong request id is a stale no-op and does not fail the other items', async (event) => {
    const h = await pendingPair();
    const result = ok(await h.transition([{ id: cmtId(1), event, requestId: R1 }, { id: cmtId(2), event, requestId: R2 }, { id: cmtId(3), event, requestId: R2 }]));
    expect(result.stale).toEqual([cmtId(2)]);
    expect(result.comments.map((c) => c.id)).toEqual([cmtId(1), cmtId(3)]);
    const byId = Object.fromEntries((await h.snapshot()).comments.map((c) => [c.id, c.status]));
    expect(byId[cmtId(2)]).toBe('pending');
    expect(byId[cmtId(1)]).toBe(event === 'delivered' ? 'sent' : 'open');
    expect(byId[cmtId(3)]).toBe(event === 'delivered' ? 'sent' : 'open');
  });

  it('a missing request id is stale when the comment was issued under one', async () => {
    const h = await pendingPair();
    const result = ok(await h.transition([{ id: cmtId(1), event: 'delivered' }]));
    expect(result.stale).toEqual([cmtId(1)]);
    expect(result.comments).toEqual([]);
    expect((await h.snapshot()).comments[0].status).toBe('pending');
  });

  it('an all-stale call writes nothing', async () => {
    const h = await pendingPair();
    const rev = readDisk().rev;
    ok(await h.transition([{ id: cmtId(1), event: 'delivered', requestId: R2 }]));
    expect(readDisk().rev).toBe(rev);
  });

  it('matching works when neither side has a request id (older write-ahead without one)', async () => {
    const h = await open();
    ok(await h.create(pinDraft(1)));
    ok(await h.transition([{ id: cmtId(1), event: 'batch-issued' }]));
    expect(ok(await h.transition([{ id: cmtId(1), event: 'delivered' }])).stale).toEqual([]);
  });

  it('reload-recovered does not need a request id, and a real invalid transition still rejects the whole call', async () => {
    const h = await pendingPair();
    expect(ok(await h.transition([{ id: cmtId(1), event: 'reload-recovered' }])).stale).toEqual([]);
    ok(await h.update({ id: cmtId(3), expectedVersion: 2, change: { action: 'unqueue' } }));
    ok(await h.update({ id: cmtId(3), expectedVersion: 3, change: { action: 'resolve' } }));
    expect(reason(await h.transition([{ id: cmtId(2), event: 'delivered', requestId: R1 }, { id: cmtId(3), event: 'delivered', requestId: R2 }]))).toBe('invalid-transition');
    expect((await h.snapshot()).comments.find((c) => c.id === cmtId(2))!.status).toBe('pending');
  });
});

describe('A5: tombstones and timestamps', () => {
  it('create after remove clears the tombstone, and the comment survives a reload even at the same instant', async () => {
    const h = await open();
    ok(await h.create(pinDraft(1)));
    ok(await h.remove({ id: cmtId(1), expectedVersion: 1 }));
    expect(readDisk().tombstones.map((t: { id: string }) => t.id)).toEqual([cmtId(1)]);
    expect(ok(await h.create(pinDraft(1))).created).toBe(true);
    expect(readDisk().tombstones).toEqual([]);
    h.dispose();
    const snap = await (await open()).snapshot();
    expect(snap.comments.map((c) => c.id)).toEqual([cmtId(1)]);
    expect(snap.health).toBe('ok');
  });

  it('a comment dropped because of a tombstone counts as dropped and asks for quarantine', () => {
    const file = JSON.parse(JSON.stringify(fileOf([stored(1), stored(2)], { tombstones: [{ id: cmtId(1), at: NOW }] })));
    const result = normalizeCommentsFile(file, NOW_MS);
    expect(result.ok && result.report).toMatchObject({ dropped: 1, needsQuarantine: true });
  });

  it.each([
    ['february 31st', '2026-02-31T10:00:00.000Z'],
    ['month 13', '2026-13-01T10:00:00.000Z'],
    ['hour 25', '2026-11-12T25:00:00.000Z'],
    ['day 00', '2026-11-00T10:00:00.000Z'],
    ['minute 60', '2026-11-12T10:60:00.000Z'],
  ])('rejects an impossible date (%s) on load, in tombstones and in a pin draft', (_label, bad) => {
    const asComment = JSON.parse(JSON.stringify(fileOf([stored(1), stored(2, { updatedAt: bad })])));
    const r1 = normalizeCommentsFile(asComment, NOW_MS);
    expect(r1.ok && r1.file.comments.map((c) => c.id)).toEqual([cmtId(1)]);
    const created = JSON.parse(JSON.stringify(fileOf([stored(1, { createdAt: bad })])));
    expect(normalizeCommentsFile(created, NOW_MS).ok && (normalizeCommentsFile(created, NOW_MS) as { file: { comments: unknown[] } }).file.comments).toHaveLength(0);
    const tomb = JSON.parse(JSON.stringify(fileOf([stored(1)], { tombstones: [{ id: cmtId(5), at: bad }] })));
    const r3 = normalizeCommentsFile(tomb, NOW_MS);
    expect(r3.ok && r3.report.tombstonesDropped).toBe(1);
    expect(validatePinDraft(pinDraft(1, { createdAt: bad })).ok).toBe(false);
  });

  it('timestamps are normalized to canonical ISO (milliseconds, Z) on load', () => {
    const file = JSON.parse(JSON.stringify(fileOf([stored(1, { createdAt: '2026-11-12T09:01:00Z', updatedAt: '2026-11-12T09:02:00.5Z', sentAt: '2026-11-12T09:03:00Z' })])));
    const result = normalizeCommentsFile(file, NOW_MS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const c = result.file.comments[0];
      expect([c.createdAt, c.updatedAt, c.sentAt]).toEqual(['2026-11-12T09:01:00.000Z', '2026-11-12T09:02:00.500Z', '2026-11-12T09:03:00.000Z']);
    }
  });
});
