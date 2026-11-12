import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_COMMENT_ID_PATTERN,
  ARTIFACT_COMMENTS_CAPS,
  ARTIFACT_COMMENTS_REQUEST_ID_PATTERN,
  ARTIFACT_FEEDBACK_SUPPORTED_VERSIONS,
} from '../src/geodeArtifactFeedbackV2';

/**
 * sha256 of the code block in section 1.2 of the Phase 2b-i design note
 * (threads-design-2026-11-12-p2b-contract-v2-design.md, lines 54-284), exactly as written there.
 * Geode's G1 PR is being built in parallel: when it lands, re-diff against its feedback-contract-v2.ts.
 */
const DESIGN_NOTE_BLOCK_SHA256 = '5140d33cc7152b131de486e4b1061bc72bec32c350a68488f364b244c30e02b3';
const MARKER = '// --- begin verbatim copy ---\n';
const VENDORED_IMPORT = 'from "./geodeArtifactFeedback";';
const DESIGN_IMPORT = 'from "./feedback-contract";';

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'geodeArtifactFeedbackV2.ts'), 'utf8');

describe('vendored Geode contract v2 types', () => {
  it('equals the design note block byte for byte, apart from the single import specifier', () => {
    const at = source.indexOf(MARKER);
    expect(at).toBeGreaterThan(-1);
    const body = source.slice(at + MARKER.length);
    expect(body.split(VENDORED_IMPORT)).toHaveLength(2);
    const asDesigned = body.replace(VENDORED_IMPORT, DESIGN_IMPORT);
    expect(createHash('sha256').update(asDesigned).digest('hex')).toBe(DESIGN_NOTE_BLOCK_SHA256);
  });

  it('tells the reader to re-diff against Geode feedback-contract-v2.ts when G1 lands', () => {
    const header = source.slice(0, source.indexOf(MARKER));
    expect(header).toContain('feedback-contract-v2.ts');
    expect(header).toMatch(/RE-DIFF/);
  });

  it('keeps the constants the store relies on', () => {
    expect([...ARTIFACT_FEEDBACK_SUPPORTED_VERSIONS]).toEqual([1, 2]);
    expect(ARTIFACT_COMMENTS_CAPS.maxComments).toBe(200);
    expect(ARTIFACT_COMMENTS_CAPS.maxTextUnits).toBe(4000);
    expect(ARTIFACT_COMMENT_ID_PATTERN.test('cmt_0123456789abcdef0123456789abcdef')).toBe(true);
    expect(ARTIFACT_COMMENT_ID_PATTERN.test('cmt_0123456789ABCDEF0123456789abcdef')).toBe(false);
    expect(ARTIFACT_COMMENTS_REQUEST_ID_PATTERN.test('req_0123456789abcdef0123456789abcdef')).toBe(true);
  });
});
