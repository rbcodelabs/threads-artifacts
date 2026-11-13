import { signComment, bodySha256, deriveCommentId } from '../../src/commentModel';
import type { CommentsFile, StoredComment } from '../../src/commentModel';

export const KEY = new Uint8Array(32).fill(7);
export const OTHER_KEY = new Uint8Array(32).fill(9);
export const ARTIFACT_ID = 'design-t1';
export const NOW = '2026-11-12T10:00:00.000Z';

/** sel_ id number n, zero padded to 32 hex digits. */
export const selId = (n: number): string => `sel_${n.toString(16).padStart(32, '0')}`;
export const cmtId = (n: number): string => `cmt_${n.toString(16).padStart(32, '0')}`;

export function pinDraft(n: number, overrides: Record<string, unknown> = {}) {
  return {
    selectionId: selId(n),
    createdAt: `2026-11-12T09:${String(n % 60).padStart(2, '0')}:00.000Z`,
    artifactRevision: 7,
    viewSessionId: 'view-1',
    kind: 'pin' as const,
    text: `Comment ${n}`,
    anchor: {
      route: '/index.html',
      tag: 'button',
      selector: `main > button:nth-of-type(${n})`,
      selectorAlternates: ['#save'],
      textAnchor: { tag: 'button', text: 'Save' },
      landmark: 'Hero',
      lastRect: { x: 1, y: 2, width: 30, height: 10 },
    },
    label: 'button Save',
    hasScreenshot: false,
    redacted: false,
    ...overrides,
  };
}

/** A fully valid stored comment signed with KEY for ARTIFACT_ID. */
export function stored(n: number, overrides: Record<string, unknown> = {}, opts: { key?: Uint8Array; artifactId?: string } = {}): StoredComment {
  const d = pinDraft(n);
  const base = {
    id: deriveCommentId(d.selectionId)!,
    selectionId: d.selectionId,
    ordinal: n,
    version: 1,
    kind: 'pin',
    status: 'open',
    text: d.text,
    createdAt: d.createdAt,
    updatedAt: d.createdAt,
    sentAt: null,
    artifactRevision: 7,
    viewSessionId: 'view-1',
    anchor: d.anchor,
    label: d.label,
    hasScreenshot: false,
    redacted: false,
    send: { attempts: 0, lastOutcome: null, maybeSent: false, lastMessage: null, lastBatchRequestId: null },
    sig: '',
    ...overrides,
  } as StoredComment;
  const out = { ...base } as { -readonly [K in keyof StoredComment]: StoredComment[K] };
  if (!('sig' in overrides)) out.sig = signComment(opts.key ?? KEY, opts.artifactId ?? ARTIFACT_ID, out);
  return out;
}

export function fileOf(comments: StoredComment[], overrides: Record<string, unknown> = {}): CommentsFile {
  const body = { comments, tombstones: [] as { id: string; at: string }[], nextOrdinal: Math.max(0, ...comments.map((c) => c.ordinal)) + 1 };
  const file = {
    schemaVersion: 1,
    kind: 'threads-design.comments',
    artifactId: ARTIFACT_ID,
    storeId: 'str_' + 'a'.repeat(32),
    rev: 1,
    nextOrdinal: body.nextOrdinal,
    writtenBy: 'threads-design@test',
    writtenAt: NOW,
    bodySha256: '',
    comments,
    tombstones: body.tombstones,
    ...overrides,
  } as CommentsFile;
  const out = file as { -readonly [K in keyof CommentsFile]: CommentsFile[K] };
  if (!('bodySha256' in overrides)) out.bodySha256 = bodySha256({ comments: out.comments, tombstones: out.tombstones, nextOrdinal: out.nextOrdinal });
  return out;
}

/** mulberry32: deterministic PRNG so fuzz failures reproduce. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
