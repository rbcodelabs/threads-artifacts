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
  { id: 'M02 prompt: item fence not longer than inner backtick runs', file: PROMPT, from: "...dataBody].join('\\n');\n  const fence = '`'.repeat(Math.max(MIN_FENCE, longestBacktickRun(content) + 1));", to: "...dataBody].join('\\n');\n  const fence = '`'.repeat(Math.max(MIN_FENCE, longestBacktickRun(content) + 0));" },
  { id: 'M03 prompt: no ordinal sort', file: PROMPT, from: 'const sorted = [...input.items].sort((a, b) => a.ordinal - b.ordinal || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));', to: 'const sorted = [...input.items];' },
  { id: 'M04 prompt: trusted comment text not defused', file: PROMPT, from: '  neutralizeEscalation(text, keywords).split(', to: '  text.split(' },
  { id: 'M05 prompt: anchor state not restricted to the fixed list', file: PROMPT, from: "const state = ANCHOR_STATES.has(item.anchorState) ? item.anchorState : 'unknown';", to: 'const state = item.anchorState;' },
  { id: 'M06 prompt: bisection never tries the full-minus-one prefix', file: PROMPT, from: 'let high = remaining.length - 1;', to: 'let high = remaining.length - 2;' },
  { id: 'M07 prompt: always the most compact level', file: PROMPT, from: 'const prompt = tryBuild(items, LEVELS[level]);', to: 'const prompt = tryBuild(items, LEVELS[LEVELS.length - 1]);' },
  { id: 'M08 prompt: screenshot line never rendered', file: PROMPT, from: 'if (item.pngPath) lines.push(', to: 'if (false) lines.push(' },
  { id: 'M09 prompt: element tag not sanitized in header', file: PROMPT, from: "const safeTag = (tag: string): string => tag.replace(/[^a-z0-9:-]/g, '').slice(0, 32) || 'element';", to: 'const safeTag = (tag: string): string => tag;' },
  { id: 'M10 prompt: forged-token retry loop gives up after one attempt', file: PROMPT, from: 'const MAX_TOKEN_ATTEMPTS = 8;', to: 'const MAX_TOKEN_ATTEMPTS = 1;' },
  { id: 'M11 provider: foreign comments sendable', file: PROVIDER, from: "else if (comment.provenance !== 'local') results.set(id, { id, result: 'skipped', reason: 'foreign' });", to: "else if (false) results.set(id, { id, result: 'skipped', reason: 'foreign' });" },
  { id: 'M12 provider: no requestId ledger', file: PROVIDER, from: 'let entry = ledger.get(key);', to: 'let entry: BatchEntry | undefined = undefined;' },
  { id: 'M13 provider: no write-ahead', file: PROVIDER, from: "const written = await handle.transition(plan.includedIds.map((id) => ({ id, event: known.get(id)?.status === 'sent' ? ('batch-resend' as const) : ('batch-issued' as const), requestId, promptSha, expectedVersion: known.get(id)?.version })));", to: "const written = { status: 'ok' } as any;" },
  { id: 'M14 provider: mark sent whatever threads.send answered', file: PROVIDER, from: "if (outcome.status === 'sent') {\n      entry.state = 'done';", to: "if (true) {\n      entry.state = 'done';" },
  { id: 'M15 provider: ledger TTL 20 min', file: PROVIDER, from: 'const LEDGER_TTL_MS = 10 * 60 * 1000;', to: 'const LEDGER_TTL_MS = 20 * 60 * 1000;' },
  { id: 'M16 provider: ledger size 65', file: PROVIDER, from: 'const LEDGER_SIZE = 64;', to: 'const LEDGER_SIZE = 65;' },
  { id: 'M17 provider: no restart reconciliation', file: PROVIDER, from: 'if (stuck.length === 0) return;', to: 'return;' },
  { id: 'M18 provider: no busy pre-check', file: PROVIDER, from: "if (coordinator.isBusy(intake.root, requestId)) return fail('busy', BUSY_MESSAGE);", to: '' },
  { id: 'M19 provider: unqueue releases only the first member', file: PROVIDER, from: 'for (const id of entry.memberIds) await releaseMember(handle, id, entry.requestId);', to: 'for (const id of entry.memberIds.slice(0, 1)) await releaseMember(handle, id, entry.requestId);' },
  { id: 'M20 provider: stale deferred results accepted for settled entries', file: PROVIDER, from: "if (entry.state === 'queued' && entry.requestId === result.selectionId && entry.root === result.artifactKey) {", to: 'if (entry.requestId === result.selectionId && entry.root === result.artifactKey) {' },
  { id: 'M21 provider: resend flag ignored', file: PROVIDER, from: "(comment.status === 'sent' && parsed.resend)", to: "(comment.status === 'sent')" },
  { id: 'M22 provider: batch cap 21', file: PROVIDER, from: 'ids.length > MAX_BATCH) return { ok: false', to: 'ids.length > MAX_BATCH + 1) return { ok: false' },
  { id: 'M23 provider: vault-read does not force redaction of the snapshot', file: PROVIDER, from: 'comment.redacted || intake.vaultRead);\n        const hints', to: 'comment.redacted);\n        const hints' },
  { id: 'M24 provider: requestId reuse for other comments not a conflict', file: PROVIDER, from: "if (entry.requested !== requested) return fail('conflict', MESSAGES.requestReused);", to: '' },
  { id: 'M25 provider: abort ignored', file: PROVIDER, from: "if (signal?.aborted) return fail('unavailable', MESSAGES.aborted);", to: '' },
  { id: 'M26 coordinator: cancel ignores the sending guard', file: COORD, from: 'if (!slot || slot.selectionId !== selectionId || slot.sending) return false;', to: 'if (!slot || slot.selectionId !== selectionId) return false;' },
  { id: 'M27 coordinator: isBusy ignores in-flight sends', file: COORD, from: 'return running !== undefined && running.selectionId !== selectionId;', to: 'return false;' },
  { id: 'M28 coordinator: sending flag never set', file: COORD, from: 'slot.sending = true;\n      const outcome = await attempt(slot);', to: 'const outcome = await attempt(slot);' },
  { id: 'M29 coordinator: cancel reports nothing', file: COORD, from: "finish(slot, { status: 'cancelled' });\n    return true;", to: 'slots.delete(artifactKey);\n    return true;' },
  { id: 'M30 registration: deferred results not forwarded to the provider', file: REG, from: 'void comments?.handleDeferredResult(result).catch(', to: 'void Promise.resolve().catch(' },
  { id: 'M31 provider: pending comments not released when the queued send is rejected', file: PROVIDER, from: "else if (outcome.status === 'rejected') await recordMembers(handle, entry.memberIds, 'send-failed', entry.requestId, outcome.message, { event: 'expired', message: outcome.message });", to: '' },
  { id: 'M32 provider: unsendable status (resolved/dismissed) treated as open', file: PROVIDER, from: "if (comment.status === 'open' || (comment.status === 'sent' && parsed.resend)) sendable.push(comment);", to: "if (true) sendable.push(comment);" },
];

const NEW = [
  { id: 'N01 coordinator: abandoned flag never set on timeout', file: COORD, from: 'abandoned.value = true; resolve(', to: 'resolve(' },
  { id: 'N02 coordinator: abandoned run still proceeds after threadState', file: COORD, from: "if (abandoned.value) return rejected('failed', MESSAGES.timedOut);\n      if (disposed)", to: 'if (disposed)' },
  { id: 'N03 coordinator: abandoned run holds after a THREAD_BUSY answer', file: COORD, from: "if (outcome === BUSY && abandoned.value) return rejected('failed', MESSAGES.timedOut);", to: '' },
  { id: 'N04 provider: no conflict for a maybe-sent retry', file: PROVIDER, from: "if ([...marks.values()].some((mark) => mark === requestId)) return fail('conflict', MESSAGES.maybeSentRetry);", to: '' },
  { id: 'N05 provider: write-ahead without expectedVersion', file: PROVIDER, from: 'requestId, promptSha, expectedVersion: known.get(id)?.version })));', to: 'requestId, promptSha })));' },
  { id: 'N06 provider: plan key ignores the text', file: PROVIDER, from: '`${comment.id}:${textHash(comment.text)}`', to: '`${comment.id}`' },
  { id: 'N07 provider: no cancelled tombstone', file: PROVIDER, from: "if (entry.state === 'cancelled') return fail('conflict', MESSAGES.cancelled);", to: '' },
  { id: 'N08 provider: deferred results not matched by artifact', file: PROVIDER, from: ' && entry.root === result.artifactKey) {', to: ') {' },
  { id: 'N09 provider: retry during settling answered', file: PROVIDER, from: "if (entry.settling && !entry.settled) return fail('busy', MESSAGES.settling);", to: '' },
  { id: 'N10 provider: report kept while a failed queued send is recorded', file: PROVIDER, from: "if (outcome.status !== 'sent') entry.report = null;", to: '' },
  { id: 'N11 provider: no retry-once for transient store failures', file: PROVIDER, from: 'return transient(first) ? tryWrite(call) : first;', to: 'return first;' },
  { id: 'N12 provider: no fallback event when a member write keeps failing', file: PROVIDER, from: 'if (fallback) await writeWithRetry(() => handle.transition([item(id, fallback.event, fallback.message)]));', to: '' },
  { id: 'N13 provider: cancelled member not released through expired', file: PROVIDER, from: "await recordMembers(handle, [id], 'expired', requestId, 'Cancelled before it was sent.', null);", to: '' },
  { id: 'N14 provider: vault blanking off', file: PROVIDER, from: 'const hide = intake.vaultRead && !comment.redacted;', to: 'const hide = false;' },
  { id: 'N15 provider: label not blanked', file: PROVIDER, from: 'label: hide ? comment.anchor.tag : comment.label,', to: 'label: comment.label,' },
  { id: 'N16 prompt: comment lines not prefixed', file: PROMPT, from: '.map(line => `> ${line}`)', to: '.map(line => line)' },
  { id: 'N17 prompt: Braille blank and Hangul filler not escaped', file: PROMPT, from: String.raw`\\u2800\\u3164\\ufe00-\\ufe0f`, to: String.raw`\\ufe00-\\ufe0f` },
  { id: 'N18 prompt: bisection never tries two comments', file: PROMPT, from: 'let low = 2;', to: 'let low = 3;' },
  { id: 'N19 provider: batch cap check gone', file: PROVIDER, from: "if (Array.isArray(ids) && ids.length > MAX_BATCH) return { ok: false as const, result: fail('limit', `Send at most ${MAX_BATCH} comments at a time.`) };", to: '' },
  { id: 'N20 prompt: artifact folder line dropped', file: PROMPT, from: '...(common.artifactRoot ? [`artifact folder: ${q(common.artifactRoot, 400)}`] : [])', to: '...[]' },
  { id: 'N21 store: expectedVersion not enforced', file: 'src/commentStore.ts', from: "if (item.expectedVersion !== undefined && found.version !== item.expectedVersion) return rejected('conflict', 'That comment changed. Refresh and try again.');", to: '' },
  { id: 'N22 store: lastBatchRequestIds always null', file: 'src/commentStore.ts', from: 'out.set(c.id, c.send.lastBatchRequestId ?? null);', to: 'out.set(c.id, null);' },
  { id: 'N23 provider: write-ahead conflict not treated as skipped', file: PROVIDER, from: " || written.reason === 'foreign' || written.reason === 'conflict') {", to: " || written.reason === 'foreign') {" },
  { id: 'N24 provider: delivered per-member fallback skipped', file: PROVIDER, from: "if ((await writeWithRetry(() => handle.transition(ids.map((id) => item(id, event, message))))).status === 'ok') return true;", to: "if ((await writeWithRetry(() => handle.transition(ids.map((id) => item(id, event, message))))).status === 'ok') return true; return false;" },
];
mutants.push(...NEW);

const FINAL = [
  { id: 'Q01 coordinator: a timeout is not flagged maybe-sent', file: COORD, from: "resolve(uncertain('failed', MESSAGES.timedOut))", to: "resolve(rejected('failed', MESSAGES.timedOut))" },
  { id: 'Q02 coordinator: reload mid-send not flagged maybe-sent', file: COORD, from: "issued.value ? uncertain('unavailable', MESSAGES.statusUnknown)", to: "issued.value ? rejected('unavailable', MESSAGES.statusUnknown)" },
  { id: 'Q03 provider: maybeSent not passed to the store', file: PROVIDER, from: 'outcome.maybeSent === true);', to: 'false);', all: true },
  { id: 'Q04 provider: prompt hash comparison removed', file: PROVIDER, from: 'mark.promptSha !== promptSha) return fail', to: 'false) return fail' },
  { id: 'Q05 provider: conflict for any request id, not only the same one', file: PROVIDER, from: 'if (mark?.requestId !== requestId) continue;', to: 'if (false) continue;' },
  { id: 'Q06 provider: prompt hash not stored', file: PROVIDER, from: 'requestId, promptSha, expectedVersion', to: 'requestId, expectedVersion' },
  { id: 'Q07 store: batch secret unstable (random per call)', file: 'src/commentStore.ts', from: ".update('threads-design/batch-boundary/v1')", to: ".update(randomBytes(8).toString('hex'))" },
  { id: 'Q08 store: batch secret is the raw install key', file: 'src/commentStore.ts', from: "return createHmac('sha256', await this.ensureKey()).update('threads-design/batch-boundary/v1').digest('hex');", to: "return Buffer.from(await this.ensureKey()).toString('hex');" },
  { id: 'Q09 provider: tombstone window not restarted at the cancel', file: PROVIDER, from: "{ entry.plan = null; entry.at = now(); }", to: '{ entry.plan = null; }' },
  { id: 'Q10 prompt: no URL defusing after an escape', file: PROMPT, from: String.raw`(?:\b|(?<=\\u[0-9a-f]{4})|(?<=\\u\{[0-9a-f]+\}))`, to: String.raw`\b` },
  { id: 'Q11 store: prompt hash not validated in transitions', file: 'src/commentStore.ts', from: "if (item.promptSha !== undefined && !isPromptSha(item.promptSha)) return rejected('invalid', 'Those changes are not valid.');", to: '' },
  { id: 'Q12 model: send-failed maybeSent not sticky', file: 'src/commentModel.ts', from: 'maybeSent: ctx.maybeSent === true ? true : send.maybeSent', to: 'maybeSent: ctx.maybeSent === true' },
  { id: 'Q13 provider: uncertain-retry branch removed', file: PROVIDER, from: 'if (maybeSent.length > 0) {', to: 'if (false) {' },
  { id: 'Q14 model: hostile stored prompt hash accepted', file: 'src/commentModel.ts', from: '...(isPromptSha(promptSha) ? { lastBatchPromptSha: promptSha } : {}),', to: '...(promptSha !== undefined ? { lastBatchPromptSha: promptSha as string } : {}),' },
  { id: 'Q15 model: prompt hash not recorded by the write-ahead event', file: 'src/commentModel.ts', from: '...(isPromptSha(ctx.promptSha) ? { lastBatchPromptSha: ctx.promptSha } : {}) };', to: '};' },
];
mutants.push(...FINAL);
const REVIEW = [
  { id: 'R01 provider: no dedupe window', file: PROVIDER, from: ' || now() - issued > MAYBE_SENT_DEDUPE_WINDOW_MS) return fail', to: ') return fail' },
  { id: 'R02 provider: missing issue time proceeds', file: PROVIDER, from: 'if (!Number.isFinite(issued) || now() - issued > MAYBE_SENT_DEDUPE_WINDOW_MS)', to: 'if (now() - issued > MAYBE_SENT_DEDUPE_WINDOW_MS)' },
  { id: 'R03 provider: hash not bound to the thread', file: PROVIDER, from: '`${intake.threadId}\\n${plan.prompt}`', to: '`${plan.prompt}`' },
  { id: 'R04 coordinator: outstanding sends not checked', file: COORD, from: 'if (earlier && earlier.issued.value && earlier.prompt !== request.prompt) return Promise.resolve(uncertain(', to: 'if (false) return Promise.resolve(uncertain(' },
  { id: 'R05 coordinator: unknown errors after issue are definite', file: COORD, from: 'default: return issued ? uncertain(\'failed\', MESSAGES.unconfirmed) : rejected(\'failed\', MESSAGES.generic);', to: 'default: return rejected(\'failed\', MESSAGES.generic);' },
  { id: 'R06 coordinator: attempt errors not marked issued', file: COORD, from: 'return mapSendError(error, true);', to: 'return mapSendError(error);' },
  { id: 'R07 model: expired keeps no maybeSent', file: 'src/commentModel.ts', from: "send = { ...send, lastOutcome: 'failed', lastMessage: message, maybeSent: ctx.maybeSent === true ? true : send.maybeSent };\n      break;\n    case 'reload-recovered':", to: "send = { ...send, lastOutcome: 'failed', lastMessage: message };\n      break;\n    case 'reload-recovered':" },
  { id: 'R08 provider: key failure reported as unsafe prompt', file: PROVIDER, from: "return fail('unavailable', MESSAGES.secretUnavailable);", to: "return fail('failed', MESSAGES.promptUnsafe);" },
  { id: 'R09 store: batch secret label changed', file: 'src/commentStore.ts', from: "export const BATCH_SECRET_LABEL = 'threads-design/batch-boundary/v1';", to: "export const BATCH_SECRET_LABEL = 'threads-design/batch-boundary/v2';" },
  { id: 'R10 model: issue time not stored', file: 'src/commentModel.ts', from: 'lastBatchAt: ctx.now, ', to: '' },
  { id: 'R11 provider: maybeSent not passed to expired path for queued sends', file: PROVIDER, from: "{ event: 'expired', message: outcome.message }, outcome.maybeSent === true);\n        else if (outcome.status === 'cancelled')", to: "{ event: 'expired', message: outcome.message });\n        else if (outcome.status === 'cancelled')" },
];
mutants.push(...REVIEW);

const FILES = ['test/batch-prompt.test.ts', 'test/batch-send.test.ts', 'test/send-coordinator-cancel.test.ts', 'test/send-coordinator.test.ts', 'test/element-prompt.test.ts', 'test/element-feedback-registration.test.ts', 'test/p2b-qa-prompt.test.ts', 'test/p2b-qa-send.test.ts', 'test/p2b-qa-coordinator.test.ts'];

function runTests() {
  const result = spawnSync('npx', ['vitest', 'run', ...FILES, '--reporter=default'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = `${result.stdout}\n${result.stderr}`.replace(/\x1b\[[0-9;]*m/g, '');
  const failed = /Tests\s+(\d+) failed/.exec(out);
  const passed = /(\d+) passed/.exec(out);
  const names = [...out.matchAll(/^ FAIL  (.+)$/gm)].map(m => m[1].replace(/^test\//, '').slice(0, 150));
  return { code: result.status, failed: failed ? Number(failed[1]) : 0, passed: passed ? Number(passed[1]) : 0, names: [...new Set(names)].slice(0, 4) };
}

const maskMode = process.argv[4] === 'mask';
let mask = 0;
const from = Number(process.argv[2] ?? 0);
const to = Number(process.argv[3] ?? mutants.length);

if (from === 0 && !maskMode) {
  const control = runTests();
  console.log(`CONTROL (no mutation): exit=${control.code} failed=${control.failed} passed=${control.passed}`);
}
for (let i = from; i < Math.min(to, mutants.length); i++) {
  const mutant = mutants[i];
  const original = readFileSync(mutant.file, 'utf8');
  const count = original.split(mutant.from).length - 1;
  if (mutant.all ? count < 1 : count !== 1) { console.log(`MUTANT ${mutant.id}: NOT APPLIED (pattern found ${count} times)`); mask |= 1 << (i - from); continue; }
  writeFileSync(mutant.file, mutant.all ? original.split(mutant.from).join(mutant.to) : original.replace(mutant.from, () => mutant.to));
  try {
    const result = runTests();
    const verdict = result.code !== 0 ? 'KILLED' : 'SURVIVED';
    if (result.code === 0) mask |= 1 << (i - from);
    console.log(`MUTANT ${mutant.id}: ${verdict} (exit=${result.code}, failed=${result.failed}, passed=${result.passed}) ${result.names.map(n => `\n    - ${n}`).join('')}`);
  } finally {
    writeFileSync(mutant.file, original);
  }
}

if (maskMode) process.exit(mask);
