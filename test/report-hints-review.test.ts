import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeHostTheme } from '../src/hostTheme';
import { findReportHints } from '../src/reportHints';
import { REPORT_JS, reportCss, reportDataJs, reportHtml } from '../src/reportTemplate';
import { findSourceHints } from '../src/sourceHints';
import { validRequest } from './helpers/feedbackFixtures';

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'td-rev-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
const write = (name: string, content: string) => fs.writeFile(path.join(root, name), content);

interface Pick { tag: string; html: string; text?: string; selector?: string; ancestors?: { tag: string; id: string | null; classes: string[] }[] }
function selectionFor(pick: Pick) {
  const base = validRequest().selection as any;
  return {
    ...base, tag: pick.tag, selector: pick.selector ?? 'body > x', selectorAlternates: [], textAnchor: { tag: pick.tag, text: pick.text ?? '' }, landmark: null,
    outerHTML: { html: pick.html, truncated: false }, ancestors: pick.ancestors ?? [], a11y: { role: null, name: null, tabIndex: null },
  };
}
const hintsFor = (pick: Pick) => findSourceHints(root, selectionFor(pick));
const lineOf = (hints: { file: string; line: number }[], file: string, line: number) => hints.findIndex(h => h.file === file && h.line === line);
const svgAncestors = (id: string) => [{ tag: 'svg', id, classes: ['chart-svg'] }];

async function scaffold() {
  await write('index.html', reportHtml());
  await write('styles.css', reportCss(normalizeHostTheme('dark', {})));
  await write('report.js', REPORT_JS);
  await write('data.js', reportDataJs());
}

const barPick = (series: string, category: string, selector: string, ancestors?: Pick['ancestors']): Pick => ({
  tag: 'rect', html: `<rect class="bar s0" data-series="${series}" data-category="${category}" x="1"><title>${series} / ${category}: 1</title></rect>`, text: `${series} / ${category}: 1`, selector, ancestors,
});

describe('B1: pathological data files finish quickly and produce no data hints', () => {
  const probe = barPick('Salary', 'Q1', '#chart-a-svg > rect', svgAncestors('chart-a-svg'));
  const prefix = 'window.REPORT_DATA={charts:{a:{';
  const fill = (unit: string) => prefix + unit.repeat(Math.floor((250 * 1024 - prefix.length) / unit.length));

  const cases: [string, string][] = [
    ['unclosed values:[ x32k', fill('values:[')],
    ['unclosed categories:[ x21k', fill('categories:[')],
    ['properly nested values:[...] x32k', prefix + 'values:['.repeat(32000) + ']'.repeat(32000)],
    ['deeply nested brackets', prefix + 'values:' + '['.repeat(120000) + ']'.repeat(120000)],
    ['unterminated block comment', `${prefix}categories:['Z'],/* never closed ` + 'x'.repeat(200_000)],
    ['unterminated string', `${prefix}categories:['Q1' ` + `"never closed ` + 'x'.repeat(200_000)],
    ['unterminated template literal', `${prefix}series:[{name:\`never closed\n` + 'x\n'.repeat(100_000)],
    ['many unclosed objects', fill('{name:')],
  ];

  it.each(cases)('%s', async (_label, content) => {
    await write('data.js', content);
    const started = Date.now();
    const hints = await findSourceHints(root, selectionFor(probe));
    expect(Date.now() - started).toBeLessThan(1000);
    expect(hints.every(h => h.file !== 'data.js' || h.confidence === 'low')).toBe(true);
  });

  it('a 1 MB minified single line handed straight to the parser', () => {
    const line = prefix + "categories:['Q1'],series:[" + "{name:'Filler',values:[1]},".repeat(40_000) + "{name:'Salary',values:[1]}]}}};";
    expect(line.length).toBeGreaterThan(1_000_000);
    const started = Date.now();
    const hints = findReportHints([{ name: 'data.js', lines: [line] }], selectionFor(probe) as never);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(Array.isArray(hints)).toBe(true);
  });

  it('gives up cleanly when the deadline has already passed', () => {
    const started = Date.now();
    const hints = findReportHints([{ name: 'data.js', lines: reportDataJs().split('\n') }], selectionFor(probe) as never, { deadline: Date.now() - 1 });
    expect(hints).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('a well-formed data file is unaffected by the budget', async () => {
    await scaffold();
    const hints = await hintsFor(barPick('Product B', 'Q2', '#chart-revenue-svg > rect:nth-of-type(5)', svgAncestors('chart-revenue-svg')));
    expect(hints[0]).toMatchObject({ file: 'data.js', line: 16, confidence: 'high' });
  });
});

describe('A4/A3: candidate files are filtered before the file cap', () => {
  it('finds data.js even when four unrelated root .js files sort before it', async () => {
    await scaffold();
    for (const name of ['analysis.js', 'app.js', 'build.js', 'chart.js']) await write(name, `// ${name}\nvar x = 1;\n`);
    const hints = await hintsFor(barPick('Product B', 'Q2', '#chart-revenue-svg > rect:nth-of-type(5)', svgAncestors('chart-revenue-svg')));
    expect(hints[0]).toMatchObject({ file: 'data.js', line: 16 });
  });
});

describe('A1: prose that equals a series name is not a confident data hint', () => {
  it('ranks the real source above the data.js coincidence', async () => {
    await write('index.html', '<h2 id="intro">Salary</h2>\n');
    await write('data.js', "window.REPORT_DATA = { charts: { pay: {\n categories: ['Q1'],\n series: [{ name: 'Salary', values: [1] }]\n} } };\n");
    const hints = await hintsFor({ tag: 'h2', html: '<h2 id="intro">Salary</h2>', text: 'Salary', selector: '#intro' });
    expect(hints[0]).toMatchObject({ file: 'index.html', line: 1, confidence: 'high' });
    const datum = hints.find(h => h.file === 'data.js');
    if (datum) expect(datum.confidence).toBe('low');
  });

  it('the same for a paragraph that equals a category name', async () => {
    await write('index.html', '<p class="note">Q1</p>\n');
    await write('data.js', "window.REPORT_DATA = { charts: { pay: {\n categories: ['Q1'],\n series: [{ name: 'Salary', values: [1] }]\n} } };\n");
    const hints = await hintsFor({ tag: 'p', html: '<p class="note">Q1</p>', text: 'Q1', selector: 'body > p' });
    expect(hints[0].file).toBe('index.html');
    const datum = hints.find(h => h.file === 'data.js');
    if (datum) expect(datum.confidence).toBe('low');
  });

  it('keeps the confident hint for a legend label inside a figure (older reports)', async () => {
    await scaffold();
    const hints = await hintsFor({ tag: 'li', html: '<li class="s1"><span class="swatch" aria-hidden="true"></span>Product B</li>', text: 'Product B', selector: '#content > section:nth-of-type(2) > figure > ul > li:nth-of-type(2)' });
    expect(hints[0]).toMatchObject({ file: 'data.js', line: 16, confidence: 'high' });
  });
});

describe('A2: table header cells map to the series, not a category', () => {
  it('thead th maps column N to series N-1', async () => {
    await scaffold();
    const hints = await hintsFor({ tag: 'th', html: '<th scope="col">Product B</th>', text: 'Product B', selector: '#chart-revenue > div:nth-of-type(2) > table > thead > tr:nth-of-type(1) > th:nth-of-type(3)' });
    expect(hints[0]).toMatchObject({ file: 'data.js', line: 16 });
    expect(['high', 'med']).toContain(hints[0].confidence);
    expect(lineOf(hints, 'data.js', 12)).toBe(-1);
  });

  it('a tbody row header still maps to the category', async () => {
    await scaffold();
    const hints = await hintsFor({ tag: 'th', html: '<th scope="row">Q2</th>', text: 'Q2', selector: '#chart-revenue > div:nth-of-type(2) > table > tbody > tr:nth-of-type(2) > th:nth-of-type(1)' });
    expect(hints[0]).toMatchObject({ file: 'data.js', line: 12 });
    expect(lineOf(hints, 'data.js', 16)).toBe(-1);
  });
});

describe('A5: chart keys resolve against the known blocks', () => {
  const data = [
    'window.REPORT_DATA = { charts: {',
    "  'revenue': { categories: ['A'],",
    "    series: [{ name: 'S1', values: [1] }] },",
    "  'revenue-svg': { categories: ['A'],",
    "    series: [{ name: 'S2', values: [2] }] },",
    "  'my': { categories: ['A'],",
    "    series: [{ name: 'D1', values: [3] }] },",
    "  'my chart.v2': { categories: ['A'],",
    "    series: [{ name: 'D1', values: [4] }] },",
    "  'pay': { categories: ['A'],",
    "    series: [{ name: 'S4', values: [5] }] },",
    "  'pay-t': { categories: ['A'],",
    "    series: [{ name: 'S3', values: [6] }] }",
    '} };',
  ].join('\n');

  beforeEach(async () => { await write('data.js', data); });

  it('revenue vs revenue-svg: the series needle decides between the ambiguous ids', async () => {
    const s1 = await hintsFor(barPick('S1', 'A', '#chart-revenue-svg > rect:nth-of-type(1)'));
    expect(s1[0]).toMatchObject({ file: 'data.js', line: 3, confidence: 'high' });
    const s2 = await hintsFor(barPick('S2', 'A', '#chart-revenue-svg-svg > rect:nth-of-type(1)'));
    expect(s2[0]).toMatchObject({ file: 'data.js', line: 5, confidence: 'high' });
  });

  it('a key with a space and a dot does not truncate to the shorter chart', async () => {
    const hints = await hintsFor(barPick('D1', 'A', 'svg > rect', svgAncestors('chart-my chart.v2-svg')));
    expect(hints[0]).toMatchObject({ file: 'data.js', line: 9, confidence: 'high' });
    expect(lineOf(hints.filter(h => h.confidence === 'high'), 'data.js', 7)).toBe(-1);
  });

  it('pay-t is not stripped to pay', async () => {
    const hints = await hintsFor(barPick('S3', 'A', 'svg > rect', svgAncestors('chart-pay-t-svg')));
    expect(hints[0]).toMatchObject({ file: 'data.js', line: 13 });
  });

  it('survives data-chart="__proto__" with data-series="constructor" and leaves prototypes alone', async () => {
    await write('data.js', "window.REPORT_DATA = { charts: {\n '__proto__': { categories: ['A'],\n series: [{ name: 'constructor', values: [1] }] }\n} };\n");
    const hints = await hintsFor({ tag: 'rect', html: '<rect data-chart="__proto__" data-series="constructor" data-category="A"></rect>', selector: 'svg > rect' });
    expect(lineOf(hints, 'data.js', 3)).toBeGreaterThan(-1);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(Object.prototype)).toEqual([]);
  });
});

describe('A6: small ranking edges', () => {
  it('keeps the sign of a number: -5 does not match 5', async () => {
    await write('data.js', "window.REPORT_DATA = { charts: { net: {\n categories: ['Q1', 'Q2'],\n series: [{ name: 'Flow', values: [5, 7] }]\n} } };\n");
    const cell = { tag: 'td', html: '<td>-5</td>', text: '-5', selector: '#content > section > figure > div:nth-of-type(2) > table > tbody > tr:nth-of-type(1) > td:nth-of-type(1)' };
    expect((await hintsFor(cell)).some(h => h.file === 'data.js')).toBe(false);
    await write('data.js', "window.REPORT_DATA = { charts: { net: {\n categories: ['Q1', 'Q2'],\n series: [{ name: 'Flow', values: [-5, 7] }]\n} } };\n");
    expect((await hintsFor(cell)).some(h => h.file === 'data.js' && h.line === 3)).toBe(true);
  });

  it('a name key outside the series array does not shift the series index', async () => {
    await write('data.js', ['window.REPORT_DATA = { charts: {', '  sales: {', "    meta: { name: 'Meta' },", "    categories: ['Q1'],", '    series: [', "      { name: 'A', values: [1] },", "      { name: 'B', values: [2] }", '    ]', '  }', '} };'].join('\n'));
    const hints = await hintsFor({ tag: 'td', html: '<td>2</td>', text: '2', selector: '#chart-sales > div:nth-of-type(2) > table > tbody > tr:nth-of-type(1) > td:nth-of-type(2)' });
    expect(hints[0]).toMatchObject({ file: 'data.js', line: 7 });
    expect(lineOf(hints, 'data.js', 3)).toBe(-1);
  });

  it('finds a field placed after the charts block', async () => {
    await write('data.js', "window.REPORT_DATA = {\n  title: 'T',\n  charts: { a: { categories: ['A'], series: [{ name: 'S', values: [1] }] } },\n  byline: 'By someone'\n};\n");
    const hints = await hintsFor({ tag: 'p', html: '<p class="byline" data-report-field="byline">By someone</p>', text: 'By someone', selector: 'header > p' });
    expect(hints[0]).toMatchObject({ file: 'data.js', line: 4, confidence: 'high' });
  });

  it('ignores a nested title key when looking for the top-level field', async () => {
    await write('data.js', "window.REPORT_DATA = {\n  meta: { title: 'Nested' },\n  title: 'Real',\n  charts: { a: { categories: ['A'], series: [{ name: 'S', values: [1] }] } }\n};\n");
    const hints = await hintsFor({ tag: 'h1', html: '<h1 data-report-field="title">Real</h1>', text: 'Real', selector: 'h1' });
    expect(hints[0]).toMatchObject({ file: 'data.js', line: 3 });
  });
});

describe('A7: the top-five cap is exercised with more than five real candidates', () => {
  it('returns exactly five, best first, from many matching lines', async () => {
    await scaffold();
    await write('index.html', Array.from({ length: 12 }, () => '<h1 id="hero-title" class="title big" data-report-field="title">Report title</h1>').join('\n'));
    await write('styles.css', Array.from({ length: 6 }, () => '.title.big { color: red; }').join('\n'));
    const hints = await hintsFor({ tag: 'h1', html: '<h1 id="hero-title" class="title big" data-report-field="title">Report title</h1>', text: 'Report title', selector: '#hero-title' });
    expect(hints).toHaveLength(5);
    expect(hints[0]).toMatchObject({ file: 'data.js', line: 4, confidence: 'high' });
    const order = { high: 0, med: 1, low: 2 } as const;
    for (let i = 1; i < hints.length; i++) expect(order[hints[i].confidence]).toBeGreaterThanOrEqual(order[hints[i - 1].confidence]);
  });
});
