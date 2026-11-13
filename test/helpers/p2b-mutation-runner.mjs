// Mutation check for P2b (QA tooling, not part of the vitest suite).
// Usage (from the repo root, after npm install): node test/helpers/p2b-mutation-runner.mjs <from> <to>
// For each mutant: apply one textual change to src, run the P2b-relevant tests, restore the file, report KILLED or SURVIVED.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const PROMPT = 'src/elementPrompt.ts';
const PROVIDER = 'src/artifactCommentsProvider.ts';
const COORD = 'src/sendCoordinator.ts';
const REG = 'src/elementFeedbackRegistration.ts';

const mutants = [
  { id: 'M01 prompt: drop the token occurrence check', file: PROMPT, from: 'occurrences(prompt, token) !== 2 * items.length', to: 'false' },
  { id: 'M02 prompt: item fence not longer than inner backtick runs', file: PROMPT, from: "const content = [`pin label: ${q(item.label, 120)}`, ...dataBody].join('\\n');\n  const fence = '`'.repeat(Math.max(MIN_FENCE, longestBacktickRun(content) + 1));", to: "const content = [`pin label: ${q(item.label, 120)}`, ...dataBody].join('\\n');\n  const fence = '`'.repeat(Math.max(MIN_FENCE, longestBacktickRun(content) + 0));" },
  { id: 'M03 prompt: no ordinal sort', file: PROMPT, from: 'const sorted = [...input.items].sort((a, b) => a.ordinal - b.ordinal || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));', to: 'const sorted = [...input.items];' },
  { id: 'M04 prompt: trusted comment text not defused', file: PROMPT, from: 'neutralizeEscalation(item.commentText, keywords),', to: 'item.commentText,' },
  { id: 'M05 prompt: anchor state not restricted to the fixed list', file: PROMPT, from: "const state = ANCHOR_STATES.has(item.anchorState) ? item.anchorState : 'unknown';", to: 'const state = item.anchorState;' },
  { id: 'M06 prompt: single-item prefix never tried', file: PROMPT, from: 'for (let k = remaining.length - 1; k >= 1; k--) {', to: 'for (let k = remaining.length - 1; k >= 2; k--) {' },
  { id: 'M07 prompt: always the most compact level', file: PROMPT, from: 'const prompt = tryBuild(remaining, LEVELS[level]);', to: 'const prompt = tryBuild(remaining, LEVELS[LEVELS.length - 1]);' },
  { id: 'M08 prompt: screenshot line never rendered', file: PROMPT, from: 'if (item.pngPath) lines.push(', to: 'if (false) lines.push(' },
  { id: 'M09 prompt: element tag not sanitized in header', file: PROMPT, from: "const safeTag = (tag: string): string => tag.replace(/[^a-z0-9:-]/g, '').slice(0, 32) || 'element';", to: 'const safeTag = (tag: string): string => tag;' },
  { id: 'M10 prompt: forged-token retry loop gives up after one attempt', file: PROMPT, from: 'const MAX_TOKEN_ATTEMPTS = 8;', to: 'const MAX_TOKEN_ATTEMPTS = 1;' },
  { id: 'M11 provider: foreign comments sendable', file: PROVIDER, from: "else if (comment.provenance !== 'local') results.set(id, { id, result: 'skipped', reason: 'foreign' });", to: "else if (false) results.set(id, { id, result: 'skipped', reason: 'foreign' });" },
  { id: 'M12 provider: no requestId ledger', file: PROVIDER, from: 'let entry = ledger.get(key);', to: 'let entry: BatchEntry | undefined = undefined;' },
  { id: 'M13 provider: no write-ahead', file: PROVIDER, from: "const written = await handle.transition(plan.includedIds.map((id) => ({ id, event: known.get(id)?.status === 'sent' ? ('batch-resend' as const) : ('batch-issued' as const), requestId })));", to: "const written = { status: 'ok' } as any;" },
  { id: 'M14 provider: mark sent whatever threads.send answered', file: PROVIDER, from: "if (outcome.status === 'sent') {\n      entry.state = 'done';", to: "if (true) {\n      entry.state = 'done';" },
  { id: 'M15 provider: ledger TTL 20 min', file: PROVIDER, from: 'const LEDGER_TTL_MS = 10 * 60 * 1000;', to: 'const LEDGER_TTL_MS = 20 * 60 * 1000;' },
  { id: 'M16 provider: ledger size 65', file: PROVIDER, from: 'const LEDGER_SIZE = 64;', to: 'const LEDGER_SIZE = 65;' },
  { id: 'M17 provider: no restart reconciliation', file: PROVIDER, from: 'if (stuck.length === 0) return;', to: 'return;' },
  { id: 'M18 provider: no busy pre-check', file: PROVIDER, from: "if (coordinator.isBusy(intake.root, requestId)) return fail('busy', BUSY_MESSAGE);", to: '' },
  { id: 'M19 provider: unqueue releases only the first member', file: PROVIDER, from: 'for (const id of entry.memberIds) {\n            const found = await handle.get(id);', to: 'for (const id of entry.memberIds.slice(0, 1)) {\n            const found = await handle.get(id);' },
  { id: 'M20 provider: stale deferred results accepted for settled entries', file: PROVIDER, from: "if (entry.state === 'queued' && entry.requestId === result.selectionId) {", to: 'if (entry.requestId === result.selectionId) {' },
  { id: 'M21 provider: resend flag ignored', file: PROVIDER, from: "(comment.status === 'sent' && parsed.resend)", to: "(comment.status === 'sent')" },
  { id: 'M22 provider: batch cap 21', file: PROVIDER, from: 'if (ids.length > MAX_BATCH) return', to: 'if (ids.length > MAX_BATCH + 1) return' },
  { id: 'M23 provider: vault-read does not force redaction of the snapshot', file: PROVIDER, from: 'comment.redacted || intake.vaultRead);\n        const hints', to: 'comment.redacted);\n        const hints' },
  { id: 'M24 provider: requestId reuse for other comments not a conflict', file: PROVIDER, from: "if (entry.requested !== requested) return fail('conflict', MESSAGES.requestReused);", to: '' },
  { id: 'M25 provider: abort ignored', file: PROVIDER, from: "if (signal?.aborted) return fail('unavailable', MESSAGES.aborted);", to: '' },
  { id: 'M26 coordinator: cancel ignores the sending guard', file: COORD, from: 'if (!slot || slot.selectionId !== selectionId || slot.sending) return false;', to: 'if (!slot || slot.selectionId !== selectionId) return false;' },
  { id: 'M27 coordinator: isBusy ignores in-flight sends', file: COORD, from: 'return running !== undefined && running.selectionId !== selectionId;', to: 'return false;' },
  { id: 'M28 coordinator: sending flag never set', file: COORD, from: 'slot.sending = true;\n      const outcome = await attempt(slot);', to: 'const outcome = await attempt(slot);' },
  { id: 'M29 coordinator: cancel reports nothing', file: COORD, from: "finish(slot, { status: 'cancelled' });\n    return true;", to: 'slots.delete(artifactKey);\n    return true;' },
  { id: 'M30 registration: deferred results not forwarded to the provider', file: REG, from: 'void comments?.handleDeferredResult(result).catch(', to: 'void Promise.resolve().catch(' },
  { id: 'M31 provider: pending comments not released when the queued send is rejected', file: PROVIDER, from: "await handle.transition(entry.memberIds.map((id) => ({ id, event: 'send-failed' as const, requestId: entry.requestId, message: outcome.message })));", to: '' },
  { id: 'M32 provider: unsendable status (resolved/dismissed) treated as open', file: PROVIDER, from: "if (comment.status === 'open' || (comment.status === 'sent' && parsed.resend)) sendable.push(comment);", to: "if (true) sendable.push(comment);" },
];

const FILES = ['test/batch-prompt.test.ts', 'test/batch-send.test.ts', 'test/send-coordinator-cancel.test.ts', 'test/send-coordinator.test.ts', 'test/element-prompt.test.ts', 'test/element-feedback-registration.test.ts', 'test/p2b-qa-prompt.test.ts', 'test/p2b-qa-send.test.ts', 'test/p2b-qa-coordinator.test.ts'];

function runTests() {
  const result = spawnSync('npx', ['vitest', 'run', ...FILES, '--reporter=default'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = `${result.stdout}\n${result.stderr}`.replace(/\x1b\[[0-9;]*m/g, '');
  const failed = /Tests\s+(\d+) failed/.exec(out);
  const passed = /(\d+) passed/.exec(out);
  const names = [...out.matchAll(/^ FAIL  (.+)$/gm)].map(m => m[1].replace(/^test\//, '').slice(0, 150));
  return { code: result.status, failed: failed ? Number(failed[1]) : 0, passed: passed ? Number(passed[1]) : 0, names: [...new Set(names)].slice(0, 4) };
}

const from = Number(process.argv[2] ?? 0);
const to = Number(process.argv[3] ?? mutants.length);

if (from === 0) {
  const control = runTests();
  console.log(`CONTROL (no mutation): exit=${control.code} failed=${control.failed} passed=${control.passed}`);
}
for (let i = from; i < Math.min(to, mutants.length); i++) {
  const mutant = mutants[i];
  const original = readFileSync(mutant.file, 'utf8');
  const count = original.split(mutant.from).length - 1;
  if (count !== 1) { console.log(`MUTANT ${mutant.id}: NOT APPLIED (pattern found ${count} times)`); continue; }
  writeFileSync(mutant.file, original.replace(mutant.from, () => mutant.to));
  try {
    const result = runTests();
    const verdict = result.code !== 0 ? 'KILLED' : 'SURVIVED';
    console.log(`MUTANT ${mutant.id}: ${verdict} (exit=${result.code}, failed=${result.failed}, passed=${result.passed}) ${result.names.map(n => `\n    - ${n}`).join('')}`);
  } finally {
    writeFileSync(mutant.file, original);
  }
}
