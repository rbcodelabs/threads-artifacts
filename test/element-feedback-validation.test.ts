import { describe, expect, it } from 'vitest';
import { validateFeedbackRequest } from '../src/elementFeedbackValidation';
import { mutated, validRequest } from './helpers/feedbackFixtures';

const invalid = (raw: unknown) => {
  const result = validateFeedbackRequest(raw);
  expect(result.ok).toBe(false);
  return result.ok ? '' : result.message;
};

describe('validateFeedbackRequest', () => {
  it('accepts a valid request and returns a fresh object', () => {
    const raw = validRequest();
    const result = validateFeedbackRequest(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toBe(raw);
    expect(result.value.selection).not.toBe(raw.selection);
    expect(result.value.selection.selectionId).toBe(raw.selection.selectionId);
    expect(result.value.screenshot?.bytes).toBeInstanceOf(Uint8Array);
  });

  it('ignores and strips unknown keys at every level', () => {
    const raw = validRequest() as any;
    raw.extra = 'x';
    raw.selection.extra = { deep: 1 };
    raw.selection.textAnchor.extra = 1;
    raw.artifact.extra = 1;
    const result = validateFeedbackRequest(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.stringify(result.value)).not.toContain('extra');
  });

  it('rejects non-objects, wrong contract version', () => {
    invalid(null);
    invalid('x');
    invalid(mutated('contractVersion', 2));
  });

  it('rejects bad selection ids before any path use', () => {
    for (const id of ['sel_xyz', '../evil', 'sel_0123456789abcdef0123456789abcdeF', 'sel_0123456789abcdef0123456789abcdef0', '']) {
      invalid(mutated('selection.selectionId', id));
    }
  });

  it('enforces comment bounds and trims', () => {
    invalid(mutated('comment', ''));
    invalid(mutated('comment', '   '));
    invalid(mutated('comment', 'x'.repeat(4001)));
    invalid(mutated('comment', 5));
    const ok = validateFeedbackRequest(mutated('comment', '  hi  '));
    expect(ok.ok && ok.value.comment).toBe('hi');
  });

  it('rejects oversized and mistyped origin-G fields', () => {
    invalid(mutated('selection.route', 'x'.repeat(513)));
    invalid(mutated('selection.tag', 'H1'));
    invalid(mutated('selection.tag', 'a'.repeat(33)));
    invalid(mutated('selection.selector', 'x'.repeat(513)));
    invalid(mutated('selection.selectorAlternates', ['a', 'b', 'c', 'd']));
    invalid(mutated('selection.selectorAlternates', ['x'.repeat(513)]));
    invalid(mutated('selection.selectorAlternates', 'nope'));
    invalid(mutated('selection.textAnchor.text', 'x'.repeat(81)));
    invalid(mutated('selection.landmark', 'x'.repeat(121)));
    invalid(mutated('selection.landmark', 5));
    invalid(mutated('selection.outerHTML.html', 'x'.repeat(4097)));
    invalid(mutated('selection.outerHTML.truncated', 'no'));
    invalid(mutated('selection.ancestors', new Array(4).fill({ tag: 'div', id: null, classes: [] })));
    invalid(mutated('selection.ancestors', [{ tag: 'div', id: 'x'.repeat(129), classes: [] }]));
    invalid(mutated('selection.ancestors', [{ tag: 'div', id: null, classes: new Array(9).fill('c') }]));
    invalid(mutated('selection.a11y.tabIndex', 1.5));
    invalid(mutated('selection.a11y.tabIndex', 40000));
    invalid(mutated('selection.a11y.name', 'x'.repeat(201)));
    invalid(mutated('selection.viewportPreset', 'huge'));
    invalid(mutated('selection.capturedAt', 'yesterday'));
    invalid(mutated('selection.redacted', 'false'));
  });

  it('rejects non-finite or huge numbers', () => {
    invalid(mutated('selection.boundingBox.viewport.x', Number.NaN));
    invalid(mutated('selection.boundingBox.document.width', 1e7));
    invalid(mutated('selection.viewport.devicePixelRatio', Infinity));
    invalid(mutated('selection.artifactRevision', -1));
    invalid(mutated('selection.artifactRevision', 1.5));
  });

  it('validates computed styles against the 40-key allowlist', () => {
    invalid(mutated('selection.computedStyles', { 'behavior': 'url(x)' }));
    invalid(mutated('selection.computedStyles', { display: 'x'.repeat(201) }));
    invalid(mutated('selection.computedStyles', { display: 3 }));
    expect(validateFeedbackRequest(mutated('selection.computedStyles', {})).ok).toBe(true);
  });

  it('rejects prototype-pollution keys anywhere, including JSON.parse own __proto__', () => {
    const parsed = JSON.parse(JSON.stringify(validRequest()).replace('"landmark":"Hero"', '"landmark":"Hero","__proto__":{"polluted":true}'));
    expect(invalid(parsed)).toMatch(/not allowed/i);
    const ctor = validRequest() as any;
    ctor.selection.computedStyles = { constructor: 'x' };
    invalid(ctor);
    const proto = validRequest() as any;
    proto.selection.ancestors = [{ tag: 'div', id: null, classes: [], prototype: 1 }];
    invalid(proto);
    expect(({} as any).polluted).toBeUndefined();
  });

  it('validates the artifact target', () => {
    invalid(mutated('artifact.runtime', 'nextjs'));
    invalid(mutated('artifact.root', ''));
    invalid(mutated('artifact.vaultRead', 'yes'));
    invalid(mutated('artifact.artifactId', ''));
  });

  it('requires selection.artifactId to match artifact.artifactId', () => {
    invalid(mutated('selection.artifactId', 'design-other'));
  });

  it('validates the screenshot: bytes type, size, PNG signature, consistency', () => {
    invalid(mutated('screenshot.bytes', [1, 2, 3]));
    invalid(mutated('screenshot.bytes', new Uint8Array(0)));
    invalid(mutated('screenshot.bytes', new Uint8Array(524289).fill(0x89)));
    invalid(mutated('screenshot.bytes', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])));
    invalid(mutated('screenshot.mimeType', 'image/jpeg'));
    invalid(mutated('screenshot.width', 0));
    invalid(mutated('screenshot.width', 20000));
    invalid(mutated('screenshotOmitted', 'vault-read')); // non-null with a screenshot present
    const noShot = validRequest({ screenshot: null, screenshotOmitted: null });
    invalid(noShot); // null screenshot requires a reason
    const ok = validateFeedbackRequest(validRequest({ screenshot: null, screenshotOmitted: 'too-large' }));
    expect(ok.ok).toBe(true);
    invalid(validRequest({ screenshot: null, screenshotOmitted: 'bogus' }));
  });

  it('copies screenshot bytes rather than aliasing the embedder buffer', () => {
    const raw = validRequest();
    const result = validateFeedbackRequest(raw);
    expect(result.ok && result.value.screenshot!.bytes).not.toBe(raw.screenshot!.bytes);
  });

  it('forces redaction invariants when redacted is true', () => {
    const raw = validRequest() as any;
    raw.selection.redacted = true;
    const result = validateFeedbackRequest(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.selection.textAnchor.text).toBe('');
    expect(result.value.selection.a11y.name).toBeNull();
  });

  it('validates stale and submittedAt', () => {
    invalid(mutated('stale', 'no'));
    invalid(mutated('submittedAt', 'whenever'));
  });
});
