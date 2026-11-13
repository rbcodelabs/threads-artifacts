import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ElementSelection } from './geodeArtifactFeedback';
import type { SourceHint } from './elementPrompt';
import { attribute, findReportHints, openingTag } from './reportHints';

/**
 * Heuristic static source hints: where in the artifact's root files might the picked element be
 * defined? Hints are leads, not facts; the prompt tells the agent to re-check before editing.
 * Work is bounded (file count, bytes per file, total bytes, hits, wall time) so a hostile or huge
 * artifact cannot stall a send.
 */

export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_TOTAL_BYTES = 1024 * 1024;
export const MAX_FILES = 24;
export const MAX_HINTS = 5;
const SNIPPET_BEFORE = 30;
const SNIPPET_AFTER = 130;
const MAX_HITS_PER_STEP_FILE = 6;
const DEFAULT_BUDGET_MS = 400;
const SKIPPED_FILES = new Set(['artifact.json', 'package.json', 'package-lock.json', 'tsconfig.json']);

type Kind = 'html' | 'css' | 'js' | 'json';
const CONFIDENCE_ORDER = { high: 0, med: 1, low: 2 } as const;
const KIND_ORDER: Record<Kind, number> = { html: 0, css: 1, js: 2, json: 3 };

export interface SourceFile { readonly name: string; readonly kind: Kind; readonly lines: readonly string[] }
interface Candidate extends SourceHint { readonly step: number; readonly fileOrder: number }

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const kindOf = (name: string): Kind | null => {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.html' || ext === '.htm') return 'html';
  if (ext === '.css') return 'css';
  if (ext === '.js' || ext === '.mjs') return 'js';
  if (ext === '.json') return 'json';
  return null;
};

async function readBounded(file: string): Promise<string | null> {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) return null;
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_FILE_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

/** Reads the folder's candidate source files once. A batch loads them once and passes them to every `findSourceHints`. */
export async function loadSourceFiles(root: string): Promise<SourceFile[]> {
  let names: string[];
  try { names = await fs.readdir(root); } catch { return []; }
  const wanted = names
    .filter(name => !name.startsWith('.') && !SKIPPED_FILES.has(name) && kindOf(name) !== null)
    .sort((a, b) => {
      if (a === 'index.html') return -1;
      if (b === 'index.html') return 1;
      return KIND_ORDER[kindOf(a)!] - KIND_ORDER[kindOf(b)!] || a.localeCompare(b);
    })
    .slice(0, MAX_FILES);
  const files: SourceFile[] = [];
  let total = 0;
  for (const name of wanted) {
    if (total >= MAX_TOTAL_BYTES) break;
    try {
      const content = await readBounded(path.join(root, name));
      if (content === null) continue;
      total += content.length;
      files.push({ name, kind: kindOf(name)!, lines: content.split('\n') });
    } catch {
      // Unreadable or vanished file: just not a hint source.
    }
  }
  return files;
}

const snippetAround = (line: string, index: number): string => line.slice(Math.max(0, index - SNIPPET_BEFORE), index + SNIPPET_AFTER).trim();

export async function findSourceHints(root: string, selection: ElementSelection, options: { budgetMs?: number; files?: readonly SourceFile[] } = {}): Promise<SourceHint[]> {
  const deadline = Date.now() + (options.budgetMs ?? DEFAULT_BUDGET_MS);
  const files = options.files ?? await loadSourceFiles(root);
  if (files.length === 0) return [];

  const tagText = openingTag(selection.outerHTML.html);
  const id = attribute(tagText, 'id')?.trim() || null;
  const classes = [...new Set((attribute(tagText, 'class') ?? '').split(/\s+/).filter(Boolean))].slice(0, 8);
  const text = selection.redacted ? '' : selection.textAnchor.text.replace(/\s+/g, ' ').trim();
  const tagNeedle = tagText.length >= 6 && tagText.length <= 160 ? tagText : '';

  const found: Candidate[] = [];
  const add = (file: SourceFile, fileOrder: number, step: number, lineIndex: number, matchIndex: number, confidence: SourceHint['confidence']) => {
    found.push({ file: file.name, line: lineIndex + 1, confidence: file.kind === 'js' ? 'low' : confidence, snippet: snippetAround(file.lines[lineIndex], matchIndex), step, fileOrder });
  };

  /** Runs `probe` over every line of the file; returns hits as [lineIndex, matchIndex]. */
  const scan = (file: SourceFile, probe: (line: string) => number): [number, number][] => {
    const hits: [number, number][] = [];
    for (let i = 0; i < file.lines.length && hits.length < MAX_HITS_PER_STEP_FILE; i++) {
      if ((i & 255) === 0 && Date.now() > deadline) break;
      const at = probe(file.lines[i]);
      if (at >= 0) hits.push([i, at]);
    }
    return hits;
  };

  const idHtml = id ? new RegExp(`(?:^|\\s)id\\s*=\\s*["']?${escapeRegExp(id)}["']?(?=[\\s>/]|$)`, 'i') : null;
  const idCss = id ? new RegExp(`#${escapeRegExp(id)}(?![\\w-])`) : null;
  const idJs = id ? new RegExp(`(?:["'\`]${escapeRegExp(id)}["'\`]|#${escapeRegExp(id)}(?![\\w-])|\\bid\\s*=\\s*\\\\?["']?${escapeRegExp(id)})`) : null;
  const classTokens = classes.map(name => ({ name, css: new RegExp(`\\.${escapeRegExp(name)}(?![\\w-])`), word: new RegExp(`(?:^|[^\\w-])${escapeRegExp(name)}(?![\\w-])`) }));
  const classAttr = /(?:^|\s)class\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

  files.forEach((file, fileOrder) => {
    // Step 1: element id.
    if (idHtml && idCss && idJs) {
      if (file.kind === 'html') {
        const hits = scan(file, line => line.search(idHtml));
        hits.forEach(([line, at]) => add(file, fileOrder, 1, line, at, hits.length === 1 ? 'high' : 'med'));
      } else if (file.kind === 'css') {
        scan(file, line => line.search(idCss)).forEach(([line, at]) => add(file, fileOrder, 1, line, at, 'med'));
      } else if (file.kind === 'js') {
        scan(file, line => line.search(idJs)).forEach(([line, at]) => add(file, fileOrder, 1, line, at, 'low'));
      }
    }
    // Step 2: class combination (every class of the element on one attribute / selector / line).
    if (classTokens.length > 0) {
      if (file.kind === 'html') {
        const hits = scan(file, line => {
          classAttr.lastIndex = 0;
          for (let m = classAttr.exec(line); m; m = classAttr.exec(line)) {
            const present = new Set((m[1] ?? m[2] ?? '').split(/\s+/));
            if (classTokens.every(token => present.has(token.name))) return m.index;
          }
          return -1;
        });
        hits.forEach(([line, at]) => add(file, fileOrder, 2, line, at, hits.length === 1 ? 'high' : hits.length <= 3 ? 'med' : 'low'));
      } else if (file.kind === 'css') {
        const hits = scan(file, line => (classTokens.every(token => token.css.test(line)) ? line.search(classTokens[0].css) : -1));
        hits.forEach(([line, at]) => add(file, fileOrder, 2, line, at, hits.length <= 3 ? 'med' : 'low'));
      } else if (file.kind === 'js') {
        scan(file, line => (classTokens.every(token => token.word.test(line)) ? line.search(classTokens[0].word) : -1)).forEach(([line, at]) => add(file, fileOrder, 2, line, at, 'low'));
      }
    }
    // Step 3: visible text.
    if (text.length >= 3 && file.kind !== 'css') {
      const hits = scan(file, line => line.replace(/\s+/g, ' ').indexOf(text) >= 0 ? Math.max(0, line.indexOf(text.slice(0, 12))) : -1);
      hits.forEach(([line, at]) => add(file, fileOrder, 3, line, at, file.kind === 'html' && hits.length === 1 ? 'med' : 'low'));
    }
    // Step 4: leading outerHTML (the opening tag).
    if (tagNeedle && (file.kind === 'html' || file.kind === 'js')) {
      const hits = scan(file, line => line.indexOf(tagNeedle));
      hits.forEach(([line, at]) => add(file, fileOrder, 4, line, at, file.kind === 'html' && hits.length === 1 ? 'med' : 'low'));
    }
  });

  // Report data (chart marks, legend labels, table cells, data-report-field): the datum in data.js is the source.
  // These come first (step 0, in emission order) so they outrank class-only css matches.
  const dataFiles = files.filter(file => file.kind === 'js' || file.kind === 'json');
  findReportHints(dataFiles, selection, { deadline: Math.max(deadline, Date.now() + 150) }).forEach((datum, index) => {
    const file = files.find(candidate => candidate.name === datum.file);
    if (!file) return;
    const lineText = file.lines[datum.hint.lineIndex] ?? '';
    found.push({ file: file.name, line: datum.hint.lineIndex + 1, confidence: datum.hint.confidence, snippet: snippetAround(lineText.endsWith('\r') ? lineText.slice(0, -1) : lineText, datum.hint.col), step: index * 0.01, fileOrder: files.indexOf(file) });
  });

  // Best candidate per file:line, then rank by confidence, step, file order, line.
  const best = new Map<string, Candidate>();
  for (const candidate of found) {
    const key = `${candidate.file}:${candidate.line}`;
    const current = best.get(key);
    if (!current || CONFIDENCE_ORDER[candidate.confidence] < CONFIDENCE_ORDER[current.confidence]
      || (candidate.confidence === current.confidence && candidate.step < current.step)) best.set(key, candidate);
  }
  return [...best.values()]
    .sort((a, b) => CONFIDENCE_ORDER[a.confidence] - CONFIDENCE_ORDER[b.confidence] || a.step - b.step || a.fileOrder - b.fileOrder || a.line - b.line)
    .slice(0, MAX_HINTS)
    .map(({ file, line, confidence, snippet }) => ({ file, line, confidence, snippet }));
}
