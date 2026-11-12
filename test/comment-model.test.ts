import { describe, expect, it } from 'vitest';
import {
  applyEvent,
  bodySha256,
  canonicalJson,
  createStoredComment,
  deriveCommentId,
  mergeBodies,
  migrate,
  nextStatus,
  normalizeCommentsFile,
  salvageComments,
  signComment,
  STATUS_EVENTS,
  toPublicComment,
  validatePinDraft,
  validateStoredComment,
  verifyComment,
} from '../src/commentModel';
import type { CommentsBody, StatusEvent, StoredComment } from '../src/commentModel';
import type { ArtifactCommentStatus } from '../src/geodeArtifactFeedbackV2';
import { ARTIFACT_ID, cmtId, fileOf, KEY, NOW, OTHER_KEY, pinDraft, prng, selId, stored } from './helpers/commentFixtures';

const NOW_MS = Date.parse(NOW);

describe('deriveCommentId', () => {
  it('maps sel_<32 hex> to cmt_<same hex>', () => {
    expect(deriveCommentId('sel_0123456789abcdef0123456789abcdef')).toBe('cmt_0123456789abcdef0123456789abcdef');
    expect(deriveCommentId(selId(255))).toBe(cmtId(255));
  });

  it.each([
    ['uppercase hex', 'sel_0123456789ABCDEF0123456789abcdef'],
    ['too short', 'sel_0123'],
    ['too long', 'sel_0123456789abcdef0123456789abcdef0'],
    ['wrong prefix', 'cmt_0123456789abcdef0123456789abcdef'],
    ['traversal', '../../x'],
    ['traversal in suffix', 'sel_../../../../etc/passwd/0123456789abcd'],
    ['NUL byte', 'sel_0123456789abcdef0123456789abcde\u0000'],
    ['trailing newline', 'sel_0123456789abcdef0123456789abcdef\n'],
    ['empty', ''],
  ])('rejects %s', (_label, value) => {
    expect(deriveCommentId(value)).toBeNull();
  });

  it.each([[undefined], [null], [12], [{}], [[]], [Symbol.iterator]])('rejects the non-string %s', (value) => {
    expect(deriveCommentId(value as never)).toBeNull();
  });
});

describe('canonicalJson and bodySha256', () => {
  it('sorts object keys at every depth and ignores insertion order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[3,{"x":2,"y":1}]},"b":1}');
  });

  it('hashes the same body identically regardless of key order', () => {
    const c = stored(1);
    const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(c).reverse())));
    expect(bodySha256({ comments: [c], tombstones: [], nextOrdinal: 2 })).toBe(bodySha256({ comments: [reordered], tombstones: [], nextOrdinal: 2 }));
    expect(bodySha256({ comments: [c], tombstones: [], nextOrdinal: 2 })).not.toBe(bodySha256({ comments: [c], tombstones: [], nextOrdinal: 3 }));
  });
});

describe('signature', () => {
  const base = stored(1);

  it('verifies for the same key and artifact', () => {
    expect(verifyComment(KEY, ARTIFACT_ID, base)).toBe(true);
  });

  it('is foreign for another key, another artifact, or a malformed signature', () => {
    expect(verifyComment(OTHER_KEY, ARTIFACT_ID, base)).toBe(false);
    expect(verifyComment(KEY, 'design-other', base)).toBe(false);
    for (const sig of ['', 'zz', 'a'.repeat(63), 'a'.repeat(65), base.sig.toUpperCase().replace(/[A-F]/g, 'G'), 12 as never, null as never, undefined as never]) {
      expect(verifyComment(KEY, ARTIFACT_ID, { ...base, sig })).toBe(false);
    }
  });

  it('covers id, selectionId, text, createdAt, route, selector and the artifact', () => {
    const sig = (patch: Record<string, unknown>) => signComment(KEY, ARTIFACT_ID, { ...base, ...patch } as StoredComment);
    expect(sig({})).toBe(base.sig);
    expect(sig({ id: cmtId(2) })).not.toBe(base.sig);
    expect(sig({ selectionId: selId(2) })).not.toBe(base.sig);
    expect(sig({ text: 'Rewritten by an agent' })).not.toBe(base.sig);
    expect(sig({ createdAt: '2026-11-12T09:59:00.000Z' })).not.toBe(base.sig);
    expect(sig({ anchor: { ...base.anchor, route: '/other.html' } })).not.toBe(base.sig);
    expect(sig({ anchor: { ...base.anchor, selector: 'footer' } })).not.toBe(base.sig);
    expect(signComment(KEY, 'design-other', base)).not.toBe(base.sig);
  });

  it('leaves status, send fields, ordinal, version and label outside the signature', () => {
    const sig = (patch: Record<string, unknown>) => signComment(KEY, ARTIFACT_ID, { ...base, ...patch } as StoredComment);
    expect(sig({ status: 'resolved', version: 9, ordinal: 4, label: 'x', sentAt: NOW, send: { attempts: 3, lastOutcome: 'failed', maybeSent: true, lastMessage: 'm', lastBatchRequestId: null } })).toBe(base.sig);
  });

  it('cannot be forged by moving a delimiter between fields (text with newlines)', () => {
    const a = signComment(KEY, ARTIFACT_ID, { ...base, text: 'a\nb', createdAt: 'c' } as StoredComment);
    const b = signComment(KEY, ARTIFACT_ID, { ...base, text: 'a', createdAt: 'b\nc' } as StoredComment);
    expect(a).not.toBe(b);
  });
});

describe('status machine', () => {
  type Target = ArtifactCommentStatus | 'deleted';
  const ALLOWED: Record<ArtifactCommentStatus, Partial<Record<StatusEvent, Target>>> = {
    open: { resolve: 'resolved', dismiss: 'dismissed', 'edit-text': 'open', remove: 'deleted', 'batch-issued': 'pending', delivered: 'sent' },
    pending: { unqueue: 'open', delivered: 'sent', 'send-failed': 'open', expired: 'open', 'reload-recovered': 'open' },
    sent: { resolve: 'resolved', dismiss: 'dismissed', reopen: 'open', remove: 'deleted', 'batch-resend': 'pending' },
    resolved: { reopen: 'open', remove: 'deleted' },
    dismissed: { reopen: 'open', remove: 'deleted' },
  };
  const statuses: ArtifactCommentStatus[] = ['open', 'pending', 'sent', 'resolved', 'dismissed'];

  it('lists exactly the twelve events', () => {
    expect([...STATUS_EVENTS].sort()).toEqual(
      ['batch-issued', 'batch-resend', 'delivered', 'dismiss', 'edit-text', 'expired', 'reload-recovered', 'remove', 'reopen', 'resolve', 'send-failed', 'unqueue'],
    );
  });

  describe.each(statuses)('from %s', (from) => {
    it.each([...STATUS_EVENTS])('event %s', (event) => {
      const expected = ALLOWED[from][event] ?? null;
      expect(nextStatus(from, event)).toBe(expected);
    });
  });

  it('forbids the called-out cases explicitly', () => {
    expect(nextStatus('resolved', 'dismiss')).toBeNull();
    expect(nextStatus('dismissed', 'resolve')).toBeNull();
    expect(nextStatus('pending', 'remove')).toBeNull();
    expect(nextStatus('pending', 'resolve')).toBeNull();
    expect(nextStatus('pending', 'dismiss')).toBeNull();
    expect(nextStatus('pending', 'edit-text')).toBeNull();
    expect(nextStatus('sent', 'edit-text')).toBeNull();
    expect(nextStatus('resolved', 'edit-text')).toBeNull();
    for (const from of statuses.filter((s) => s !== 'open')) expect(nextStatus(from, 'batch-issued')).toBeNull();
    expect(nextStatus('open', 'batch-resend')).toBeNull();
  });

  it('returns null for unknown statuses and events', () => {
    expect(nextStatus('done' as never, 'resolve')).toBeNull();
    expect(nextStatus('open', 'explode' as never)).toBeNull();
    expect(nextStatus('open', '__proto__' as never)).toBeNull();
  });

  describe('applyEvent', () => {
    const later = '2026-11-12T11:00:00.000Z';
    const ctx = { now: later };

    it('bumps version and updatedAt on every accepted change and leaves the input alone', () => {
      const c = stored(1);
      const frozen = JSON.stringify(c);
      const next = applyEvent(c, 'resolve', ctx)!;
      expect(next.status).toBe('resolved');
      expect(next.version).toBe(2);
      expect(next.updatedAt).toBe(later);
      expect(next.createdAt).toBe(c.createdAt);
      expect(JSON.stringify(c)).toBe(frozen);
    });

    it('returns null for a forbidden transition and for remove (a store-level operation)', () => {
      expect(applyEvent(stored(1, { status: 'resolved' }), 'dismiss', ctx)).toBeNull();
      expect(applyEvent(stored(1), 'remove', ctx)).toBeNull();
    });

    it('write-ahead on batch-issued: pending, attempts + 1, remembers the request id', () => {
      const next = applyEvent(stored(1), 'batch-issued', { now: later, requestId: 'req_' + 'a'.repeat(32) })!;
      expect(next.status).toBe('pending');
      expect(next.send.attempts).toBe(1);
      expect(next.send.lastBatchRequestId).toBe('req_' + 'a'.repeat(32));
    });

    it('delivered sets sentAt and lastOutcome and clears maybeSent', () => {
      const pending = stored(1, { status: 'pending', send: { attempts: 1, lastOutcome: null, maybeSent: true, lastMessage: null, lastBatchRequestId: null } });
      const next = applyEvent(pending, 'delivered', { now: later, message: 'Sent to the thread.' })!;
      expect(next.status).toBe('sent');
      expect(next.sentAt).toBe(later);
      expect(next.send.lastOutcome).toBe('sent');
      expect(next.send.maybeSent).toBe(false);
      expect(next.send.lastMessage).toBe('Sent to the thread.');
    });

    it('send-failed and expired return to open; failed records the outcome', () => {
      const pending = stored(1, { status: 'pending' });
      const failed = applyEvent(pending, 'send-failed', { now: later, message: 'The thread was busy.' })!;
      expect(failed.status).toBe('open');
      expect(failed.send.lastOutcome).toBe('failed');
      expect(failed.send.lastMessage).toBe('The thread was busy.');
      expect(applyEvent(pending, 'expired', ctx)!.status).toBe('open');
    });

    it('reload-recovered returns to open with maybeSent = true and lastOutcome unknown', () => {
      const next = applyEvent(stored(1, { status: 'pending' }), 'reload-recovered', ctx)!;
      expect(next.status).toBe('open');
      expect(next.send.maybeSent).toBe(true);
      expect(next.send.lastOutcome).toBe('unknown');
    });

    it('batch-resend moves sent to pending and counts the attempt', () => {
      const next = applyEvent(stored(1, { status: 'sent', sentAt: NOW, send: { attempts: 1, lastOutcome: 'sent', maybeSent: false, lastMessage: null, lastBatchRequestId: null } }), 'batch-resend', { now: later, requestId: 'req_' + 'b'.repeat(32) })!;
      expect(next.status).toBe('pending');
      expect(next.send.attempts).toBe(2);
    });

    it('edit-text replaces the text, only through ctx.text, and keeps the status', () => {
      const next = applyEvent(stored(1), 'edit-text', { now: later, text: 'New words' })!;
      expect(next.text).toBe('New words');
      expect(next.status).toBe('open');
      expect(applyEvent(stored(1), 'edit-text', ctx)).toBeNull();
    });

    it('truncates plugin-authored messages to 500 units', () => {
      const next = applyEvent(stored(1, { status: 'pending' }), 'send-failed', { now: later, message: 'x'.repeat(900) })!;
      expect(next.send.lastMessage).toHaveLength(500);
    });
  });
});

describe('validatePinDraft', () => {
  it('accepts a valid draft and returns a fresh allowlisted copy', () => {
    const raw = { ...pinDraft(1), junk: 'dropped' };
    const result = validatePinDraft(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.draft).not.toHaveProperty('junk');
      expect(result.draft.anchor).not.toBe(raw.anchor);
      expect(result.draft.text).toBe('Comment 1');
    }
  });

  it.each([
    ['selectionId traversal', { selectionId: '../../x' }],
    ['selectionId NUL', { selectionId: 'sel_0123456789abcdef0123456789abcde\u0000' }],
    ['empty text', { text: '' }],
    ['text over 4000', { text: 'x'.repeat(4001) }],
    ['non-string text', { text: 5 }],
    ['bad createdAt', { createdAt: 'yesterday' }],
    ['artifactRevision negative', { artifactRevision: -1 }],
    ['artifactRevision NaN', { artifactRevision: Number.NaN }],
    ['label over 120', { label: 'x'.repeat(121) }],
    ['hasScreenshot not boolean', { hasScreenshot: 'yes' }],
    ['viewSessionId too long', { viewSessionId: 'x'.repeat(200) }],
    ['kind unknown', { kind: 'sticker' }],
    ['anchor missing', { anchor: undefined }],
    ['anchor tag invalid', { anchor: { ...pinDraft(1).anchor, tag: 'BUTTON!' } }],
    ['anchor selector over 512', { anchor: { ...pinDraft(1).anchor, selector: 's'.repeat(513) } }],
    ['four alternates', { anchor: { ...pinDraft(1).anchor, selectorAlternates: ['a', 'b', 'c', 'd'] } }],
    ['alternate over 512', { anchor: { ...pinDraft(1).anchor, selectorAlternates: ['x'.repeat(513)] } }],
    ['text anchor over 80', { anchor: { ...pinDraft(1).anchor, textAnchor: { tag: 'button', text: 'x'.repeat(81) } } }],
    ['landmark over 120', { anchor: { ...pinDraft(1).anchor, landmark: 'x'.repeat(121) } }],
    ['route over 512', { anchor: { ...pinDraft(1).anchor, route: '/' + 'x'.repeat(512) } }],
    ['rect NaN', { anchor: { ...pinDraft(1).anchor, lastRect: { x: Number.NaN, y: 0, width: 1, height: 1 } } }],
    ['rect Infinity', { anchor: { ...pinDraft(1).anchor, lastRect: { x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 1 } } }],
    ['rect huge', { anchor: { ...pinDraft(1).anchor, lastRect: { x: 0, y: 0, width: 1e9, height: 1 } } }],
  ])('rejects %s', (_label, patch) => {
    const result = validatePinDraft({ ...pinDraft(1), ...patch });
    expect(result.ok).toBe(false);
  });

  it.each([[null], [undefined], [5], ['x'], [[]], [() => 1]])('rejects the non-object %s', (value) => {
    expect(validatePinDraft(value).ok).toBe(false);
  });

  it('allows redacted selections (empty text anchor, null landmark, null rect)', () => {
    const d = pinDraft(1, { redacted: true, anchor: { ...pinDraft(1).anchor, textAnchor: { tag: 'button', text: '' }, landmark: null, lastRect: null } });
    expect(validatePinDraft(d).ok).toBe(true);
  });
});

describe('createStoredComment', () => {
  it('derives the id, starts open at version 1, and signs', () => {
    const validated = validatePinDraft(pinDraft(3));
    if (!validated.ok) throw new Error('fixture draft must validate');
    const c = createStoredComment(validated.draft, { ordinal: 3, now: NOW, key: KEY, artifactId: ARTIFACT_ID });
    expect(c.id).toBe(cmtId(3));
    expect(c.status).toBe('open');
    expect(c.version).toBe(1);
    expect(c.ordinal).toBe(3);
    expect(c.sentAt).toBeNull();
    expect(c.send).toEqual({ attempts: 0, lastOutcome: null, maybeSent: false, lastMessage: null, lastBatchRequestId: null });
    expect(verifyComment(KEY, ARTIFACT_ID, c)).toBe(true);
  });
});

describe('validateStoredComment', () => {
  it('accepts a stored comment and returns an allowlisted copy', () => {
    const result = validateStoredComment({ ...stored(1), evil: 'x', __proto__: { polluted: true } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.clamped).toEqual([]);
      expect(result.comment).not.toHaveProperty('evil');
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    }
  });

  it('does not accept a prototype-pollution payload parsed from JSON', () => {
    const raw = JSON.parse(JSON.stringify(stored(1)).replace('{"id"', '{"__proto__":{"polluted":true},"id"'));
    const result = validateStoredComment(raw);
    expect(result.ok).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('rejects an id that does not derive from the selection id', () => {
    expect(validateStoredComment(stored(1, { id: cmtId(2) })).ok).toBe(false);
    expect(validateStoredComment(stored(1, { id: '../../x' })).ok).toBe(false);
    expect(validateStoredComment(stored(1, { selectionId: 'sel_nope' })).ok).toBe(false);
  });

  it.each([
    ['status unknown becomes open', { status: 'done' }, 'status', (c: StoredComment) => c.status === 'open'],
    ['status non-string becomes open', { status: 7 }, 'status', (c: StoredComment) => c.status === 'open'],
    ['ordinal 0 is flagged', { ordinal: 0 }, 'ordinal', (c: StoredComment) => c.ordinal === 0],
    ['ordinal negative is flagged', { ordinal: -3 }, 'ordinal', (c: StoredComment) => c.ordinal === 0],
    ['ordinal fractional is flagged', { ordinal: 1.5 }, 'ordinal', (c: StoredComment) => c.ordinal === 0],
    ['version 0 becomes 1', { version: 0 }, 'version', (c: StoredComment) => c.version === 1],
    ['version negative becomes 1', { version: -5 }, 'version', (c: StoredComment) => c.version === 1],
    ['version NaN becomes 1', { version: Number.NaN }, 'version', (c: StoredComment) => c.version === 1],
    ['kind unknown becomes pin', { kind: 'sticker' }, 'kind', (c: StoredComment) => c.kind === 'pin'],
    ['send garbage becomes defaults', { send: 'nope' }, 'send', (c: StoredComment) => c.send.attempts === 0 && c.send.maybeSent === false],
    ['sentAt garbage becomes null', { sentAt: 'later' }, 'sentAt', (c: StoredComment) => c.sentAt === null],
    ['sig not a string becomes empty', { sig: 5 }, 'sig', (c: StoredComment) => c.sig === ''],
  ])('clamps: %s', (_label, patch, field, check) => {
    const result = validateStoredComment({ ...stored(1), ...patch });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.clamped).toContain(field);
      expect(check(result.comment)).toBe(true);
    }
  });

  it.each([
    ['text empty', { text: '' }],
    ['text over 4000', { text: 'x'.repeat(4001) }],
    ['createdAt invalid', { createdAt: 'x' }],
    ['updatedAt invalid', { updatedAt: 5 }],
    ['anchor invalid', { anchor: { route: 5 } }],
    ['label too long', { label: 'x'.repeat(121) }],
    ['artifactRevision not a number', { artifactRevision: 'seven' }],
  ])('drops: %s', (_label, patch) => {
    expect(validateStoredComment({ ...stored(1), ...patch }).ok).toBe(false);
  });

  it('never throws and always returns a self-consistent result under 4000 seeded mutations', () => {
    const rand = prng(20261112);
    const junk: unknown[] = [null, undefined, 0, -1, 1e308, Number.NaN, '', 'x'.repeat(5000), [], {}, { a: 1 }, true, '__proto__', Symbol('s'), () => 1, [[]], 'sel_', '\u0000'];
    const keys = Object.keys(stored(1));
    for (let i = 0; i < 4000; i += 1) {
      const raw: Record<string, unknown> = { ...stored(1 + (i % 5)) };
      const mutations = 1 + Math.floor(rand() * 3);
      for (let m = 0; m < mutations; m += 1) {
        const key = keys[Math.floor(rand() * keys.length)];
        if (rand() < 0.2) delete raw[key];
        else raw[key] = junk[Math.floor(rand() * junk.length)];
      }
      let result: ReturnType<typeof validateStoredComment> | undefined;
      expect(() => { result = validateStoredComment(raw); }).not.toThrow();
      if (result!.ok) {
        const c = result!.comment;
        expect(c.id).toBe(deriveCommentId(c.selectionId));
        expect(c.text.length).toBeGreaterThanOrEqual(1);
        expect(c.text.length).toBeLessThanOrEqual(4000);
        expect(['open', 'pending', 'sent', 'resolved', 'dismissed']).toContain(c.status);
        expect(c.version).toBeGreaterThanOrEqual(1);
        expect(Number.isInteger(c.ordinal) && c.ordinal >= 0).toBe(true);
        expect(c.anchor.selector.length).toBeLessThanOrEqual(512);
      }
    }
  });

  it('survives non-object inputs', () => {
    for (const v of [null, undefined, 1, 'x', [], () => 1, Symbol('s')]) expect(validateStoredComment(v).ok).toBe(false);
  });
});

describe('normalizeCommentsFile', () => {
  it('accepts a valid file untouched and sorts comments by ordinal', () => {
    const result = normalizeCommentsFile(JSON.parse(JSON.stringify(fileOf([stored(3), stored(1), stored(2)]))), NOW_MS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.file.comments.map((c) => c.ordinal)).toEqual([1, 2, 3]);
      expect(result.report).toMatchObject({ dropped: 0, clamped: 0, duplicates: 0, overCap: 0, shaMismatch: false, needsQuarantine: false });
      expect(result.file.nextOrdinal).toBe(4);
    }
  });

  it.each([
    ['not an object', 5],
    ['array', []],
    ['wrong kind', { ...fileOf([]), kind: 'something-else' }],
    ['no comments array', { ...fileOf([]), comments: 'x' }],
    ['no schemaVersion', { ...fileOf([]), schemaVersion: undefined }],
    ['no artifactId', { ...fileOf([]), artifactId: 3 }],
    ['bad storeId', { ...fileOf([]), storeId: 'nope' }],
  ])('rejects a file that is %s', (_label, raw) => {
    expect(normalizeCommentsFile(JSON.parse(JSON.stringify(raw ?? null)), NOW_MS).ok).toBe(false);
  });

  it('flags a stale bodySha256 as a hand edit but keeps the comments', () => {
    const file = JSON.parse(JSON.stringify(fileOf([stored(1)])));
    file.comments[0].text = 'edited by hand';
    const result = normalizeCommentsFile(file, NOW_MS);
    expect(result.ok && result.report.shaMismatch).toBe(true);
    expect(result.ok && result.file.comments).toHaveLength(1);
  });

  it('drops invalid comments, counts them, and asks for quarantine', () => {
    const file = JSON.parse(JSON.stringify(fileOf([stored(1), stored(2)])));
    file.comments[1].text = '';
    file.comments.push(null, 5, 'x');
    const result = normalizeCommentsFile(file, NOW_MS);
    expect(result.ok && result.report).toMatchObject({ dropped: 4, needsQuarantine: true });
    expect(result.ok && result.file.comments.map((c) => c.id)).toEqual([cmtId(1)]);
  });

  it('clamps status and reassigns a zero ordinal to the next free one', () => {
    const file = JSON.parse(JSON.stringify(fileOf([stored(1), stored(2)])));
    file.comments[0].status = 'done';
    file.comments[1].ordinal = 0;
    const result = normalizeCommentsFile(file, NOW_MS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.report.clamped).toBe(2);
      expect(result.report.needsQuarantine).toBe(true);
      expect(result.file.comments.find((c) => c.id === cmtId(1))!.status).toBe('open');
      const fixed = result.file.comments.find((c) => c.id === cmtId(2))!;
      expect(fixed.ordinal).toBe(3);
      expect(result.file.nextOrdinal).toBe(4);
    }
  });

  it('keeps the highest version among same-id duplicates and counts the rest', () => {
    const lo = stored(1, { version: 2, text: 'old' });
    const hi = stored(1, { version: 5, text: 'new' });
    const result = normalizeCommentsFile(JSON.parse(JSON.stringify(fileOf([lo, hi]))), NOW_MS);
    expect(result.ok && result.file.comments).toHaveLength(1);
    expect(result.ok && result.file.comments[0].text).toBe('new');
    expect(result.ok && result.report).toMatchObject({ duplicates: 1, needsQuarantine: true });
  });

  it('truncates to the first 200 by ordinal and reports the overflow', () => {
    const many = Array.from({ length: 230 }, (_, i) => stored(i + 1));
    const result = normalizeCommentsFile(JSON.parse(JSON.stringify(fileOf(many))), NOW_MS);
    expect(result.ok && result.file.comments).toHaveLength(200);
    expect(result.ok && result.file.comments[199].ordinal).toBe(200);
    expect(result.ok && result.report).toMatchObject({ overCap: 30, needsQuarantine: true });
  });

  it('makes colliding ordinals unique: the later-created comment moves to the next free ordinal', () => {
    const early = stored(1, { ordinal: 5, createdAt: '2026-11-12T09:00:00.000Z' });
    const late = stored(2, { ordinal: 5, createdAt: '2026-11-12T09:30:00.000Z' });
    const result = normalizeCommentsFile(JSON.parse(JSON.stringify(fileOf([late, early]))), NOW_MS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const ordinals = result.file.comments.map((c) => [c.id, c.ordinal]);
      expect(ordinals).toContainEqual([cmtId(1), 5]);
      expect(ordinals).toContainEqual([cmtId(2), 6]);
      expect(result.report.reassigned).toEqual([cmtId(2)]);
      expect(result.file.nextOrdinal).toBe(7);
    }
  });

  it('raises nextOrdinal above every ordinal so none is reused', () => {
    const file = JSON.parse(JSON.stringify(fileOf([stored(1), stored(9)], { nextOrdinal: 2 })));
    const result = normalizeCommentsFile(file, NOW_MS);
    expect(result.ok && result.file.nextOrdinal).toBe(10);
  });

  it('sanitizes tombstones: drops malformed, expired (30 days) and caps at 200 newest', () => {
    const tombs = [
      { id: cmtId(900), at: '2026-11-11T00:00:00.000Z' },
      { id: cmtId(901), at: '2026-09-01T00:00:00.000Z' },
      { id: 'cmt_bad', at: NOW },
      { id: cmtId(902), at: 'nope' },
      null,
      ...Array.from({ length: 250 }, (_, i) => ({ id: cmtId(1000 + i), at: new Date(NOW_MS - (i + 1) * 60_000).toISOString() })),
    ];
    const file = JSON.parse(JSON.stringify(fileOf([], { tombstones: tombs })));
    const result = normalizeCommentsFile(file, NOW_MS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.file.tombstones).toHaveLength(200);
      expect(result.file.tombstones.some((t) => t.id === cmtId(901))).toBe(false);
      expect(result.file.tombstones.some((t) => t.id === 'cmt_bad')).toBe(false);
      expect(result.file.tombstones[0].at >= result.file.tombstones[199].at).toBe(true);
    }
  });

  it('removes a comment that has a newer-or-equal tombstone', () => {
    const file = JSON.parse(JSON.stringify(fileOf([stored(1), stored(2)], { tombstones: [{ id: cmtId(1), at: NOW }] })));
    const result = normalizeCommentsFile(file, NOW_MS);
    expect(result.ok && result.file.comments.map((c) => c.id)).toEqual([cmtId(2)]);
    expect(result.ok && result.report).toMatchObject({ dropped: 1, needsQuarantine: true });
  });
});

describe('migrate', () => {
  it('passes the current version through untouched', () => {
    const raw = JSON.parse(JSON.stringify(fileOf([stored(1)])));
    expect(migrate(raw)).toEqual({ status: 'ok', value: raw, migratedFrom: null });
  });

  it('reports a newer schema without touching it', () => {
    expect(migrate({ schemaVersion: 99 })).toEqual({ status: 'newer', version: 99 });
  });

  it.each([[0], [-1], [1.5], ['1'], [null], [undefined], [Number.NaN]])('rejects schemaVersion %s', (schemaVersion) => {
    expect(migrate({ schemaVersion }).status).toBe('invalid');
  });

  it('rejects non-objects', () => {
    for (const v of [null, 5, 'x', []]) expect(migrate(v).status).toBe('invalid');
  });

  it('applies a chain of pure migrations in order and does not mutate the input', () => {
    const table = {
      1: (r: Record<string, unknown>) => ({ ...r, schemaVersion: 2, items: r.comments, comments: undefined }),
      2: (r: Record<string, unknown>) => ({ ...r, schemaVersion: 3, comments: r.items, items: undefined, extra: 'added' }),
    };
    const input = Object.freeze({ schemaVersion: 1, comments: [1, 2, 3] });
    const result = migrate(input, table, 3);
    expect(result).toMatchObject({ status: 'ok', migratedFrom: 1 });
    if (result.status === 'ok') {
      const value = result.value as Record<string, unknown>;
      expect(value.schemaVersion).toBe(3);
      expect(value.comments).toEqual([1, 2, 3]);
      expect(value.extra).toBe('added');
    }
    expect(input).toEqual({ schemaVersion: 1, comments: [1, 2, 3] });
  });

  it('starts mid-chain for a file that is already partway', () => {
    const calls: number[] = [];
    const table = { 1: (r: Record<string, unknown>) => { calls.push(1); return { ...r, schemaVersion: 2 }; }, 2: (r: Record<string, unknown>) => { calls.push(2); return { ...r, schemaVersion: 3 }; } };
    expect(migrate({ schemaVersion: 2 }, table, 3)).toMatchObject({ status: 'ok', migratedFrom: 2 });
    expect(calls).toEqual([2]);
  });

  it('is invalid when a step is missing, throws, or does not advance the version', () => {
    expect(migrate({ schemaVersion: 1 }, {}, 2).status).toBe('invalid');
    expect(migrate({ schemaVersion: 1 }, { 1: () => { throw new Error('boom'); } }, 2).status).toBe('invalid');
    expect(migrate({ schemaVersion: 1 }, { 1: (r: Record<string, unknown>) => r }, 2).status).toBe('invalid');
  });
});

describe('salvageComments', () => {
  const comments = [stored(1), stored(2), stored(3)];
  const text = JSON.stringify(fileOf(comments), null, 2);

  it('recovers complete comments from a file truncated mid-way', () => {
    const cut = text.slice(0, text.indexOf('"id"', text.lastIndexOf('"id"') - 10) + 40);
    const salvaged = salvageComments(cut);
    expect(salvaged.map((c) => c.id)).toEqual([cmtId(1), cmtId(2)]);
  });

  it('recovers comments from a file with garbage around them', () => {
    const noisy = `<<<<<<< HEAD\n${text}\n=======\nrandom }{ text "quoted { brace"\n>>>>>>> other`;
    expect(salvageComments(noisy).map((c) => c.id)).toEqual([cmtId(1), cmtId(2), cmtId(3)]);
  });

  it('skips objects that fail comment validation and braces inside strings', () => {
    const tricky = JSON.stringify({ comments: [{ id: 'bad' }, stored(1, { text: 'has } and { braces " inside' })] });
    const salvaged = salvageComments(tricky.slice(0, -2));
    expect(salvaged).toHaveLength(1);
    expect(salvaged[0].text).toBe('has } and { braces " inside');
  });

  it('returns nothing for text without comments, and is bounded', () => {
    expect(salvageComments('')).toEqual([]);
    expect(salvageComments('not json at all')).toEqual([]);
    expect(salvageComments('{'.repeat(100_000))).toEqual([]);
    expect(salvageComments(JSON.stringify(Array.from({ length: 1000 }, (_, i) => stored(i + 1)))).length).toBeLessThanOrEqual(200);
  });
});

describe('toPublicComment', () => {
  it('builds a fresh data-only ArtifactComment: no sig, no private send fields, provenance attached', () => {
    const c = stored(1);
    const pub = toPublicComment(c, 'foreign');
    expect(pub.provenance).toBe('foreign');
    expect(pub).not.toHaveProperty('sig');
    expect(pub.send).not.toHaveProperty('lastBatchRequestId');
    expect(pub.anchor).not.toBe(c.anchor);
    expect(pub.anchor.selectorAlternates).not.toBe(c.anchor.selectorAlternates);
    expect(structuredClone(pub)).toEqual(pub);
  });
});

describe('mergeBodies', () => {
  const body = (comments: StoredComment[], extra: Partial<CommentsBody> = {}): CommentsBody => ({
    comments,
    tombstones: [],
    nextOrdinal: Math.max(0, ...comments.map((c) => c.ordinal)) + 1,
    ...extra,
  });
  const ids = (b: CommentsBody) => b.comments.map((c) => c.id);

  it('unions disjoint ids and takes the larger nextOrdinal', () => {
    const merged = mergeBodies(body([stored(1)], { nextOrdinal: 9 }), body([stored(2)]), NOW_MS);
    expect(ids(merged).sort()).toEqual([cmtId(1), cmtId(2)]);
    expect(merged.nextOrdinal).toBe(9);
    expect(merged.reassigned).toEqual([]);
  });

  it('higher version wins, then newer updatedAt, then the greater content hash', () => {
    const a = stored(1, { version: 3, text: 'a' });
    const b = stored(1, { version: 2, text: 'b' });
    expect(mergeBodies(body([a]), body([b]), NOW_MS).comments[0].text).toBe('a');
    const c = stored(1, { version: 2, text: 'c', updatedAt: '2026-11-12T09:30:00.000Z' });
    const d = stored(1, { version: 2, text: 'd', updatedAt: '2026-11-12T09:45:00.000Z' });
    expect(mergeBodies(body([c]), body([d]), NOW_MS).comments[0].text).toBe('d');
    expect(mergeBodies(body([d]), body([c]), NOW_MS).comments[0].text).toBe('d');
    const e = stored(1, { version: 2, text: 'e', updatedAt: NOW });
    const f = stored(1, { version: 2, text: 'f', updatedAt: NOW });
    expect(mergeBodies(body([e]), body([f]), NOW_MS).comments[0].text).toBe(mergeBodies(body([f]), body([e]), NOW_MS).comments[0].text);
  });

  it('a tombstone wins over a comment not newer than it, and loses to a later edit', () => {
    const old = stored(1, { updatedAt: '2026-11-12T08:00:00.000Z' });
    const dead = body([], { tombstones: [{ id: cmtId(1), at: '2026-11-12T09:00:00.000Z' }] });
    expect(ids(mergeBodies(body([old]), dead, NOW_MS))).toEqual([]);
    expect(ids(mergeBodies(dead, body([old]), NOW_MS))).toEqual([]);
    const edited = stored(1, { version: 4, updatedAt: '2026-11-12T09:30:00.000Z' });
    const m = mergeBodies(body([edited]), dead, NOW_MS);
    expect(ids(m)).toEqual([cmtId(1)]);
    expect(m.tombstones.some((t) => t.id === cmtId(1))).toBe(false);
  });

  it('keeps the newest tombstone per id, expires old ones, and caps at 200', () => {
    const t = (id: string, at: string) => ({ id, at });
    const m = mergeBodies(
      body([], { tombstones: [t(cmtId(1), '2026-11-12T08:00:00.000Z'), t(cmtId(2), '2026-09-01T00:00:00.000Z')] }),
      body([], { tombstones: [t(cmtId(1), '2026-11-12T09:00:00.000Z'), ...Array.from({ length: 100 }, (_, i) => t(cmtId(100 + i), new Date(NOW_MS - (i + 1) * 1000).toISOString()))] }),
      NOW_MS,
    );
    expect(m.tombstones.find((x) => x.id === cmtId(1))!.at).toBe('2026-11-12T09:00:00.000Z');
    expect(m.tombstones.some((x) => x.id === cmtId(2))).toBe(false);
    const crowded = mergeBodies(body([]), body([], { tombstones: Array.from({ length: 250 }, (_, i) => t(cmtId(100 + i), new Date(NOW_MS - (i + 1) * 1000).toISOString())) }), NOW_MS);
    expect(crowded.tombstones).toHaveLength(200);
    expect(crowded.tombstones[0].id).toBe(cmtId(100));
  });

  it('two machines that both created ordinal 7: the later-created comment gets the next free ordinal', () => {
    const here = stored(1, { ordinal: 7, createdAt: '2026-11-12T09:00:00.000Z' });
    const there = stored(2, { ordinal: 7, createdAt: '2026-11-12T09:10:00.000Z' });
    const m = mergeBodies(body([here], { nextOrdinal: 8 }), body([there], { nextOrdinal: 8 }), NOW_MS);
    const byId = Object.fromEntries(m.comments.map((c) => [c.id, c.ordinal]));
    expect(byId).toEqual({ [cmtId(1)]: 7, [cmtId(2)]: 8 });
    expect(m.reassigned).toEqual([cmtId(2)]);
    expect(m.nextOrdinal).toBe(9);
    expect(m.comments.find((c) => c.id === cmtId(2))!.version).toBe(2);
    const flipped = mergeBodies(body([there], { nextOrdinal: 8 }), body([here], { nextOrdinal: 8 }), NOW_MS);
    expect(flipped.comments.map((c) => [c.id, c.ordinal])).toEqual(m.comments.map((c) => [c.id, c.ordinal]));
  });

  describe('properties over 300 seeded random body pairs', () => {
    const rand = prng(424242);
    const randomBody = (): CommentsBody => {
      const comments: StoredComment[] = [];
      const tombstones: { id: string; at: string }[] = [];
      for (let n = 1; n <= 8; n += 1) {
        const roll = rand();
        if (roll < 0.45) {
          comments.push(stored(n, {
            ordinal: 1 + Math.floor(rand() * 8),
            version: 1 + Math.floor(rand() * 3),
            status: ['open', 'sent', 'resolved', 'dismissed'][Math.floor(rand() * 4)],
            text: `t${Math.floor(rand() * 3)}`,
            updatedAt: new Date(NOW_MS - Math.floor(rand() * 4) * 3_600_000).toISOString(),
          }));
        } else if (roll < 0.6) {
          tombstones.push({ id: cmtId(n), at: new Date(NOW_MS - Math.floor(rand() * 4) * 3_600_000).toISOString() });
        }
      }
      return { comments, tombstones, nextOrdinal: 1 + Math.floor(rand() * 12) };
    };
    const norm = (m: CommentsBody) => JSON.stringify({ c: [...m.comments].sort((x, y) => (x.id < y.id ? -1 : 1)), t: [...m.tombstones].sort((x, y) => (x.id < y.id ? -1 : 1)), n: m.nextOrdinal });
    const pairs = Array.from({ length: 300 }, () => [randomBody(), randomBody()] as const);

    it('is commutative', () => {
      for (const [a, b] of pairs) expect(norm(mergeBodies(a, b, NOW_MS))).toBe(norm(mergeBodies(b, a, NOW_MS)));
    });

    it('is idempotent: merging the result with either input changes nothing', () => {
      for (const [a, b] of pairs) {
        const m = mergeBodies(a, b, NOW_MS);
        expect(norm(mergeBodies(m, m, NOW_MS))).toBe(norm(m));
        expect(norm(mergeBodies(m, a, NOW_MS))).toBe(norm(m));
        expect(norm(mergeBodies(m, b, NOW_MS))).toBe(norm(m));
      }
    });

    it('yields unique ordinals, nextOrdinal above all of them, and never resurrects a covered tombstone', () => {
      for (const [a, b] of pairs) {
        const m = mergeBodies(a, b, NOW_MS);
        const ords = m.comments.map((c) => c.ordinal);
        expect(new Set(ords).size).toBe(ords.length);
        expect(m.nextOrdinal).toBeGreaterThan(Math.max(0, ...ords));
        expect(m.nextOrdinal).toBeGreaterThanOrEqual(Math.max(a.nextOrdinal, b.nextOrdinal));
        for (const t of m.tombstones) {
          const alive = m.comments.find((c) => c.id === t.id);
          if (alive) expect(alive.updatedAt > t.at).toBe(true);
        }
      }
    });

    it('with an empty body is the identity (apart from tombstone expiry)', () => {
      for (const [a] of pairs) {
        const m = mergeBodies(a, { comments: [], tombstones: [], nextOrdinal: 1 }, NOW_MS);
        expect(m.comments.map((c) => c.id).sort()).toEqual(a.comments.filter((c) => !a.tombstones.some((t) => t.id === c.id && c.updatedAt <= t.at)).map((c) => c.id).sort());
      }
    });
  });
});
