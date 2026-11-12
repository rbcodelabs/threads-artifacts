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
 * sha256 of Geode's src/artifacts/feedback-contract-v2.ts exactly as merged on the G1 branch
 * (rbcodelabs/geode feat/picker-pins-g1-contract-v2 @ 7e75a77451aa3cd0f083212be1adf9c25521440b, PR #457,
 * file last changed in 276e9ac2574814a3fe55dc71c9a9a107be195ac6). Re-diff when G1 changes.
 */
const GEODE_G1_FILE_SHA256 = '08e39d8bbe26a1bd7501219c4796b1d35db57cfba19d0e933e1d2a66668b4f5c';
const MARKER = '// --- begin verbatim copy ---\n';
const VENDORED_IMPORT = 'from "./geodeArtifactFeedback";';
const DESIGN_IMPORT = 'from "./feedback-contract";';

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'geodeArtifactFeedbackV2.ts'), 'utf8');

describe('vendored Geode contract v2 types', () => {
  it('equals the G1 feedback-contract-v2.ts byte for byte, apart from the single import specifier', () => {
    const at = source.indexOf(MARKER);
    expect(at).toBeGreaterThan(-1);
    const body = source.slice(at + MARKER.length);
    expect(body.split(VENDORED_IMPORT)).toHaveLength(2);
    const asDesigned = body.replace(VENDORED_IMPORT, DESIGN_IMPORT);
    expect(createHash('sha256').update(asDesigned).digest('hex')).toBe(GEODE_G1_FILE_SHA256);
  });

  it('tells the reader to re-diff against Geode feedback-contract-v2.ts when G1 changes', () => {
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
