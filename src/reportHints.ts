import type { ElementSelection } from './geodeArtifactFeedback';

/**
 * Chart-mark-aware source hints for report-mode artifacts (spec 13d, QA findings R3/B1).
 *
 * In a report the numbers live in data.js (window.REPORT_DATA) and report.js draws the SVG, so a
 * picked bar, point, legend label or table cell has no source of its own: the datum is the source.
 * This module finds that datum. It tokenizes the data file once (strings, identifiers, punctuation;
 * no regex is ever built from page text) and compares page-controlled needles to string-literal
 * VALUES by plain equality, so no needle can cause backtracking or over-matching.
 *
 * Work is linear in the file: bracket pairs are computed once with a stack, every list is consumed
 * once, entry counts are capped, and a deadline is checked while tokenizing and parsing. Hostile or
 * malformed data therefore produces no hints (never a stall and never an exception).
 */

export type DatumConfidence = 'high' | 'med' | 'low';
export interface DatumHint { readonly lineIndex: number; readonly col: number; readonly confidence: DatumConfidence }
export interface ReportFile { readonly name: string; readonly lines: readonly string[] }
export interface ReportHintOptions { readonly deadline?: number }

const MAX_NEEDLE = 200;
const MAX_TOKENS = 200_000;
const MAX_CHARS = 600_000;
const MAX_ENTRIES = 5000;
const MAX_HINTS_PER_KIND = 2;
const MAX_REPORT_FILES = 4;
const CHECK_EVERY = 2048;

/** Opening tag of the picked element, scanned quote-aware so `>` inside an attribute value does not end it. */
export function openingTag(html: string): string {
  let quote = '';
  for (let i = 0; i < html.length && i < 2048; i++) {
    const char = html[i];
    if (quote) { if (char === quote) quote = ''; continue; }
    if (char === '"' || char === "'") quote = char;
    else if (char === '>') return html.slice(0, i + 1);
  }
  return html.slice(0, 120);
}

export function attribute(tagText: string, name: string): string | null {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tagText);
  return match ? (match[1] ?? match[2] ?? match[3] ?? '') : null;
}

// ---- tokenizer -------------------------------------------------------------------------------

interface Token { readonly kind: 'str' | 'id' | 'p'; readonly value: string; readonly line: number; readonly col: number }

class Abort extends Error {}

function unescapeLiteral(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (char !== '\\' || i + 1 >= raw.length) { out += char; continue; }
    const next = raw[++i];
    out += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;
  }
  return out;
}

const isIdChar = (char: string): boolean => /[A-Za-z0-9_$.+-]/.test(char);

/** JS/JSON-ish tokenizer: skips comments, understands quotes and escapes, keeps line and column. */
function tokenize(lines: readonly string[], expired: () => boolean): Token[] {
  const tokens: Token[] = [];
  let quote = '';
  let literal = '';
  let literalStart = { line: 0, col: 0 };
  let inBlockComment = false;
  let chars = 0;
  if (expired()) throw new Abort();
  for (let line = 0; line < lines.length && tokens.length < MAX_TOKENS && chars < MAX_CHARS; line++) {
    const text = lines[line].endsWith('\r') ? lines[line].slice(0, -1) : lines[line];
    for (let col = 0; col < text.length; col++) {
      if ((++chars % CHECK_EVERY) === 0 && expired()) throw new Abort();
      if (chars > MAX_CHARS || tokens.length >= MAX_TOKENS) return tokens;
      const char = text[col];
      if (inBlockComment) {
        if (char === '*' && text[col + 1] === '/') { inBlockComment = false; col++; }
        continue;
      }
      if (quote) {
        if (char === '\\' && col + 1 < text.length) { literal += char + text[col + 1]; col++; continue; }
        if (char === quote) {
          tokens.push({ kind: 'str', value: unescapeLiteral(literal), line: literalStart.line, col: literalStart.col });
          quote = '';
          literal = '';
          continue;
        }
        if (literal.length < MAX_NEEDLE * 4) literal += char;
        continue;
      }
      if (char === '/' && text[col + 1] === '/') break;
      if (char === '/' && text[col + 1] === '*') { inBlockComment = true; col++; continue; }
      if (char === '"' || char === "'" || char === '`') { quote = char; literal = ''; literalStart = { line, col }; continue; }
      if ('{}[]:,='.includes(char)) { tokens.push({ kind: 'p', value: char, line, col }); continue; }
      if (isIdChar(char)) {
        let end = col + 1;
        while (end < text.length && isIdChar(text[end])) end++;
        tokens.push({ kind: 'id', value: text.slice(col, end), line, col });
        chars += end - col - 1;
        col = end - 1;
      }
    }
    // A string never spans lines except template literals; a dangling quote on a plain line is dropped.
    if (quote && quote !== '`') { quote = ''; literal = ''; }
    else if (quote && literal.length < MAX_NEEDLE * 4) literal += '\n';
  }
  return tokens;
}

/** closeOf[i] = index of the token closing the bracket opened at i (last token when unbalanced), computed once in O(n). */
function pairBrackets(tokens: readonly Token[]): Int32Array {
  const closeOf = new Int32Array(tokens.length).fill(-1);
  const stack: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind !== 'p') continue;
    if (token.value === '{' || token.value === '[') stack.push(i);
    else if (token.value === '}' || token.value === ']') { const open = stack.pop(); if (open !== undefined) closeOf[open] = i; }
  }
  for (const open of stack) closeOf[open] = tokens.length - 1;
  return closeOf;
}

// ---- data model ------------------------------------------------------------------------------

interface Entry { readonly value: string; readonly line: number; readonly col: number }
interface Block {
  readonly key: string;
  readonly line: number;
  readonly col: number;
  readonly seriesNames: Entry[];
  readonly categories: Entry[];
  readonly values: { readonly n: number; readonly line: number; readonly col: number }[];
}
interface DataModel { readonly blocks: Block[]; readonly fields: Map<string, Entry> }

const isKey = (token: Token | undefined, name?: string): boolean => !!token && (token.kind === 'str' || token.kind === 'id') && (name === undefined || token.value === name);
const isPunct = (token: Token | undefined, char: string): boolean => !!token && token.kind === 'p' && token.value === char;

/** Reads one chart block. Every list is consumed once (the scan jumps past it), so work is linear. */
function readBlock(tokens: readonly Token[], closeOf: Int32Array, keyIndex: number, openIndex: number, tick: () => void): Block {
  const block: Block = { key: tokens[keyIndex].value, line: tokens[keyIndex].line, col: tokens[keyIndex].col, seriesNames: [], categories: [], values: [] };
  const end = closeOf[openIndex];
  const collectValues = (listOpen: number) => {
    const listEnd = closeOf[listOpen];
    for (let k = listOpen + 1; k < listEnd && block.values.length < MAX_ENTRIES; k++) {
      tick();
      const n = Number(tokens[k].value);
      if (tokens[k].kind === 'id' && Number.isFinite(n)) block.values.push({ n, line: tokens[k].line, col: tokens[k].col });
    }
  };
  for (let i = openIndex + 1; i < end; i++) {
    tick();
    const token = tokens[i];
    if (!isKey(token) || !isPunct(tokens[i + 1], ':') || !isPunct(tokens[i + 2], '[')) continue;
    const listOpen = i + 2;
    const listEnd = closeOf[listOpen];
    if (token.value === 'categories') {
      for (let k = listOpen + 1; k < listEnd && block.categories.length < MAX_ENTRIES; k++) {
        tick();
        if (tokens[k].kind === 'str') block.categories.push({ value: tokens[k].value, line: tokens[k].line, col: tokens[k].col });
      }
      i = listEnd;
    } else if (token.value === 'values') {
      collectValues(listOpen);
      i = listEnd;
    } else if (token.value === 'series') {
      // Only a `name` key directly inside a series element names a series.
      for (let k = listOpen + 1; k < listEnd; k++) {
        tick();
        if (!isPunct(tokens[k], '{')) continue;
        const objectEnd = closeOf[k];
        for (let j = k + 1; j < objectEnd; j++) {
          tick();
          if (isKey(tokens[j], 'name') && isPunct(tokens[j + 1], ':') && tokens[j + 2]?.kind === 'str') {
            if (block.seriesNames.length < MAX_ENTRIES) block.seriesNames.push({ value: tokens[j + 2].value, line: tokens[j + 2].line, col: tokens[j + 2].col });
          } else if (isKey(tokens[j], 'values') && isPunct(tokens[j + 1], ':') && isPunct(tokens[j + 2], '[')) {
            collectValues(j + 2);
            j = closeOf[j + 2];
          } else if (isPunct(tokens[j], '{') || isPunct(tokens[j], '[')) {
            j = closeOf[j];
          }
        }
        k = objectEnd;
      }
      i = listEnd;
    }
  }
  return block;
}

/** Null when the file has no `charts: { ... }` object (not report data) or the deadline passed. */
export function parseReportData(lines: readonly string[], deadline = Number.POSITIVE_INFINITY): DataModel | null {
  const expired = () => Date.now() > deadline;
  let ticks = 0;
  const tick = () => { if ((++ticks % CHECK_EVERY) === 0 && expired()) throw new Abort(); };
  try {
    const tokens = tokenize(lines, expired);
    const chartsAt = tokens.findIndex((token, i) => isKey(token, 'charts') && isPunct(tokens[i + 1], ':') && isPunct(tokens[i + 2], '{'));
    if (chartsAt < 0) return null;
    const closeOf = pairBrackets(tokens);
    const chartsEnd = closeOf[chartsAt + 2];
    const blocks: Block[] = [];
    for (let i = chartsAt + 3; i < chartsEnd; i++) {
      tick();
      if (isKey(tokens[i]) && isPunct(tokens[i + 1], ':') && isPunct(tokens[i + 2], '{')) {
        blocks.push(readBlock(tokens, closeOf, i, i + 2, tick));
        i = closeOf[i + 2];
      }
    }
    // Top-level fields: keys directly inside the outermost object, before or after `charts`.
    const fields = new Map<string, Entry>();
    let rootOpen = -1;
    for (let i = chartsAt - 1; i >= 0 && rootOpen < 0; i--) if (isPunct(tokens[i], '{') && closeOf[i] >= chartsAt + 2) rootOpen = i;
    if (rootOpen >= 0) {
      for (let i = rootOpen + 1; i < closeOf[rootOpen]; i++) {
        tick();
        const token = tokens[i];
        if (isKey(token) && isPunct(tokens[i + 1], ':') && !fields.has(token.value)) fields.set(token.value, { value: token.value, line: token.line, col: token.col });
        if (isPunct(token, '{') || isPunct(token, '[')) i = closeOf[i];
      }
    }
    return { blocks, fields };
  } catch (error) {
    if (error instanceof Abort) return null;
    return null;
  }
}

// ---- signals from the pick -------------------------------------------------------------------

interface Signals {
  dataChart: string | null;
  idSources: string[];
  series: string | null;
  category: string | null;
  field: string | null;
  text: string | null;
  cell: { row: number; col: number; header: boolean; thead: boolean } | null;
  /** The pick is plausibly a chart part (a mark, legend item, tick, table cell inside a figure). */
  inChart: boolean;
}

const clip = (text: string | null): string | null => (text && text.length > 0 && text.length <= MAX_NEEDLE ? text : null);
const CHART_CLASSES = ['chart', 'chart-svg', 'chart-scroll', 'chart-table', 'legend', 'swatch'];

const HTML_ENTITIES: Record<string, string> = { lt: '<', gt: '>', quot: '"', '#39': "'", amp: '&' };
/** One pass, so a decoded `&amp;lt;` stays `&lt;` and is never decoded twice. */
function unescapeHtml(text: string): string {
  return text.replace(/&(lt|gt|quot|#39|amp);/g, (_match, name: string) => HTML_ENTITIES[name]);
}

/** "Q2 Q2" (a text element whose nested title doubled the text) reads as "Q2". */
function undouble(text: string): string {
  if (text.length % 2 === 1) {
    const half = (text.length - 1) / 2;
    if (text[half] === ' ' && text.slice(0, half) === text.slice(half + 1)) return text.slice(0, half);
  }
  return text;
}

function titleText(html: string): string | null {
  const start = html.indexOf('<title>');
  if (start < 0) return null;
  const end = html.indexOf('</title>', start);
  if (end < 0 || end - start > MAX_NEEDLE * 3) return null;
  return unescapeHtml(html.slice(start + 7, end));
}

function extractSignals(selection: ElementSelection): Signals {
  const tagText = openingTag(selection.outerHTML.html);
  const attr = (name: string): string | null => clip(attribute(tagText, name));
  const classes = (attribute(tagText, 'class') ?? '').split(/\s+/);
  let series = attr('data-series');
  let category = attr('data-category');
  const rawText = selection.redacted ? '' : undouble(selection.textAnchor.text.replace(/\s+/g, ' ').trim());
  const fromTitle = titleText(selection.outerHTML.html) ?? (rawText.includes(' / ') && rawText.includes(': ') ? rawText : null);
  const marks = selection.tag === 'rect' || selection.tag === 'circle';
  let titleForm = false;
  if (marks && fromTitle && (series === null || category === null)) {
    const split = fromTitle.indexOf(' / ');
    const colon = fromTitle.lastIndexOf(': ');
    if (split > 0 && colon > split) {
      titleForm = true;
      series = series ?? clip(fromTitle.slice(0, split));
      category = category ?? clip(fromTitle.slice(split + 3, colon));
    }
  }
  const dataChart = attr('data-chart');
  const idSources = [selection.selector, ...selection.selectorAlternates, ...selection.ancestors.map(a => a.id ?? ''), attribute(tagText, 'id') ?? ''].filter(Boolean);
  if (selection.tag === 'text' && classes.includes('tick-x') && category === null) category = clip(rawText);
  let cell: Signals['cell'] = null;
  if (selection.tag === 'td' || selection.tag === 'th') {
    const row = /tr:nth-of-type\((\d{1,4})\)/.exec(selection.selector);
    const col = /(td|th):nth-of-type\((\d{1,4})\)/.exec(selection.selector);
    if (col) cell = { row: row ? Number(row[1]) : 1, col: Number(col[2]), header: col[1] === 'th', thead: selection.selector.includes('thead') };
  }
  const inChart = dataChart !== null || series !== null || category !== null || titleForm
    || idSources.some(source => source.includes('chart-')) || selection.selector.includes('figure')
    || selection.ancestors.some(a => a.tag === 'figure' || a.classes.some(c => CHART_CLASSES.includes(c)));
  return { dataChart, idSources, series, category, field: attr('data-report-field'), text: clip(rawText), cell, inChart };
}

// ---- hint search -----------------------------------------------------------------------------

const rank: Record<DatumConfidence, number> = { high: 0, med: 1, low: 2 };
const ID_CHAR = /[A-Za-z0-9_]/;

/** True when `rest` (text following "chart-") names `key`, optionally followed by one -svg / -t id suffix. */
function matchesKey(rest: string, key: string): boolean {
  if (!rest.startsWith(key)) return false;
  const after = rest.slice(key.length);
  if (after === '' || (!ID_CHAR.test(after[0]) && after[0] !== '-')) return true;
  for (const suffix of ['-svg', '-t']) {
    if (after.startsWith(suffix) && (after.length === suffix.length || !/[A-Za-z0-9_-]/.test(after[suffix.length]))) return true;
  }
  return false;
}

/** The chart block this pick belongs to: data-chart exactly, else a known key named by a chart-<key>[-svg|-t] id. */
function resolveBlock(blocks: readonly Block[], signals: Signals): { block: Block | undefined; strong: boolean } {
  if (signals.dataChart !== null) {
    const exact = blocks.find(block => block.key === signals.dataChart);
    if (exact) return { block: exact, strong: true };
  }
  const candidates: Block[] = [];
  for (const source of signals.idSources) {
    let at = source.indexOf('chart-');
    while (at >= 0 && candidates.length < 16) {
      const rest = source.slice(at + 6);
      for (const block of blocks) if (matchesKey(rest, block.key) && !candidates.includes(block)) candidates.push(block);
      at = source.indexOf('chart-', at + 6);
    }
  }
  if (candidates.length <= 1) return { block: candidates[0], strong: false };
  // Ambiguous ids (for example the svg of "revenue" and the figure "revenue-svg"): longest key first, then prefer
  // the block that actually holds the series or category being picked.
  candidates.sort((a, b) => b.key.length - a.key.length);
  const holds = (block: Block) => (signals.series !== null && block.seriesNames.some(e => e.value === signals.series))
    || (signals.category !== null && block.categories.some(e => e.value === signals.category));
  return { block: candidates.find(holds) ?? candidates[0], strong: false };
}

export function findReportHints(files: readonly ReportFile[], selection: ElementSelection, options: ReportHintOptions = {}): { file: string; hint: DatumHint }[] {
  try {
    const out: { file: string; hint: DatumHint }[] = [];
    // Only files that mention `charts` can be report data; filter before applying the file cap.
    const candidates = files.filter(file => file.lines.some(line => line.includes('charts'))).slice(0, MAX_REPORT_FILES);
    if (candidates.length === 0) return out;
    const signals = extractSignals(selection);
    for (const file of candidates) {
      const model = parseReportData(file.lines, options.deadline);
      if (!model) continue;
      const push = (entry: { line: number; col: number }, confidence: DatumConfidence) => out.push({ file: file.name, hint: { lineIndex: entry.line, col: entry.col, confidence } });
      hintsFromModel(model, signals, push);
    }
    return out.sort((a, b) => rank[a.hint.confidence] - rank[b.hint.confidence]);
  } catch {
    return [];
  }
}

function hintsFromModel(model: DataModel, signals: Signals, push: (entry: { line: number; col: number }, confidence: DatumConfidence) => void): void {
  const { blocks } = model;
  const { block: keyed, strong } = resolveBlock(blocks, signals);
  const inScope = keyed ? [keyed] : blocks;
  let anyDatum = false;

  if (signals.field) {
    const entry = model.fields.get(signals.field);
    if (entry) { push(entry, 'high'); anyDatum = true; }
  }

  // A figure pick: the chart's own block.
  if (keyed && strong) { push(keyed, 'high'); anyDatum = true; }

  const seriesNeedle = signals.series;
  const categoryNeedle = signals.category;
  // Text-only matching is only trusted where the pick is plausibly part of a chart; prose that happens to equal a
  // series or category name is a weak (low) lead, ranked after the file-local matches.
  const generic = !signals.field && !seriesNeedle && !categoryNeedle && !signals.cell ? signals.text : null;
  const genericTrusted = signals.inChart;

  const seriesHits = (needle: string) => inScope.flatMap(block => block.seriesNames.filter(e => e.value === needle).map(e => ({ block, entry: e })));
  const categoryHits = (needle: string) => inScope.flatMap(block => block.categories.filter(e => e.value === needle).map(e => ({ block, entry: e })));

  const sHits = seriesNeedle ? seriesHits(seriesNeedle) : generic ? seriesHits(generic) : [];
  const cHits = categoryNeedle ? categoryHits(categoryNeedle) : generic ? categoryHits(generic) : [];

  // When both a series and a category are known and exactly one block holds both, that block is the chart.
  let pairBlock: Block | undefined = keyed;
  if (!pairBlock && seriesNeedle && categoryNeedle) {
    const both = blocks.filter(block => block.seriesNames.some(e => e.value === seriesNeedle) && block.categories.some(e => e.value === categoryNeedle));
    if (both.length === 1) pairBlock = both[0];
  }
  const confidence = (hits: { block: Block }[], pair: Block | undefined): DatumConfidence => {
    if (generic && !genericTrusted) return 'low';
    if (pair) return 'high';
    return hits.length === 1 ? 'med' : 'low';
  };
  const scoped = <T extends { block: Block }>(hits: T[]): T[] => (pairBlock ? hits.filter(h => h.block === pairBlock) : hits);

  const sUse = scoped(sHits);
  const cUse = scoped(cHits);
  if (seriesNeedle || generic) {
    for (const hit of sUse.slice(0, MAX_HINTS_PER_KIND)) {
      const high = pairBlock || (generic && genericTrusted && sUse.length === 1);
      push(hit.entry, generic && !genericTrusted ? 'low' : high ? 'high' : confidence(sUse, undefined));
      anyDatum = true;
    }
  }
  if (categoryNeedle || (generic && sHits.length === 0)) {
    for (const hit of cUse.slice(0, MAX_HINTS_PER_KIND)) {
      push(hit.entry, confidence(cUse, pairBlock));
      anyDatum = true;
    }
  }

  // Table cell: body cells map row to the category and column to the series; a header cell names a series.
  if (signals.cell && keyed) {
    const { row, col, header, thead } = signals.cell;
    if (thead) {
      const series = keyed.seriesNames[col - 2];
      if (series) { push(series, 'med'); anyDatum = true; }
    } else {
      const category = keyed.categories[row - 1];
      const series = header ? undefined : keyed.seriesNames[col - 1];
      if (series) { push(series, 'med'); anyDatum = true; }
      if (category) { push(category, 'med'); anyDatum = true; }
    }
  } else if (signals.cell && !signals.cell.header && signals.text) {
    const number = firstNumber(signals.text);
    if (number !== null) {
      let shown = 0;
      for (const block of inScope) {
        for (const value of block.values) {
          if (value.n === number && shown < MAX_HINTS_PER_KIND) { push(value, 'low'); shown++; anyDatum = true; }
        }
      }
    }
  }

  // The chart block is context for any datum found inside it.
  if (anyDatum && !strong && (!generic || genericTrusted)) {
    const block = pairBlock ?? (sUse.length === 1 ? sUse[0].block : cUse.length === 1 ? cUse[0].block : undefined);
    if (block) push(block, 'med');
  }
}

/** First number in a formatted cell such as "$95k", "-5" or "1,330", sign included, or null. */
function firstNumber(text: string): number | null {
  let digits = '';
  let seen = false;
  let negative = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (/[0-9]/.test(char)) { digits += char; seen = true; negative = negative || (digits.length === 1 && i > 0 && text[i - 1] === '-'); }
    else if (seen && char === ',') continue;
    else if (seen && char === '.') digits += char;
    else if (seen) break;
  }
  const n = Number(digits);
  return seen && Number.isFinite(n) ? (negative ? -n : n) : null;
}
