import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  ARTIFACT_COMMENT_ID_PATTERN,
  ARTIFACT_COMMENTS_CAPS,
  ARTIFACT_COMMENTS_REQUEST_ID_PATTERN,
} from './geodeArtifactFeedbackV2';
import type {
  ArtifactComment,
  ArtifactCommentAnchor,
  ArtifactCommentKind,
  ArtifactCommentProvenance,
  ArtifactCommentStatus,
} from './geodeArtifactFeedbackV2';

/**
 * Pure model for the pinned-comments store (Phase 2b-i design, section 2). No I/O here: validation,
 * ids, signatures, the status machine, merge and migration are all deterministic functions of their
 * arguments so they can be tested exhaustively. Everything read from `comments.json` is untrusted
 * input: every field is rebuilt from an allowlist and checked before it is used.
 */

export const COMMENTS_SCHEMA_VERSION = 1;
export const COMMENTS_FILE_KIND = 'threads-design.comments';
export const MAX_WRITE_BYTES = 2 * 1024 * 1024;
export const MAX_READ_BYTES = 4 * 1024 * 1024;
export const MAX_TOMBSTONES = 200;
export const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_COMMENTS = ARTIFACT_COMMENTS_CAPS.maxComments;

const SELECTION_ID = /^sel_([0-9a-f]{32})$/;
const STORE_ID = /^str_[0-9a-f]{32}$/;
const TAG = /^[a-z][a-z0-9:-]{0,31}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const SIG = /^[0-9a-f]{64}$/;
const MAX_COORD = 1e6;
const MAX_VIEW_SESSION = 128;
const MAX_ARTIFACT_ID = 256;

// ---------------------------------------------------------------------------------------------
// Stored shapes
// ---------------------------------------------------------------------------------------------

export interface StoredSend {
  readonly attempts: number;
  readonly lastOutcome: 'sent' | 'queued' | 'failed' | 'unknown' | null;
  readonly maybeSent: boolean;
  readonly lastMessage: string | null;
  /** Plugin-private: which batch request last put this comment in `pending` (P2b). */
  readonly lastBatchRequestId: string | null;
}

/** What `comments.json` holds per comment: every ArtifactComment field except `provenance` (derived at load), plus `sig`. */
export interface StoredComment extends Omit<ArtifactComment, 'provenance' | 'send'> {
  readonly send: StoredSend;
  readonly sig: string;
}

export interface Tombstone {
  readonly id: string;
  readonly at: string;
}

export interface CommentsBody {
  readonly comments: readonly StoredComment[];
  readonly tombstones: readonly Tombstone[];
  readonly nextOrdinal: number;
}

export interface CommentsFile extends CommentsBody {
  readonly schemaVersion: number;
  readonly kind: typeof COMMENTS_FILE_KIND;
  readonly artifactId: string;
  readonly storeId: string;
  readonly rev: number;
  readonly writtenBy: string;
  readonly writtenAt: string;
  readonly bodySha256: string;
}

/** What the store needs to make a pin; the provider (P2a) derives it from a validated v1 request. */
export interface PinDraft {
  readonly selectionId: string;
  readonly createdAt: string;
  readonly artifactRevision: number;
  readonly viewSessionId: string;
  readonly kind: ArtifactCommentKind;
  readonly text: string;
  readonly anchor: ArtifactCommentAnchor;
  readonly label: string;
  readonly hasScreenshot: boolean;
  readonly redacted: boolean;
}

// ---------------------------------------------------------------------------------------------
// Primitive helpers
// ---------------------------------------------------------------------------------------------

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
/** Reads an own property only, so a hostile prototype can never inject a field. */
const own = (obj: Json, key: string): unknown => (Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined);
const isString = (value: unknown, max: number, min = 0): value is string => typeof value === 'string' && value.length >= min && value.length <= max;
const isIso = (value: unknown): value is string => typeof value === 'string' && ISO.test(value) && Number.isFinite(Date.parse(value));
/** Counters stay far below 2^53 so `+ 1` always changes them; a hostile file cannot park one at the edge. */
const MAX_COUNTER = 1_000_000_000;
const isInt = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
const truncate = (value: string, max: number): string => (value.length > max ? value.slice(0, max) : value);

/** Deterministic JSON: object keys sorted at every depth, `undefined` members omitted. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const obj = value as Json;
    const parts: string[] = [];
    for (const key of Object.keys(obj).sort()) {
      if (obj[key] === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${canonicalJson(obj[key])}`);
    }
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

export function bodySha256(body: CommentsBody): string {
  return sha256(canonicalJson({ comments: body.comments, tombstones: body.tombstones, nextOrdinal: body.nextOrdinal }));
}

const commentHash = (comment: StoredComment): string => sha256(canonicalJson(comment));

// ---------------------------------------------------------------------------------------------
// Ids and signatures
// ---------------------------------------------------------------------------------------------

/** `sel_<32 hex>` -> `cmt_<32 hex>`. Null for anything else, before it can reach a path or a lookup. */
export function deriveCommentId(selectionId: unknown): string | null {
  if (typeof selectionId !== 'string') return null;
  const match = SELECTION_ID.exec(selectionId);
  return match ? `cmt_${match[1]}` : null;
}

export const isCommentId = (value: unknown): value is string => typeof value === 'string' && ARTIFACT_COMMENT_ID_PATTERN.test(value);
export const isRequestId = (value: unknown): value is string => typeof value === 'string' && ARTIFACT_COMMENTS_REQUEST_ID_PATTERN.test(value);

type Signable = Pick<StoredComment, 'id' | 'selectionId' | 'text' | 'createdAt'> & { readonly anchor: Pick<ArtifactCommentAnchor, 'route' | 'selector'> };

/**
 * HMAC-SHA256 over the identity-defining fields. Status and send fields are deliberately outside it
 * (they change constantly; an agent flipping a status is cosmetic, rewriting comment text is the attack).
 * Deviation from the design note's `id \n selectionId \n ...`: the fields are JSON-encoded as an array
 * (newlines inside `text` cannot move a delimiter) and the artifact id is included, so copying a
 * comment into another artifact's file cannot make it local even on the same install.
 */
export function signComment(key: Uint8Array, artifactId: string, comment: Signable): string {
  const message = JSON.stringify(['threads-design.comment.v1', artifactId, comment.id, comment.selectionId, comment.text, comment.createdAt, comment.anchor.route, comment.anchor.selector]);
  return createHmac('sha256', key).update(message).digest('hex');
}

export function verifyComment(key: Uint8Array, artifactId: string, comment: Signable & { readonly sig: unknown }): boolean {
  if (typeof comment.sig !== 'string' || !SIG.test(comment.sig)) return false;
  const expected = Buffer.from(signComment(key, artifactId, comment), 'hex');
  const actual = Buffer.from(comment.sig, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// ---------------------------------------------------------------------------------------------
// Status machine (enforced only inside the store mutex)
// ---------------------------------------------------------------------------------------------

export const STATUS_EVENTS = [
  'resolve', 'dismiss', 'reopen', 'unqueue', 'edit-text', 'remove',
  'batch-issued', 'batch-resend', 'delivered', 'send-failed', 'expired', 'reload-recovered',
] as const;
export type StatusEvent = (typeof STATUS_EVENTS)[number];
/** Events the plugin raises itself (send flow); `resolve`, `dismiss`, `reopen`, `unqueue`, text edit and remove are user intents. */
export const SYSTEM_EVENTS = ['batch-issued', 'batch-resend', 'delivered', 'send-failed', 'expired', 'reload-recovered'] as const;
export type SystemEvent = (typeof SYSTEM_EVENTS)[number];

type Target = ArtifactCommentStatus | 'deleted';
const TRANSITIONS: Readonly<Record<ArtifactCommentStatus, Readonly<Partial<Record<StatusEvent, Target>>>>> = {
  open: { resolve: 'resolved', dismiss: 'dismissed', 'edit-text': 'open', remove: 'deleted', 'batch-issued': 'pending', delivered: 'sent' },
  pending: { unqueue: 'open', delivered: 'sent', 'send-failed': 'open', expired: 'open', 'reload-recovered': 'open' },
  sent: { resolve: 'resolved', dismiss: 'dismissed', reopen: 'open', remove: 'deleted', 'batch-resend': 'pending' },
  resolved: { reopen: 'open', remove: 'deleted' },
  dismissed: { reopen: 'open', remove: 'deleted' },
};

export function nextStatus(status: ArtifactCommentStatus, event: StatusEvent): Target | null {
  if (!Object.prototype.hasOwnProperty.call(TRANSITIONS, status)) return null;
  const row = TRANSITIONS[status];
  return Object.prototype.hasOwnProperty.call(row, event) ? (row[event] ?? null) : null;
}

export interface EventContext {
  readonly now: string;
  readonly requestId?: string | null;
  readonly message?: string | null;
  readonly text?: string;
}

/** Applies one event. Returns null when the transition is forbidden. `remove` is a store-level operation and returns null here. */
export function applyEvent(comment: StoredComment, event: StatusEvent, ctx: EventContext): StoredComment | null {
  const target = nextStatus(comment.status, event);
  if (target === null || target === 'deleted') return null;
  const message = typeof ctx.message === 'string' ? truncate(ctx.message, ARTIFACT_COMMENTS_CAPS.maxMessageUnits) : null;
  let send: StoredSend = comment.send;
  let sentAt = comment.sentAt;
  let text = comment.text;
  switch (event) {
    case 'edit-text':
      if (typeof ctx.text !== 'string' || ctx.text.length < 1 || ctx.text.length > ARTIFACT_COMMENTS_CAPS.maxTextUnits) return null;
      text = ctx.text;
      break;
    case 'batch-issued':
    case 'batch-resend':
      send = { ...send, attempts: send.attempts + 1, lastBatchRequestId: isRequestId(ctx.requestId) ? ctx.requestId : null };
      break;
    case 'delivered':
      sentAt = ctx.now;
      send = { ...send, lastOutcome: 'sent', maybeSent: false, lastMessage: message };
      break;
    case 'send-failed':
      send = { ...send, lastOutcome: 'failed', lastMessage: message };
      break;
    case 'expired':
      send = { ...send, lastOutcome: 'failed', lastMessage: message };
      break;
    case 'reload-recovered':
      send = { ...send, lastOutcome: 'unknown', maybeSent: true, lastMessage: message };
      break;
    default:
      break;
  }
  return { ...comment, status: target, text, sentAt, send, version: comment.version + 1, updatedAt: ctx.now };
}

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

const finiteCoord = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_COORD;

function readAnchor(raw: unknown): ArtifactCommentAnchor | null {
  if (!isObject(raw)) return null;
  const route = own(raw, 'route');
  const tag = own(raw, 'tag');
  const selector = own(raw, 'selector');
  const alternates = own(raw, 'selectorAlternates');
  const textAnchor = own(raw, 'textAnchor');
  const landmark = own(raw, 'landmark');
  const rect = own(raw, 'lastRect');
  if (!isString(route, 512) || typeof tag !== 'string' || !TAG.test(tag) || !isString(selector, 512)) return null;
  if (!Array.isArray(alternates) || alternates.length > 3 || !alternates.every((a) => isString(a, 512))) return null;
  if (!isObject(textAnchor)) return null;
  const anchorTag = own(textAnchor, 'tag');
  const anchorText = own(textAnchor, 'text');
  if (typeof anchorTag !== 'string' || !TAG.test(anchorTag) || !isString(anchorText, 80)) return null;
  if (landmark !== null && !isString(landmark, 120)) return null;
  let lastRect: ArtifactCommentAnchor['lastRect'] = null;
  if (rect !== null) {
    if (!isObject(rect)) return null;
    const x = own(rect, 'x'); const y = own(rect, 'y'); const width = own(rect, 'width'); const height = own(rect, 'height');
    if (!finiteCoord(x) || !finiteCoord(y) || !finiteCoord(width) || !finiteCoord(height)) return null;
    lastRect = { x, y, width, height };
  }
  return {
    route,
    tag,
    selector,
    selectorAlternates: [...(alternates as string[])],
    textAnchor: { tag: anchorTag, text: anchorText },
    landmark: landmark as string | null,
    lastRect,
  };
}

export type DraftValidation = { readonly ok: true; readonly draft: PinDraft } | { readonly ok: false; readonly reason: string };

/** Validates a pin draft (what Geode's request becomes). Rebuilds an allowlisted copy. */
export function validatePinDraft(raw: unknown): DraftValidation {
  if (!isObject(raw)) return { ok: false, reason: 'The pin could not be read.' };
  const selectionId = own(raw, 'selectionId');
  if (typeof selectionId !== 'string' || !SELECTION_ID.test(selectionId)) return { ok: false, reason: 'Invalid selection id.' };
  const text = own(raw, 'text');
  if (!isString(text, ARTIFACT_COMMENTS_CAPS.maxTextUnits, 1)) return { ok: false, reason: 'The comment must be 1 to 4000 characters.' };
  const createdAt = own(raw, 'createdAt');
  if (!isIso(createdAt)) return { ok: false, reason: 'Invalid timestamp.' };
  const artifactRevision = own(raw, 'artifactRevision');
  if (!isInt(artifactRevision, 0)) return { ok: false, reason: 'Invalid artifact revision.' };
  const viewSessionId = own(raw, 'viewSessionId');
  if (!isString(viewSessionId, MAX_VIEW_SESSION)) return { ok: false, reason: 'Invalid view session.' };
  const kindRaw = own(raw, 'kind');
  const kind = kindRaw === undefined ? 'pin' : kindRaw;
  if (kind !== 'pin' && kind !== 'text-edit') return { ok: false, reason: 'Invalid comment kind.' };
  const label = own(raw, 'label');
  if (!isString(label, ARTIFACT_COMMENTS_CAPS.maxLabelUnits)) return { ok: false, reason: 'Invalid label.' };
  const hasScreenshot = own(raw, 'hasScreenshot');
  const redacted = own(raw, 'redacted');
  if (typeof hasScreenshot !== 'boolean' || typeof redacted !== 'boolean') return { ok: false, reason: 'Invalid flags.' };
  const anchor = readAnchor(own(raw, 'anchor'));
  if (anchor === null) return { ok: false, reason: 'Invalid anchor.' };
  return { ok: true, draft: { selectionId, createdAt, artifactRevision, viewSessionId, kind, text, anchor, label, hasScreenshot, redacted } };
}

export function createStoredComment(draft: PinDraft, input: { ordinal: number; now: string; key: Uint8Array; artifactId: string }): StoredComment {
  const id = deriveCommentId(draft.selectionId);
  if (id === null) throw new Error('Invalid selection id.');
  const unsigned: StoredComment = {
    id,
    selectionId: draft.selectionId,
    ordinal: input.ordinal,
    version: 1,
    kind: draft.kind,
    status: 'open',
    text: draft.text,
    createdAt: draft.createdAt,
    updatedAt: input.now,
    sentAt: null,
    artifactRevision: draft.artifactRevision,
    viewSessionId: draft.viewSessionId,
    anchor: draft.anchor,
    label: draft.label,
    hasScreenshot: draft.hasScreenshot,
    redacted: draft.redacted,
    send: { attempts: 0, lastOutcome: null, maybeSent: false, lastMessage: null, lastBatchRequestId: null },
    sig: '',
  };
  return { ...unsigned, sig: signComment(input.key, input.artifactId, unsigned) };
}

export type CommentValidation =
  | { readonly ok: true; readonly comment: StoredComment; readonly clamped: readonly string[] }
  | { readonly ok: false; readonly reason: string };

const STATUSES: readonly ArtifactCommentStatus[] = ['open', 'pending', 'sent', 'resolved', 'dismissed'];
const OUTCOMES = ['sent', 'queued', 'failed', 'unknown'] as const;

/**
 * Validates one comment read from disk. Fatal problems (identity, text, anchor, timestamps) drop the
 * comment; recoverable ones are clamped to a legal value and reported. An ordinal that is not a
 * positive integer comes back as 0 so the file-level pass can assign a free one.
 */
export function validateStoredComment(raw: unknown): CommentValidation {
  if (!isObject(raw)) return { ok: false, reason: 'not an object' };
  const selectionId = own(raw, 'selectionId');
  if (typeof selectionId !== 'string' || !SELECTION_ID.test(selectionId)) return { ok: false, reason: 'bad selection id' };
  const id = own(raw, 'id');
  if (typeof id !== 'string' || id !== deriveCommentId(selectionId)) return { ok: false, reason: 'id does not derive from the selection id' };
  const text = own(raw, 'text');
  if (!isString(text, ARTIFACT_COMMENTS_CAPS.maxTextUnits, 1)) return { ok: false, reason: 'bad text' };
  const createdAt = own(raw, 'createdAt');
  const updatedAt = own(raw, 'updatedAt');
  if (!isIso(createdAt) || !isIso(updatedAt)) return { ok: false, reason: 'bad timestamp' };
  const anchor = readAnchor(own(raw, 'anchor'));
  if (anchor === null) return { ok: false, reason: 'bad anchor' };
  const label = own(raw, 'label');
  if (!isString(label, ARTIFACT_COMMENTS_CAPS.maxLabelUnits)) return { ok: false, reason: 'bad label' };
  const artifactRevision = own(raw, 'artifactRevision');
  if (!isInt(artifactRevision, 0)) return { ok: false, reason: 'bad artifact revision' };
  const viewSessionId = own(raw, 'viewSessionId');
  if (!isString(viewSessionId, MAX_VIEW_SESSION)) return { ok: false, reason: 'bad view session' };
  const hasScreenshot = own(raw, 'hasScreenshot');
  const redacted = own(raw, 'redacted');
  if (typeof hasScreenshot !== 'boolean' || typeof redacted !== 'boolean') return { ok: false, reason: 'bad flags' };

  const clamped: string[] = [];
  const statusRaw = own(raw, 'status');
  const status: ArtifactCommentStatus = STATUSES.includes(statusRaw as ArtifactCommentStatus) ? (statusRaw as ArtifactCommentStatus) : (clamped.push('status'), 'open');
  const kindRaw = own(raw, 'kind');
  const kind: ArtifactCommentKind = kindRaw === 'pin' || kindRaw === 'text-edit' ? kindRaw : (clamped.push('kind'), 'pin');
  const versionRaw = own(raw, 'version');
  const version = isInt(versionRaw, 1, MAX_COUNTER) ? versionRaw : (clamped.push('version'), 1);
  const ordinalRaw = own(raw, 'ordinal');
  const ordinal = isInt(ordinalRaw, 1, MAX_COUNTER) ? ordinalRaw : (clamped.push('ordinal'), 0);
  const sentAtRaw = own(raw, 'sentAt');
  const sentAt = sentAtRaw === null ? null : isIso(sentAtRaw) ? sentAtRaw : (clamped.push('sentAt'), null);
  const sigRaw = own(raw, 'sig');
  const sig = typeof sigRaw === 'string' && sigRaw.length <= 256 ? sigRaw : (clamped.push('sig'), '');

  const sendRaw = own(raw, 'send');
  let send: StoredSend = { attempts: 0, lastOutcome: null, maybeSent: false, lastMessage: null, lastBatchRequestId: null };
  if (isObject(sendRaw)) {
    const attempts = own(sendRaw, 'attempts');
    const outcome = own(sendRaw, 'lastOutcome');
    const maybeSent = own(sendRaw, 'maybeSent');
    const message = own(sendRaw, 'lastMessage');
    const batch = own(sendRaw, 'lastBatchRequestId');
    let touched = false;
    const pick = <T,>(ok: boolean, value: T, fallback: T): T => { if (!ok) touched = true; return ok ? value : fallback; };
    send = {
      attempts: pick(isInt(attempts, 0), attempts as number, 0),
      lastOutcome: pick(outcome === null || OUTCOMES.includes(outcome as never), outcome as StoredSend['lastOutcome'], null),
      maybeSent: pick(typeof maybeSent === 'boolean', maybeSent as boolean, false),
      lastMessage: pick(message === null || typeof message === 'string', typeof message === 'string' ? truncate(message, ARTIFACT_COMMENTS_CAPS.maxMessageUnits) : null, null),
      lastBatchRequestId: pick(batch === null || batch === undefined || isRequestId(batch), isRequestId(batch) ? batch : null, null),
    };
    if (touched) clamped.push('send');
  } else {
    clamped.push('send');
  }

  return {
    ok: true,
    clamped,
    comment: { id, selectionId, ordinal, version, kind, status, text, createdAt, updatedAt, sentAt, artifactRevision, viewSessionId, anchor, label, hasScreenshot, redacted, send, sig },
  };
}

// ---------------------------------------------------------------------------------------------
// File-level normalization
// ---------------------------------------------------------------------------------------------

export interface NormalizeReport {
  readonly dropped: number;
  readonly clamped: number;
  readonly duplicates: number;
  readonly overCap: number;
  readonly reassigned: readonly string[];
  readonly tombstonesDropped: number;
  /** The stored hash does not match the body as read: a hand edit, or a writer that did not recompute it. Not an error by itself. */
  readonly shaMismatch: boolean;
  /** Something was dropped or changed on load, so the original bytes must be quarantined before any overwrite. */
  readonly needsQuarantine: boolean;
}

export type NormalizeResult =
  | { readonly ok: true; readonly file: CommentsFile; readonly report: NormalizeReport }
  | { readonly ok: false; readonly reason: string };

const byOrdinal = (a: StoredComment, b: StoredComment): number =>
  (a.ordinal === 0 ? Infinity : a.ordinal) - (b.ordinal === 0 ? Infinity : b.ordinal) || (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const byCreation = (a: StoredComment, b: StoredComment): number => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Makes ordinals unique and `nextOrdinal` larger than every ordinal. The earliest-created holder of an
 * ordinal keeps it; later ones (and ordinal 0) take the next free numbers in creation order. A moved
 * comment gets version + 1 so the change wins future merges.
 */
function resolveOrdinals(comments: readonly StoredComment[], nextOrdinal: number): { comments: StoredComment[]; nextOrdinal: number; reassigned: string[] } {
  let next = Math.max(1, nextOrdinal, ...comments.map((c) => c.ordinal + 1));
  const taken = new Set<number>();
  const moved = new Map<string, number>();
  for (const comment of [...comments].sort(byCreation)) {
    if (comment.ordinal >= 1 && !taken.has(comment.ordinal)) {
      taken.add(comment.ordinal);
    } else {
      moved.set(comment.id, next);
      next += 1;
    }
  }
  const out = comments.map((c) => (moved.has(c.id) ? { ...c, ordinal: moved.get(c.id)!, version: c.version + 1 } : c));
  out.sort(byOrdinal);
  return { comments: out, nextOrdinal: next, reassigned: [...moved.keys()] };
}

function sanitizeTombstones(raw: unknown, nowMs: number): { tombstones: Tombstone[]; dropped: number } {
  const newest = new Map<string, string>();
  let dropped = 0;
  const list = Array.isArray(raw) ? raw : [];
  for (const entry of list) {
    if (!isObject(entry)) { dropped += 1; continue; }
    const id = own(entry, 'id');
    const at = own(entry, 'at');
    if (!isCommentId(id) || !isIso(at)) { dropped += 1; continue; }
    if (nowMs - Date.parse(at) > TOMBSTONE_TTL_MS) { dropped += 1; continue; }
    const current = newest.get(id);
    if (current === undefined || at > current) newest.set(id, at);
  }
  return { tombstones: capTombstones([...newest].map(([id, at]) => ({ id, at }))), dropped };
}

function capTombstones(list: Tombstone[]): Tombstone[] {
  return list.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? -1 : 1)).slice(0, MAX_TOMBSTONES);
}

/** Picks the winner between two copies of the same comment: higher version, then newer updatedAt, then the greater content hash. */
function newer(a: StoredComment, b: StoredComment): StoredComment {
  if (a.version !== b.version) return a.version > b.version ? a : b;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  return commentHash(a) >= commentHash(b) ? a : b;
}

export function normalizeCommentsFile(raw: unknown, nowMs: number): NormalizeResult {
  if (!isObject(raw)) return { ok: false, reason: 'The file is not a JSON object.' };
  if (own(raw, 'kind') !== COMMENTS_FILE_KIND) return { ok: false, reason: 'The file is not a Design comments file.' };
  const schemaVersion = own(raw, 'schemaVersion');
  if (!isInt(schemaVersion, 1)) return { ok: false, reason: 'The file has no valid schemaVersion.' };
  const artifactId = own(raw, 'artifactId');
  if (!isString(artifactId, MAX_ARTIFACT_ID)) return { ok: false, reason: 'The file has no artifact id.' };
  const storeId = own(raw, 'storeId');
  if (typeof storeId !== 'string' || !STORE_ID.test(storeId)) return { ok: false, reason: 'The file has no valid store id.' };
  const rawComments = own(raw, 'comments');
  if (!Array.isArray(rawComments)) return { ok: false, reason: 'The file has no comments list.' };
  const revRaw = own(raw, 'rev');
  const nextRaw = own(raw, 'nextOrdinal');
  const rawTombstones = own(raw, 'tombstones');
  const writtenBy = own(raw, 'writtenBy');
  const writtenAt = own(raw, 'writtenAt');
  const claimedSha = own(raw, 'bodySha256');

  // A hostile, deeply nested body can overflow the recursive canonicalizer: that is a mismatch, not a crash.
  let shaMismatch = true;
  try {
    shaMismatch = typeof claimedSha !== 'string' || claimedSha !== sha256(canonicalJson({ comments: rawComments, tombstones: rawTombstones ?? [], nextOrdinal: nextRaw }));
  } catch {
    shaMismatch = true;
  }

  let dropped = 0;
  let clampedCount = 0;
  const valid: StoredComment[] = [];
  for (const item of rawComments) {
    const result = validateStoredComment(item);
    if (!result.ok) { dropped += 1; continue; }
    if (result.clamped.length > 0) clampedCount += 1;
    valid.push(result.comment);
  }

  const winners = new Map<string, StoredComment>();
  let duplicates = 0;
  for (const comment of valid) {
    const existing = winners.get(comment.id);
    if (existing === undefined) { winners.set(comment.id, comment); continue; }
    duplicates += 1;
    winners.set(comment.id, newer(existing, comment));
  }

  const { tombstones, dropped: tombstonesDropped } = sanitizeTombstones(rawTombstones ?? [], nowMs);
  const buried = new Map(tombstones.map((t) => [t.id, t.at]));
  let live = [...winners.values()].filter((c) => {
    const at = buried.get(c.id);
    return at === undefined || c.updatedAt > at;
  });

  live.sort(byOrdinal);
  const overCap = Math.max(0, live.length - MAX_COMMENTS);
  live = live.slice(0, MAX_COMMENTS);

  const resolved = resolveOrdinals(live, isInt(nextRaw, 1, MAX_COUNTER) ? nextRaw : 1);
  const body: CommentsBody = { comments: resolved.comments, tombstones, nextOrdinal: resolved.nextOrdinal };
  const file: CommentsFile = {
    schemaVersion,
    kind: COMMENTS_FILE_KIND,
    artifactId,
    storeId,
    rev: isInt(revRaw, 0) ? revRaw : 0,
    writtenBy: isString(writtenBy, 64) ? writtenBy : '',
    writtenAt: isIso(writtenAt) ? writtenAt : '',
    bodySha256: bodySha256(body),
    ...body,
  };
  const needsQuarantine = dropped > 0 || clampedCount > 0 || duplicates > 0 || overCap > 0 || resolved.reassigned.length > 0;
  return { ok: true, file, report: { dropped, clamped: clampedCount, duplicates, overCap, reassigned: resolved.reassigned, tombstonesDropped, shaMismatch, needsQuarantine } };
}

// ---------------------------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------------------------

export type Migration = (raw: Record<string, unknown>) => Record<string, unknown>;
/** `MIGRATIONS[n]` upgrades schema n to n + 1. Empty while the current version is 1. */
export const MIGRATIONS: Readonly<Record<number, Migration>> = {};

export type MigrationResult =
  | { readonly status: 'ok'; readonly value: unknown; readonly migratedFrom: number | null }
  | { readonly status: 'newer'; readonly version: number }
  | { readonly status: 'invalid'; readonly reason: string };

export function migrate(raw: unknown, migrations: Readonly<Record<number, Migration>> = MIGRATIONS, current: number = COMMENTS_SCHEMA_VERSION): MigrationResult {
  if (!isObject(raw)) return { status: 'invalid', reason: 'The file is not a JSON object.' };
  const version = own(raw, 'schemaVersion');
  if (!isInt(version, 1)) return { status: 'invalid', reason: 'The file has no valid schemaVersion.' };
  if (version > current) return { status: 'newer', version };
  if (version === current) return { status: 'ok', value: raw, migratedFrom: null };
  let value: Record<string, unknown> = raw;
  for (let step = version; step < current; step += 1) {
    const fn = Object.prototype.hasOwnProperty.call(migrations, step) ? migrations[step] : undefined;
    if (typeof fn !== 'function') return { status: 'invalid', reason: `No migration from schema ${step}.` };
    try {
      value = fn(value);
    } catch {
      return { status: 'invalid', reason: `Migration from schema ${step} failed.` };
    }
    if (!isObject(value) || own(value, 'schemaVersion') !== step + 1) return { status: 'invalid', reason: `Migration from schema ${step} did not advance the version.` };
  }
  return { status: 'ok', value, migratedFrom: version };
}

// ---------------------------------------------------------------------------------------------
// Merge (two writers, sync copies)
// ---------------------------------------------------------------------------------------------

export interface MergedBody extends CommentsBody {
  readonly reassigned: readonly string[];
}

/**
 * Pure, commutative and idempotent merge of two bodies. Per id the higher version wins (then newer
 * updatedAt, then the greater content hash). A tombstone beats any copy that is not newer than it;
 * a later edit survives and clears the tombstone. Ordinal collisions are resolved deterministically.
 */
export function mergeBodies(a: CommentsBody, b: CommentsBody, nowMs: number): MergedBody {
  const winners = new Map<string, StoredComment>();
  for (const comment of [...a.comments, ...b.comments]) {
    const existing = winners.get(comment.id);
    winners.set(comment.id, existing === undefined ? comment : newer(existing, comment));
  }
  const newest = new Map<string, string>();
  for (const t of [...a.tombstones, ...b.tombstones]) {
    const current = newest.get(t.id);
    if (current === undefined || t.at > current) newest.set(t.id, t.at);
  }
  const live: StoredComment[] = [];
  for (const comment of winners.values()) {
    const at = newest.get(comment.id);
    if (at !== undefined && comment.updatedAt <= at) continue;
    if (at !== undefined) newest.delete(comment.id);
    live.push(comment);
  }
  const tombstones = capTombstones([...newest].filter(([, at]) => nowMs - Date.parse(at) <= TOMBSTONE_TTL_MS).map(([id, at]) => ({ id, at })));
  const resolved = resolveOrdinals(live, Math.max(a.nextOrdinal, b.nextOrdinal));
  return { comments: resolved.comments, tombstones, nextOrdinal: resolved.nextOrdinal, reassigned: resolved.reassigned };
}

// ---------------------------------------------------------------------------------------------
// Salvage (corrupt files)
// ---------------------------------------------------------------------------------------------

const SALVAGE_MAX_OBJECT = 32 * 1024;
const SALVAGE_MAX_DEPTH = 64;
const SALVAGE_MAX_ATTEMPTS = 5000;

/**
 * Best-effort recovery of complete, valid comment objects from text that is not valid JSON (truncated,
 * merge-conflict markers, garbage around it). Single string-aware pass with a depth stack; bounded in
 * work so a hostile file cannot stall it.
 */
export function salvageComments(text: string): StoredComment[] {
  const found = new Map<string, StoredComment>();
  const starts: number[] = [];
  let inString = false;
  let escaped = false;
  let attempts = 0;
  for (let i = 0; i < text.length && found.size < MAX_COMMENTS && attempts < SALVAGE_MAX_ATTEMPTS; i += 1) {
    const ch = text.charCodeAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === 0x5c) escaped = true;
      else if (ch === 0x22) inString = false;
      continue;
    }
    if (ch === 0x22) inString = true;
    else if (ch === 0x7b) {
      if (starts.length < SALVAGE_MAX_DEPTH) starts.push(i);
      else starts.push(-1);
    } else if (ch === 0x7d && starts.length > 0) {
      const start = starts.pop()!;
      if (start < 0 || i + 1 - start > SALVAGE_MAX_OBJECT) continue;
      attempts += 1; // every slice examined counts, so the scan cost is bounded too
      const slice = text.slice(start, i + 1);
      if (!slice.includes('"selectionId"')) continue;
      try {
        const result = validateStoredComment(JSON.parse(slice));
        if (result.ok) {
          const existing = found.get(result.comment.id);
          found.set(result.comment.id, existing === undefined ? result.comment : newer(existing, result.comment));
        }
      } catch {
        // not an object we can use; keep scanning
      }
    }
  }
  return [...found.values()];
}

// ---------------------------------------------------------------------------------------------
// Projection to the public contract type
// ---------------------------------------------------------------------------------------------

/** Builds a fresh, data-only ArtifactComment (no signature, no private send fields, nothing shared with the store). */
export function toPublicComment(comment: StoredComment, provenance: ArtifactCommentProvenance): ArtifactComment {
  return {
    id: comment.id,
    selectionId: comment.selectionId,
    ordinal: comment.ordinal,
    version: comment.version,
    kind: comment.kind,
    status: comment.status,
    provenance,
    text: comment.text,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    sentAt: comment.sentAt,
    artifactRevision: comment.artifactRevision,
    viewSessionId: comment.viewSessionId,
    anchor: {
      route: comment.anchor.route,
      tag: comment.anchor.tag,
      selector: comment.anchor.selector,
      selectorAlternates: [...comment.anchor.selectorAlternates],
      textAnchor: { tag: comment.anchor.textAnchor.tag, text: comment.anchor.textAnchor.text },
      landmark: comment.anchor.landmark,
      lastRect: comment.anchor.lastRect === null ? null : { ...comment.anchor.lastRect },
    },
    label: comment.label,
    hasScreenshot: comment.hasScreenshot,
    redacted: comment.redacted,
    send: {
      attempts: comment.send.attempts,
      lastOutcome: comment.send.lastOutcome,
      maybeSent: comment.send.maybeSent,
      lastMessage: comment.send.lastMessage,
    },
  };
}
