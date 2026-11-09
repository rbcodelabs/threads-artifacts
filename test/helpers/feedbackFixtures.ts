import type { ArtifactFeedbackRequest } from '../../src/geodeArtifactFeedback';

export const SELECTION_ID = 'sel_0123456789abcdef0123456789abcdef';
export const OTHER_SELECTION_ID = 'sel_fedcba9876543210fedcba9876543210';
export const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

/** A fresh, deeply independent valid request (tests mutate it freely). */
export function validRequest(overrides: Record<string, unknown> = {}): ArtifactFeedbackRequest {
  const base = {
    contractVersion: 1,
    artifact: { root: '/vault/.geode/artifacts/design-t1', artifactId: 'design-t1', title: 'Landing', runtime: 'static', vaultRead: false },
    comment: 'Make this heading larger.',
    selection: {
      schemaVersion: 1,
      selectionId: SELECTION_ID,
      artifactId: 'design-t1',
      artifactRevision: 7,
      viewSessionId: 'view-1',
      viewportPreset: 'desktop',
      capturedAt: '2026-11-08T20:00:00.000Z',
      redacted: false,
      route: '/index.html',
      tag: 'h1',
      selector: '#hero-title',
      selectorAlternates: ['main > h1', 'h1.title.big'],
      textAnchor: { tag: 'h1', text: 'Build faster' },
      landmark: 'Hero',
      outerHTML: { html: '<h1 id="hero-title" class="title big">Build faster</h1>', truncated: false },
      ancestors: [{ tag: 'main', id: null, classes: ['shell'] }],
      computedStyles: { display: 'block', color: 'rgb(0, 0, 0)', 'font-size': '32px' },
      boundingBox: {
        viewport: { x: 10, y: 20, width: 300, height: 40 },
        document: { x: 10, y: 120, width: 300, height: 40 },
      },
      viewport: { width: 1440, height: 900, devicePixelRatio: 2, scrollX: 0, scrollY: 100 },
      a11y: { role: 'heading', name: 'Build faster', tabIndex: null },
    },
    screenshot: { mimeType: 'image/png', bytes: PNG_BYTES.slice(), width: 600, height: 80, cssRect: { x: 2, y: 12, width: 316, height: 56 }, devicePixelRatio: 2, downscaled: false },
    screenshotOmitted: null,
    stale: false,
    submittedAt: '2026-11-08T20:00:05.000Z',
  };
  return { ...base, ...overrides } as unknown as ArtifactFeedbackRequest;
}

/** Mutates a nested path of a fresh valid request, e.g. mutate('selection.tag', 'H1!'). */
export function mutated(path: string, value: unknown): ArtifactFeedbackRequest {
  const request = validRequest() as unknown as Record<string, unknown>;
  const keys = path.split('.');
  let node = request;
  for (const key of keys.slice(0, -1)) node = node[key] as Record<string, unknown>;
  node[keys[keys.length - 1]] = value;
  return request as unknown as ArtifactFeedbackRequest;
}
