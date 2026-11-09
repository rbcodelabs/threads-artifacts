import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

/** sha256 of Geode's src/artifacts/feedback-contract.ts at rbcodelabs/geode 807be0c1 (QB6). */
const GEODE_CONTRACT_SHA256 = '4a30e96cc3d2024bafa75fddbc66a2043cc5868e3c5a5f1518a38a1fc351e857';
const MARKER = '// --- begin verbatim copy ---\n';

describe('vendored Geode contract', () => {
  it('stays byte-identical to the recorded Geode file so drift shows up in review', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'geodeArtifactFeedback.ts'), 'utf8');
    const at = source.indexOf(MARKER);
    expect(at).toBeGreaterThan(-1);
    expect(createHash('sha256').update(source.slice(at + MARKER.length)).digest('hex')).toBe(GEODE_CONTRACT_SHA256);
  });

  it('cites the Geode commit in its header', () => {
    expect(fs.readFileSync(path.join(__dirname, '..', 'src', 'geodeArtifactFeedback.ts'), 'utf8').slice(0, 600)).toContain('807be0c143e145e2f8d8184507ce196857114efb');
  });
});
