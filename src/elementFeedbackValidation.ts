import type {
  ArtifactFeedbackRequest,
  ElementScreenshot,
  ElementSelection,
  Rect,
  ScreenshotOmittedReason,
} from './geodeArtifactFeedback';

/**
 * Independent re-validation of an element-comment request. The embedder already validates, but
 * this module never trusts it (a future second embedder or a test may feed it): it rebuilds a new
 * object from allowlisted keys, so unknown keys are dropped and nothing is aliased.
 */

export const SELECTION_ID_PATTERN = /^sel_[0-9a-f]{32}$/;
export const MAX_COMMENT_LENGTH = 4000;
export const MAX_SCREENSHOT_BYTES = 524_288;
const TAG_PATTERN = /^[a-z][a-z0-9:-]{0,31}$/;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const FORBIDDEN_KEYS = ['__proto__', 'constructor', 'prototype'];
const MAX_NUMBER_MAGNITUDE = 1e6;
const MAX_SCAN_NODES = 2000;
const MAX_ARRAY_LENGTH = 64;
const MAX_OBJECT_KEYS = 256;
const MAX_SCAN_DEPTH = 8;
const PRESETS = ['desktop', 'tablet', 'mobile', 'custom', 'fill'] as const;
const OMITTED_REASONS: readonly ScreenshotOmittedReason[] = ['vault-read', 'too-large', 'capture-failed', 'empty-rect'];
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export const COMPUTED_STYLE_ALLOWLIST: readonly string[] = [
  'display', 'position', 'z-index', 'opacity', 'overflow', 'visibility', 'flex-direction', 'flex-wrap',
  'justify-content', 'align-items', 'gap', 'grid-template-columns', 'width', 'height', 'margin-top',
  'margin-right', 'margin-bottom', 'margin-left', 'padding-top', 'padding-right', 'padding-bottom',
  'padding-left', 'box-sizing', 'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing',
  'text-align', 'text-transform', 'text-decoration-line', 'color', 'background-color', 'background-image',
  'border-top-width', 'border-top-style', 'border-top-color', 'border-radius', 'box-shadow', 'transform',
];

export type ValidationResult =
  | { readonly ok: true; readonly value: ArtifactFeedbackRequest }
  | { readonly ok: false; readonly message: string };

class Invalid extends Error {}
const fail = (message: string): never => { throw new Invalid(message); };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function record(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) fail(`${name} must be an object.`);
  return value as Record<string, unknown>;
}

function string(value: unknown, name: string, max: number, min = 0): string {
  if (typeof value !== 'string') fail(`${name} must be a string.`);
  const text = value as string;
  if (text.length > max) fail(`${name} is too long.`);
  if (text.length < min) fail(`${name} is too short.`);
  return text;
}

function nullableString(value: unknown, name: string, max: number): string | null {
  return value === null ? null : string(value, name, max);
}

function bool(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') fail(`${name} must be a boolean.`);
  return value as boolean;
}

function num(value: unknown, name: string, { min = -MAX_NUMBER_MAGNITUDE, max = MAX_NUMBER_MAGNITUDE, integer = false } = {}): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    fail(`${name} is not a valid number.`);
  }
  return value as number;
}

function tag(value: unknown, name: string): string {
  const text = string(value, name, 32, 1);
  if (!TAG_PATTERN.test(text)) fail(`${name} is not a valid tag name.`);
  return text;
}

function iso(value: unknown, name: string): string {
  const text = string(value, name, 40, 1);
  if (!ISO_PATTERN.test(text) || Number.isNaN(Date.parse(text))) fail(`${name} must be an ISO 8601 timestamp.`);
  return text;
}

function rect(value: unknown, name: string): Rect {
  const r = record(value, name);
  return { x: num(r.x, `${name}.x`), y: num(r.y, `${name}.y`), width: num(r.width, `${name}.width`, { min: 0 }), height: num(r.height, `${name}.height`, { min: 0 }) };
}

/**
 * Bounded scan for forbidden keys. Everything is checked BEFORE it is queued or iterated: arrays over
 * MAX_ARRAY_LENGTH (a sparse array can claim 4e9 slots), objects over MAX_OBJECT_KEYS, depth, and the
 * total node budget. Byte arrays and other views are not traversed.
 */
function assertNoForbiddenKeys(root: unknown): void {
  const stack: { value: unknown; depth: number }[] = [{ value: root, depth: 0 }];
  let queued = 1;
  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    if (typeof value !== 'object' || value === null || ArrayBuffer.isView(value)) continue;
    if (depth > MAX_SCAN_DEPTH) fail('Request is too deeply nested.');
    if (Array.isArray(value) && value.length > MAX_ARRAY_LENGTH) fail('Request contains an array that is too long.');
    const keys = Object.getOwnPropertyNames(value);
    if (keys.length > MAX_OBJECT_KEYS) fail('Request contains an object with too many keys.');
    for (const key of keys) {
      if (FORBIDDEN_KEYS.includes(key)) fail(`Key "${key}" is not allowed.`);
    }
    const children = Array.isArray(value) ? value : keys.map(key => (value as Record<string, unknown>)[key]);
    for (const child of children) {
      if (typeof child !== 'object' || child === null) continue;
      if (++queued > MAX_SCAN_NODES) fail('Request is too large.');
      stack.push({ value: child, depth: depth + 1 });
    }
  }
}

const REDACTION_KEEP_ATTRIBUTES = new Set(['id', 'class', 'role', 'type', 'data-variation', 'data-testid']);
const ATTRIBUTE_PATTERN = /([^\s"'<>\/=]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g;

function redactTag(tagText: string): string {
  const closing = /^<\/\s*([a-zA-Z][\w:-]*)/.exec(tagText);
  if (closing) return `</${closing[1]}>`;
  const opening = /^<([a-zA-Z][\w:-]*)/.exec(tagText);
  if (!opening) return '';
  const selfClosing = /\/\s*>$/.test(tagText);
  const rest = tagText.slice(opening[0].length).replace(/\/?\s*>$/, '');
  const attributes: string[] = [];
  for (const match of rest.matchAll(ATTRIBUTE_PATTERN)) {
    const name = match[1];
    if (match[2] === undefined) { attributes.push(name); continue; }
    const value = match[2].replace(/^["']|["']$/g, '').replace(/"/g, '&quot;');
    attributes.push(`${name}="${REDACTION_KEEP_ATTRIBUTES.has(name.toLowerCase()) ? value : '...'}"`);
  }
  return `<${opening[1]}${attributes.length ? ` ${attributes.join(' ')}` : ''}${selfClosing ? '/' : ''}>`;
}

/**
 * Defense in depth for vault-read artifacts (ADR 0006 redaction): one linear pass that drops text
 * nodes and comments and elides attribute values except an allowlist. Geode already does this.
 */
export function redactOuterHtml(html: string): string {
  let out = '';
  let index = 0;
  while (index < html.length) {
    const open = html.indexOf('<', index);
    if (open < 0) break;
    if (html.startsWith('<!--', open)) {
      const end = html.indexOf('-->', open + 4);
      if (end < 0) break;
      index = end + 3;
      continue;
    }
    let close = open + 1;
    let quote = '';
    for (; close < html.length; close++) {
      const char = html[close];
      if (quote) { if (char === quote) quote = ''; } else if (char === '"' || char === "'") quote = char; else if (char === '>') break;
    }
    out += redactTag(html.slice(open, close + 1));
    index = close + 1;
  }
  return out.slice(0, 4096);
}

function computedStyles(value: unknown): Record<string, string> {
  const raw = record(value, 'computedStyles');
  const out: Record<string, string> = {};
  for (const key of Object.getOwnPropertyNames(raw)) {
    if (!COMPUTED_STYLE_ALLOWLIST.includes(key)) fail('computedStyles has an unsupported key.');
    out[key] = string(raw[key], `computedStyles.${key}`, 200);
  }
  return out;
}

function ancestors(value: unknown): ElementSelection['ancestors'] {
  if (!Array.isArray(value) || value.length > 3) fail('ancestors must be an array of at most 3.');
  return (value as unknown[]).map((entry, index) => {
    const a = record(entry, `ancestors[${index}]`);
    if (!Array.isArray(a.classes) || a.classes.length > 8) fail('ancestor classes must be an array of at most 8.');
    return {
      tag: tag(a.tag, 'ancestor tag'),
      id: nullableString(a.id, 'ancestor id', 128),
      classes: (a.classes as unknown[]).map(c => string(c, 'ancestor class', 64)),
    };
  });
}

function selection(value: unknown, artifactId: string): ElementSelection {
  const s = record(value, 'selection');
  if (s.schemaVersion !== 1) fail('Unsupported selection schema version.');
  const selectionId = string(s.selectionId, 'selectionId', 64);
  if (!SELECTION_ID_PATTERN.test(selectionId)) fail('selectionId is malformed.');
  if (s.artifactId !== artifactId) fail('Selection does not belong to this artifact.');
  const preset = s.viewportPreset;
  if (!PRESETS.includes(preset as typeof PRESETS[number])) fail('Unsupported viewport preset.');
  if (!Array.isArray(s.selectorAlternates) || s.selectorAlternates.length > 3) fail('selectorAlternates must have at most 3 entries.');
  const redacted = bool(s.redacted, 'redacted');
  const anchor = record(s.textAnchor, 'textAnchor');
  const outer = record(s.outerHTML, 'outerHTML');
  const box = record(s.boundingBox, 'boundingBox');
  const view = record(s.viewport, 'viewport');
  const a11y = record(s.a11y, 'a11y');
  const tabIndex = a11y.tabIndex === null ? null : num(a11y.tabIndex, 'tabIndex', { min: -1, max: 32767, integer: true });
  return {
    schemaVersion: 1,
    selectionId,
    artifactId,
    artifactRevision: num(s.artifactRevision, 'artifactRevision', { min: 0, integer: true }),
    viewSessionId: string(s.viewSessionId, 'viewSessionId', 128, 1),
    viewportPreset: preset as ElementSelection['viewportPreset'],
    capturedAt: iso(s.capturedAt, 'capturedAt'),
    redacted,
    route: string(s.route, 'route', 512),
    tag: tag(s.tag, 'tag'),
    selector: string(s.selector, 'selector', 512),
    selectorAlternates: (s.selectorAlternates as unknown[]).map(a => string(a, 'selector alternate', 512)),
    // Redaction invariants are enforced here too: a redacted selection never carries text or a name.
    textAnchor: { tag: tag(anchor.tag, 'textAnchor.tag'), text: redacted ? '' : string(anchor.text, 'textAnchor.text', 80) },
    // Heading text can carry vault data and ADR 0006 does not list it as redacted, so a redacted selection drops it.
    landmark: redacted ? (nullableString(s.landmark, 'landmark', 120), null) : nullableString(s.landmark, 'landmark', 120),
    outerHTML: { html: redacted ? redactOuterHtml(string(outer.html, 'outerHTML.html', 4096)) : string(outer.html, 'outerHTML.html', 4096), truncated: bool(outer.truncated, 'outerHTML.truncated') },
    ancestors: ancestors(s.ancestors),
    computedStyles: computedStyles(s.computedStyles),
    boundingBox: { viewport: rect(box.viewport, 'boundingBox.viewport'), document: rect(box.document, 'boundingBox.document') },
    viewport: {
      width: num(view.width, 'viewport.width', { min: 0 }),
      height: num(view.height, 'viewport.height', { min: 0 }),
      devicePixelRatio: num(view.devicePixelRatio, 'devicePixelRatio', { min: 0, max: 16 }),
      scrollX: num(view.scrollX, 'scrollX'),
      scrollY: num(view.scrollY, 'scrollY'),
    },
    a11y: {
      role: nullableString(a11y.role, 'a11y.role', 64),
      name: redacted ? null : nullableString(a11y.name, 'a11y.name', 200),
      tabIndex,
    },
  };
}

function screenshot(value: unknown): ElementScreenshot {
  const s = record(value, 'screenshot');
  if (s.mimeType !== 'image/png') fail('Screenshot must be a PNG.');
  if (!(s.bytes instanceof Uint8Array)) fail('Screenshot bytes must be a Uint8Array.');
  const bytes = s.bytes as Uint8Array;
  if (bytes.length < PNG_SIGNATURE.length || bytes.length > MAX_SCREENSHOT_BYTES) fail('Screenshot size is out of range.');
  if (!PNG_SIGNATURE.every((byte, i) => bytes[i] === byte)) fail('Screenshot is not a PNG.');
  return {
    mimeType: 'image/png',
    bytes: bytes.slice(),
    width: num(s.width, 'screenshot.width', { min: 1, max: 16384, integer: true }),
    height: num(s.height, 'screenshot.height', { min: 1, max: 16384, integer: true }),
    cssRect: rect(s.cssRect, 'screenshot.cssRect'),
    devicePixelRatio: num(s.devicePixelRatio, 'screenshot.devicePixelRatio', { min: 0, max: 16 }),
    downscaled: bool(s.downscaled, 'screenshot.downscaled'),
  };
}

function build(raw: unknown): ArtifactFeedbackRequest {
  const r = record(raw, 'request');
  assertNoForbiddenKeys(r);
  if (r.contractVersion !== 1) fail('Unsupported contract version.');
  const a = record(r.artifact, 'artifact');
  if (a.runtime !== 'static') fail('Only static artifacts are supported.');
  const artifactId = string(a.artifactId, 'artifactId', 256, 1);
  const comment = string(r.comment, 'comment', 100_000).trim();
  if (comment.length < 1 || comment.length > MAX_COMMENT_LENGTH) fail('Comment must be 1 to 4000 characters.');
  const sel = selection(r.selection, artifactId);
  const shot = r.screenshot === null ? null : screenshot(r.screenshot);
  let omitted: ScreenshotOmittedReason | null = null;
  if (shot === null) {
    if (!OMITTED_REASONS.includes(r.screenshotOmitted as ScreenshotOmittedReason)) fail('A missing screenshot needs a reason.');
    omitted = r.screenshotOmitted as ScreenshotOmittedReason;
  } else if (r.screenshotOmitted !== null) {
    fail('screenshotOmitted must be null when a screenshot is present.');
  }
  return {
    contractVersion: 1,
    artifact: {
      root: string(a.root, 'artifact root', 4096, 1),
      artifactId,
      title: string(a.title, 'artifact title', 500),
      runtime: 'static',
      vaultRead: bool(a.vaultRead, 'vaultRead'),
    },
    comment,
    selection: sel,
    screenshot: shot,
    screenshotOmitted: omitted,
    stale: bool(r.stale, 'stale'),
    submittedAt: iso(r.submittedAt, 'submittedAt'),
  };
}

export function validateFeedbackRequest(raw: unknown): ValidationResult {
  try {
    return { ok: true, value: build(raw) };
  } catch (error) {
    if (error instanceof Invalid) return { ok: false, message: error.message };
    return { ok: false, message: 'The comment could not be read.' };
  }
}
