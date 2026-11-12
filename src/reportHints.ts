import type { ElementSelection } from './geodeArtifactFeedback';

/**
 * Chart-mark-aware source hints for report-mode artifacts (spec 13d, QA findings R3/B1).
 *
 * In a report the numbers live in data.js (window.REPORT_DATA) and report.js draws the SVG, so a
 * picked bar, point, legend label or table cell has no source of its own: the datum is the source.
 * This module finds that datum. It tokenizes the data file once (strings, identifiers, punctuation;
 * no regex is ever built from page text) and compares page-controlled needles to string-literal
 * VALUES by plain equality, so no needle can cause backtracking or over-matching.
 */

export type DatumConfidence = 'high' | 'med' | 'low';
export interface DatumHint { readonly lineIndex: number; readonly col: number; readonly confidence: DatumConfidence }
export interface ReportFile { readonly name: string; readonly lines: readonly string[] }

const MAX_NEEDLE = 200;
const MAX_TOKENS = 200_000;
const MAX_HINTS_PER_KIND = 2;

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
function tokenize(lines: readonly string[]): Token[] {
  const tokens: Token[] = [];
  let quote = '';
  let literal = '';
  let literalStart = { line: 0, col: 0 };
  let inBlockComment = false;
  for (let line = 0; line < lines.length && tokens.length < MAX_TOKENS; line++) {
    const text = lines[line].endsWith('\r') ? lines[line].slice(0, -1) : lines[line];
    for (let col = 0; col < text.length; col++) {
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
        literal += char;
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
        col = end - 1;
      }
    }
    // A string never spans lines except template literals; a dangling quote on a plain line is dropped.
    if (quote && quote !== '`') { quote = ''; literal = ''; }
    else if (quote) literal += '\n';
  }
  return tokens;
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
interface DataModel { readonly tokens: Token[]; readonly blocks: Block[]; readonly fields: Map<string, Entry> }

const isKey = (token: Token | undefined, name?: string): boolean => !!token && (token.kind === 'str' || token.kind === 'id') && (name === undefined || token.value === name);
const isPunct = (token: Token | undefined, char: string): boolean => !!token && token.kind === 'p' && token.value === char;

/** Index of the token closing the bracket opened at `open`, or the last token when unbalanced. */
function matching(tokens: readonly Token[], open: number): number {
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind !== 'p') continue;
    if (token.value === '{' || token.value === '[') depth++;
    else if (token.value === '}' || token.value === ']') { depth--; if (depth === 0) return i; }
  }
  return tokens.length - 1;
}

function readBlock(tokens: readonly Token[], keyIndex: number, openIndex: number, closeIndex: number): Block {
  const block: Block = { key: tokens[keyIndex].value, line: tokens[keyIndex].line, col: tokens[keyIndex].col, seriesNames: [], categories: [], values: [] };
  for (let i = openIndex; i < closeIndex; i++) {
    const token = tokens[i];
    if (isKey(token, 'name') && isPunct(tokens[i + 1], ':') && tokens[i + 2]?.kind === 'str') {
      block.seriesNames.push({ value: tokens[i + 2].value, line: tokens[i + 2].line, col: tokens[i + 2].col });
    } else if (isKey(token, 'categories') && isPunct(tokens[i + 1], ':') && isPunct(tokens[i + 2], '[')) {
      const end = matching(tokens, i + 2);
      for (let k = i + 3; k < end; k++) if (tokens[k].kind === 'str') block.categories.push({ value: tokens[k].value, line: tokens[k].line, col: tokens[k].col });
    } else if (isKey(token, 'values') && isPunct(tokens[i + 1], ':') && isPunct(tokens[i + 2], '[')) {
      const end = matching(tokens, i + 2);
      for (let k = i + 3; k < end; k++) {
        const n = Number(tokens[k].value);
        if (tokens[k].kind === 'id' && Number.isFinite(n)) block.values.push({ n, line: tokens[k].line, col: tokens[k].col });
      }
    }
  }
  return block;
}

/** Null when the file has no `charts: { ... }` object, i.e. it is not report data. */
export function parseReportData(lines: readonly string[]): DataModel | null {
  const tokens = tokenize(lines);
  const chartsAt = tokens.findIndex((token, i) => isKey(token, 'charts') && isPunct(tokens[i + 1], ':') && isPunct(tokens[i + 2], '{'));
  if (chartsAt < 0) return null;
  const chartsEnd = matching(tokens, chartsAt + 2);
  const blocks: Block[] = [];
  for (let i = chartsAt + 3; i < chartsEnd; i++) {
    if (isKey(tokens[i]) && isPunct(tokens[i + 1], ':') && isPunct(tokens[i + 2], '{')) {
      const end = matching(tokens, i + 2);
      blocks.push(readBlock(tokens, i, i + 2, end));
      i = end;
    }
  }
  const fields = new Map<string, Entry>();
  for (let i = 0; i < chartsAt; i++) {
    if (isKey(tokens[i]) && isPunct(tokens[i + 1], ':') && !fields.has(tokens[i].value)) {
      fields.set(tokens[i].value, { value: tokens[i].value, line: tokens[i].line, col: tokens[i].col });
    }
  }
  return { tokens, blocks, fields };
}

// ---- signals from the pick -------------------------------------------------------------------

interface Signals {
  chartKey: string | null;
  strongKey: boolean;
  series: string | null;
  category: string | null;
  field: string | null;
  text: string | null;
  cell: { row: number; col: number; header: boolean } | null;
}

const clip = (text: string | null): string | null => (text && text.length > 0 && text.length <= MAX_NEEDLE ? text : null);

function unescapeHtml(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
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

/** Chart key from the ids the scaffold gives the figure and svg (chart-<key>, chart-<key>-svg, chart-<key>-t). */
function keyFromId(text: string): string | null {
  const at = text.indexOf('chart-');
  if (at < 0) return null;
  let end = at + 6;
  while (end < text.length && /[A-Za-z0-9_-]/.test(text[end])) end++;
  let key = text.slice(at + 6, end);
  for (const suffix of ['-svg', '-t']) if (key.endsWith(suffix) && key.length > suffix.length) { key = key.slice(0, -suffix.length); break; }
  return key || null;
}

function extractSignals(selection: ElementSelection): Signals {
  const tagText = openingTag(selection.outerHTML.html);
  const attr = (name: string): string | null => clip(attribute(tagText, name));
  const classes = (attribute(tagText, 'class') ?? '').split(/\s+/);
  let series = attr('data-series');
  let category = attr('data-category');
  const dataChart = attr('data-chart');
  const rawText = selection.redacted ? '' : undouble(selection.textAnchor.text.replace(/\s+/g, ' ').trim());
  const fromTitle = titleText(selection.outerHTML.html) ?? (rawText.includes(' / ') && rawText.includes(': ') ? rawText : null);
  const marks = selection.tag === 'rect' || selection.tag === 'circle';
  if (marks && fromTitle && (series === null || category === null)) {
    const split = fromTitle.indexOf(' / ');
    const colon = fromTitle.lastIndexOf(': ');
    if (split > 0 && colon > split) {
      series = series ?? clip(fromTitle.slice(0, split));
      category = category ?? clip(fromTitle.slice(split + 3, colon));
    }
  }
  const idSources = [selection.selector, ...selection.selectorAlternates, ...selection.ancestors.map(a => a.id ?? ''), attribute(tagText, 'id') ?? ''];
  let chartKey = dataChart;
  const strongKey = dataChart !== null;
  for (const source of idSources) {
    if (chartKey !== null) break;
    const bracket = source.indexOf('data-chart="');
    chartKey = bracket >= 0 ? clip(source.slice(bracket + 12).split('"')[0]) : keyFromId(source);
  }
  const isTick = selection.tag === 'text' && classes.includes('tick-x');
  if (isTick && category === null) category = clip(rawText);
  let cell: Signals['cell'] = null;
  if (selection.tag === 'td' || selection.tag === 'th') {
    const row = /tr:nth-of-type\((\d{1,4})\)/.exec(selection.selector);
    const col = /(td|th):nth-of-type\((\d{1,4})\)/.exec(selection.selector);
    if (row && col) cell = { row: Number(row[1]), col: Number(col[2]), header: col[1] === 'th' };
  }
  return { chartKey, strongKey, series, category, field: attr('data-report-field'), text: clip(rawText), cell };
}

// ---- hint search -----------------------------------------------------------------------------

const rank: Record<DatumConfidence, number> = { high: 0, med: 1, low: 2 };

export function findReportHints(files: readonly ReportFile[], selection: ElementSelection): { file: string; hint: DatumHint }[] {
  const out: { file: string; hint: DatumHint }[] = [];
  let signals: Signals | null = null;
  for (const file of files.slice(0, 4)) {
    const model = parseReportData(file.lines);
    if (!model) continue;
    signals = signals ?? extractSignals(selection);
    const push = (entry: { line: number; col: number }, confidence: DatumConfidence) => out.push({ file: file.name, hint: { lineIndex: entry.line, col: entry.col, confidence } });
    hintsFromModel(model, signals, push);
  }
  return out.sort((a, b) => rank[a.hint.confidence] - rank[b.hint.confidence]);
}

function hintsFromModel(model: DataModel, signals: Signals, push: (entry: { line: number; col: number }, confidence: DatumConfidence) => void): void {
  const { blocks } = model;
  const keyed = signals.chartKey === null ? undefined : blocks.find(block => block.key === signals.chartKey);
  const inScope = keyed ? [keyed] : blocks;
  let anyDatum = false;

  if (signals.field) {
    const entry = model.fields.get(signals.field);
    if (entry) { push(entry, 'high'); anyDatum = true; }
  }

  // A figure pick: the chart's own block.
  if (keyed && signals.strongKey) { push(keyed, 'high'); anyDatum = true; }

  const seriesNeedle = signals.series;
  const categoryNeedle = signals.category;
  const generic = !signals.field && !seriesNeedle && !categoryNeedle && !signals.cell ? signals.text : null;

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
    if (pair) return 'high';
    return hits.length === 1 ? 'med' : 'low';
  };
  const scoped = <T extends { block: Block }>(hits: T[]): T[] => (pairBlock ? hits.filter(h => h.block === pairBlock) : hits);

  const sUse = scoped(sHits);
  const cUse = scoped(cHits);
  if (seriesNeedle || generic) {
    for (const hit of sUse.slice(0, MAX_HINTS_PER_KIND)) {
      push(hit.entry, pairBlock || (generic && sUse.length === 1) ? 'high' : confidence(sUse, undefined));
      anyDatum = true;
    }
  }
  if (categoryNeedle || (generic && sHits.length === 0)) {
    for (const hit of cUse.slice(0, MAX_HINTS_PER_KIND)) {
      push(hit.entry, confidence(cUse, pairBlock));
      anyDatum = true;
    }
  }

  // Table cell: row selects the category, column the series.
  if (signals.cell && keyed) {
    const { row, col, header } = signals.cell;
    const category = keyed.categories[row - 1];
    const series = header ? undefined : keyed.seriesNames[col - 1];
    if (series) { push(series, 'med'); anyDatum = true; }
    if (category) { push(category, 'med'); anyDatum = true; }
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
  if (anyDatum && !signals.strongKey) {
    const block = pairBlock ?? (sUse.length === 1 ? sUse[0].block : cUse.length === 1 ? cUse[0].block : undefined);
    if (block) push(block, 'med');
  }
}

/** First number in a formatted cell such as "$95k" or "1,330", or null. */
function firstNumber(text: string): number | null {
  let digits = '';
  let seen = false;
  for (const char of text) {
    if (/[0-9]/.test(char)) { digits += char; seen = true; }
    else if (seen && (char === ',')) continue;
    else if (seen && char === '.') digits += char;
    else if (seen) break;
  }
  const n = Number(digits);
  return seen && Number.isFinite(n) ? n : null;
}
