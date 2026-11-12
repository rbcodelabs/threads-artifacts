import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeHostTheme } from '../src/hostTheme';
import { REPORT_JS, reportCss, reportDataJs, reportHtml } from '../src/reportTemplate';
import { findSourceHints, MAX_FILE_BYTES } from '../src/sourceHints';
import { validRequest } from './helpers/feedbackFixtures';

/**
 * Golden picks taken from the Phase 1 QA run on a report-mode artifact
 * (Runs/threads-design-2026-11-11-picker-on-report-mode-qa.md, R2/R3). The data.js line numbers below are the
 * scaffold's own (see reportDataJs): title 4, revenue block 8, categories 12, Product B 16, headcount 20,
 * categories 23, End of year 26, trend 29, categories 32, Web 35.
 */

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'td-rep-'));
  await write('index.html', reportHtml());
  await write('styles.css', reportCss(normalizeHostTheme('dark', {})));
  await write('report.js', REPORT_JS);
  await write('data.js', reportDataJs());
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

const write = (name: string, content: string) => fs.writeFile(path.join(root, name), content);

interface Pick {
  tag: string;
  html: string;
  text?: string;
  selector: string;
  ancestors?: { tag: string; id: string | null; classes: string[] }[];
}

function selectionFor(pick: Pick) {
  const base = validRequest().selection as any;
  return {
    ...base,
    tag: pick.tag,
    selector: pick.selector,
    selectorAlternates: [],
    textAnchor: { tag: pick.tag, text: pick.text ?? '' },
    landmark: null,
    outerHTML: { html: pick.html, truncated: false },
    ancestors: pick.ancestors ?? [],
    a11y: { role: null, name: null, tabIndex: null },
  };
}

const hintsFor = (pick: Pick) => findSourceHints(root, selectionFor(pick));
const at = (hints: { file: string; line: number }[], file: string, line: number) => hints.findIndex(h => h.file === file && h.line === line);
const svgAncestors = (key: string) => [
  { tag: 'svg', id: `chart-${key}-svg`, classes: ['chart-svg'] },
  { tag: 'div', id: null, classes: ['chart-scroll'] },
  { tag: 'figure', id: `chart-${key}`, classes: ['chart'] },
];

const bar: Pick = {
  tag: 'rect',
  html: '<rect class="bar s1" data-series="Product B" data-category="Q2" x="190.0" y="100.0" width="79.0" height="59.0"><title>Product B / Q2: $95k</title></rect>',
  text: 'Product B / Q2: $95k',
  selector: '#chart-revenue-svg > rect:nth-of-type(5)',
  ancestors: svgAncestors('revenue'),
};
const groupedBar: Pick = {
  tag: 'rect',
  html: '<rect class="bar s1" data-series="End of year" data-category="Engineering" x="1" y="2" width="69" height="193"><title>End of year / Engineering: 31</title></rect>',
  text: 'End of year / Engineering: 31',
  selector: '#chart-headcount-svg > rect:nth-of-type(4)',
  ancestors: svgAncestors('headcount'),
};
const point: Pick = {
  tag: 'circle',
  html: '<circle class="pt s0" data-series="Web" data-category="W3" cx="1" cy="2" r="4"><title>Web / W3: 1,330</title></circle>',
  text: 'Web / W3: 1,330',
  selector: '#chart-trend-svg > circle:nth-of-type(3)',
  ancestors: svgAncestors('trend'),
};
const segment: Pick = {
  tag: 'polyline',
  html: '<polyline class="line s0" data-series="Web" points="1,2 3,4"><title>Web</title></polyline>',
  text: 'Web',
  selector: '#chart-trend-svg > polyline:nth-of-type(1)',
  ancestors: svgAncestors('trend'),
};
const xTick: Pick = {
  tag: 'text',
  html: '<text class="tick-x" data-category="Q2" x="1" y="2">Q2</text>',
  text: 'Q2',
  selector: '#chart-revenue-svg > text:nth-of-type(7)',
  ancestors: svgAncestors('revenue'),
};
const legendLabel: Pick = {
  tag: 'li',
  html: '<li class="s1" data-series="Product B"><span class="swatch" data-series="Product B" aria-hidden="true"></span>Product B</li>',
  text: 'Product B',
  selector: '#chart-revenue > ul > li:nth-of-type(2)',
  ancestors: [{ tag: 'ul', id: null, classes: ['legend'] }, { tag: 'figure', id: 'chart-revenue', classes: ['chart'] }],
};
const swatch: Pick = {
  tag: 'span',
  html: '<span class="swatch" data-series="Product B" aria-hidden="true"></span>',
  selector: '#chart-revenue > ul > li:nth-of-type(2) > span',
  ancestors: [{ tag: 'li', id: null, classes: ['s1'] }, { tag: 'ul', id: null, classes: ['legend'] }, { tag: 'figure', id: 'chart-revenue', classes: ['chart'] }],
};
const h1: Pick = { tag: 'h1', html: '<h1 data-report-field="title">Report title</h1>', text: 'Report title', selector: 'body > header > h1' };
const paragraph: Pick = {
  tag: 'p',
  html: '<p>Placeholder summary. Replace this paragraph with the findings, most important first.</p>',
  text: 'Placeholder summary. Replace this paragraph with the findings, most important first.',
  selector: '#content > section:nth-of-type(1) > p',
};
const tableCell: Pick = {
  tag: 'td',
  html: '<td>$95k</td>',
  text: '$95k',
  selector: '#chart-revenue > div:nth-of-type(2) > table > tbody > tr:nth-of-type(2) > td:nth-of-type(2)',
  ancestors: [{ tag: 'tr', id: null, classes: [] }, { tag: 'tbody', id: null, classes: [] }, { tag: 'table', id: null, classes: ['chart-table'] }],
};
const figure: Pick = {
  tag: 'figure',
  html: '<figure class="chart" id="chart-revenue" data-chart="revenue"><figcaption><strong>Quarterly revenue by product (sample)</strong></figcaption>',
  text: 'Quarterly revenue by product (sample) Synthetic sample numbers.',
  selector: '#chart-revenue',
};

describe('chart-mark-aware source hints (H1), scaffold with ids and data attributes', () => {
  it('stacked bar: the series line then the categories line in data.js, ahead of any css', async () => {
    const hints = await hintsFor(bar);
    expect(hints[0]).toMatchObject({ file: 'data.js', line: 16, confidence: 'high' });
    expect(hints[0].snippet).toContain("name: 'Product B'");
    expect(hints[1]).toMatchObject({ file: 'data.js', line: 12, confidence: 'high' });
    expect(at(hints, 'data.js', 8)).toBeGreaterThan(-1); // the chart block
    expect(hints.length).toBeLessThanOrEqual(5);
    const firstCss = hints.findIndex(h => h.file === 'styles.css');
    if (firstCss >= 0) expect(firstCss).toBeGreaterThan(at(hints, 'data.js', 12));
  });

  it('grouped bar', async () => {
    const hints = await hintsFor(groupedBar);
    expect(hints[0]).toMatchObject({ file: 'data.js', line: 26, confidence: 'high' });
    expect(hints[1]).toMatchObject({ file: 'data.js', line: 23, confidence: 'high' });
    expect(at(hints, 'data.js', 20)).toBeGreaterThan(-1);
  });

  it('line point', async () => {
    const hints = await hintsFor(point);
    expect(hints[0]).toMatchObject({ file: 'data.js', line: 35, confidence: 'high' });
    expect(hints[1]).toMatchObject({ file: 'data.js', line: 32, confidence: 'high' });
    expect(at(hints, 'data.js', 29)).toBeGreaterThan(-1);
  });

  it('line segment (polyline): the series name, no category', async () => {
    const hints = await hintsFor(segment);
    expect(hints[0]).toMatchObject({ file: 'data.js', line: 35, confidence: 'high' });
    expect(at(hints, 'data.js', 32)).toBe(-1);
    expect(at(hints, 'data.js', 29)).toBeGreaterThan(-1);
  });

  it('x tick label: the categories entry', async () => {
    const hints = await hintsFor(xTick);
    expect(hints[0]).toMatchObject({ file: 'data.js', line: 12, confidence: 'high' });
    expect(hints[0].snippet).toContain("'Q2'");
  });

  it('legend label and swatch: the series name in data.js ranks above the .s1 css rule', async () => {
    for (const pick of [legendLabel, swatch]) {
      const hints = await hintsFor(pick);
      expect(hints[0]).toMatchObject({ file: 'data.js', line: 16, confidence: 'high' });
      const css = hints.findIndex(h => h.file === 'styles.css');
      if (css >= 0) expect(css).toBeGreaterThan(0);
    }
  });

  it('H1 with data-report-field: the data.js key first, then the static html', async () => {
    const hints = await hintsFor(h1);
    expect(hints[0]).toMatchObject({ file: 'data.js', line: 4, confidence: 'high' });
    expect(hints[0].snippet).toContain('title:');
    expect(at(hints, 'index.html', 13)).toBeGreaterThan(0);
  });

  it('paragraph: static prose stays in index.html, no data.js hint', async () => {
    const hints = await hintsFor(paragraph);
    expect(hints[0].file).toBe('index.html');
    expect(hints.some(h => h.file === 'data.js')).toBe(false);
  });

  it('table cell: maps row and column to the category and series entries', async () => {
    const hints = await hintsFor(tableCell);
    expect(hints[0]).toMatchObject({ file: 'data.js', line: 16 });
    expect(['high', 'med']).toContain(hints[0].confidence);
    expect(at(hints, 'data.js', 12)).toBeGreaterThan(-1);
  });

  it('whole figure: the chart block in data.js', async () => {
    const hints = await hintsFor(figure);
    expect(hints[0]).toMatchObject({ file: 'data.js', line: 8, confidence: 'high' });
    expect(hints[0].snippet).toContain('revenue');
    expect(at(hints, 'index.html', 26)).toBeGreaterThan(-1); // the figure's own id in index.html
  });

  it('y tick label: computed by the chart code, so no data.js datum is invented', async () => {
    const hints = await hintsFor({ tag: 'text', html: '<text class="tick-y" x="1" y="2">$200k</text>', text: '$200k', selector: '#chart-revenue-svg > text:nth-of-type(3)', ancestors: svgAncestors('revenue') });
    expect(hints.some(h => h.file === 'data.js')).toBe(false);
  });
});

describe('older report artifacts (no ids, no data attributes, duplicated tick title)', () => {
  const positional = '#content > section:nth-of-type(2) > figure > div:nth-of-type(1) > svg > rect:nth-of-type(5)';

  it('bar: splits the "series / category: value" anchor and still finds both entries', async () => {
    const hints = await hintsFor({ tag: 'rect', html: '<rect class="bar s1" x="1" y="2" width="3" height="4"><title>Product B / Q2: $95k</title></rect>', text: 'Product B / Q2: $95k', selector: positional });
    expect(hints[0]).toMatchObject({ file: 'data.js', line: 16, confidence: 'high' });
    expect(hints[1]).toMatchObject({ file: 'data.js', line: 12 });
  });

  it('x tick with the old doubled anchor "Q2 Q2"', async () => {
    const hints = await hintsFor({ tag: 'text', html: '<text class="tick-x" x="1" y="2">Q2<title>Q2</title></text>', text: 'Q2 Q2', selector: '#content > section:nth-of-type(2) > figure > div:nth-of-type(1) > svg > text:nth-of-type(7)' });
    expect(hints[0]).toMatchObject({ file: 'data.js', line: 12 });
  });

  it('legend label: the series name, not the .s0/.s1 css rule, comes first', async () => {
    const hints = await hintsFor({ tag: 'li', html: '<li class="s1"><span class="swatch" aria-hidden="true"></span>Product B</li>', text: 'Product B', selector: '#content > section:nth-of-type(2) > figure > ul > li:nth-of-type(2)' });
    expect(hints[0]).toMatchObject({ file: 'data.js', line: 16, confidence: 'high' });
  });

  it('table cell without ids falls back to the number in a values array, low confidence', async () => {
    const hints = await hintsFor({ ...tableCell, selector: '#content > section:nth-of-type(2) > figure > div:nth-of-type(2) > table > tbody > tr:nth-of-type(2) > td:nth-of-type(2)', ancestors: [] });
    const hit = hints.find(h => h.file === 'data.js' && h.line === 16);
    expect(hit).toBeDefined();
    expect(hit!.confidence).toBe('low');
  });
});

describe('data.js formatting variety', () => {
  const sel = (series: string, category: string) => selectionFor({
    tag: 'rect', html: `<rect class="bar s0" data-series="${series}" data-category="${category}" x="1"><title>${series} / ${category}: 1</title></rect>`, text: `${series} / ${category}: 1`, selector: '#chart-sales-svg > rect:nth-of-type(1)', ancestors: svgAncestors('sales'),
  });

  it('double quotes, quoted keys, tabs and CRLF', async () => {
    await write('data.js', ['window.REPORT_DATA = {', '\t"charts": {', '\t\t"sales": {', '\t\t\t"categories": ["North", "South"],', '\t\t\t"series": [', '\t\t\t\t{ "name": "Gadgets", "values": [1, 2] }', '\t\t\t]', '\t\t}', '\t}', '};'].join('\r\n'));
    const hints = await findSourceHints(root, sel('Gadgets', 'South'));
    expect(hints[0]).toMatchObject({ file: 'data.js', line: 6, confidence: 'high' });
    expect(hints[1]).toMatchObject({ file: 'data.js', line: 4 });
  });

  it('opening brace on the next line and a multi-line categories array', async () => {
    await write('data.js', ['window.REPORT_DATA = {', '  charts:', '  {', '    sales:', '    {', '      categories: [', "        'North',", "        'South'", '      ],', '      series: [', "        { name: 'Gadgets', values: [1, 2] }", '      ]', '    }', '  }', '};'].join('\n'));
    const hints = await findSourceHints(root, sel('Gadgets', 'South'));
    expect(hints[0]).toMatchObject({ file: 'data.js', line: 11, confidence: 'high' });
    expect(hints[1]).toMatchObject({ file: 'data.js', line: 8 });
  });

  it('a minified single-line data file', async () => {
    await write('data.js', "window.REPORT_DATA={charts:{sales:{categories:['North','South'],series:[{name:'Gadgets',values:[1,2]}]}}};");
    const hints = await findSourceHints(root, sel('Gadgets', 'South'));
    expect(hints[0]).toMatchObject({ file: 'data.js', line: 1 });
    expect(hints[0].snippet).toContain('Gadgets');
  });

  it('a data.json style file with a charts key', async () => {
    await write('data.js', '');
    await write('report-data.json', JSON.stringify({ charts: { sales: { categories: ['North', 'South'], series: [{ name: 'Gadgets', values: [1, 2] }] } } }, null, 2));
    const hints = await findSourceHints(root, sel('Gadgets', 'South'));
    expect(hints.some(h => h.file === 'report-data.json')).toBe(true);
  });

  it('names with apostrophes and escapes match their escaped literal', async () => {
    await write('data.js', ["window.REPORT_DATA = {", "  charts: { sales: {", "    categories: ['Q1'],", "    series: [{ name: 'Men\\'s', values: [1] }]", "  } }", "};"].join('\n'));
    const hints = await findSourceHints(root, sel("Men's", 'Q1'));
    expect(hints[0]).toMatchObject({ file: 'data.js', line: 4 });
  });

  it('two charts sharing a series name: the chart key from the figure id disambiguates', async () => {
    await write('data.js', ['window.REPORT_DATA = { charts: {', '  one: {', "    categories: ['A'],", "    series: [{ name: 'Same', values: [1] }]", '  },', '  sales: {', "    categories: ['A'],", "    series: [{ name: 'Same', values: [2] }]", '  }', '} };'].join('\n'));
    const hints = await findSourceHints(root, sel('Same', 'A'));
    expect(hints[0]).toMatchObject({ file: 'data.js', line: 8, confidence: 'high' });
    expect(hints.some(h => h.file === 'data.js' && h.line === 4 && h.confidence === 'high')).toBe(false);
  });
});

describe('hostile and unusual needles', () => {
  it('regex metacharacters in names never throw or over-match', async () => {
    const name = 'a.b(c*+?^${}|[] d';
    await write('data.js', `window.REPORT_DATA = { charts: { sales: {\n categories: ['Q.1'],\n series: [{ name: ${JSON.stringify(name)}, values: [1] }]\n} } };\n`);
    const hints = await findSourceHints(root, selectionFor({
      tag: 'rect', html: `<rect data-series=${JSON.stringify(name)} data-category="Q.1"><title>x</title></rect>`, text: `${name} / Q.1: 1`, selector: '#chart-sales-svg > rect', ancestors: svgAncestors('sales'),
    }));
    expect(hints[0]).toMatchObject({ file: 'data.js', line: 3 });
    const noMatch = await findSourceHints(root, selectionFor({ tag: 'rect', html: '<rect data-series=".*" data-category="Q.*"></rect>', text: '.* / Q.*: 1', selector: '#a', ancestors: svgAncestors('sales') }));
    expect(noMatch.some(h => h.file === 'data.js' && h.line === 3)).toBe(false);
  });

  it('huge, multi-line and backtick needles finish quickly and produce bounded output', async () => {
    const huge = 'x'.repeat(200_000);
    const started = Date.now();
    const hints = await findSourceHints(root, selectionFor({
      tag: 'rect', html: `<rect data-series="${huge}" data-category="line1\nline2\`"><title>${huge}</title></rect>`, text: `${huge} / ${huge}: 1`, selector: '#chart-revenue-svg > rect', ancestors: svgAncestors('revenue'),
    }));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(hints.length).toBeLessThanOrEqual(5);
    expect(hints.every(h => h.snippet.length <= 200)).toBe(true);
  });

  it('a needle that is a prefix of many entries does not match partial literals', async () => {
    await write('data.js', ["window.REPORT_DATA = { charts: { sales: {", " categories: ['Product'],", " series: [{ name: 'Product B', values: [1] }]", "} } };"].join('\n'));
    const hints = await findSourceHints(root, selectionFor({ tag: 'li', html: '<li data-series="Prod"></li>', text: 'Prod', selector: '#chart-sales > ul > li', ancestors: [{ tag: 'figure', id: 'chart-sales', classes: [] }] }));
    expect(hints.some(h => h.file === 'data.js' && h.confidence !== 'low')).toBe(false);
  });
});

describe('bounded work and containment', () => {
  it('a 50k-line data file finishes quickly and only the first chunk is scanned', async () => {
    const lines = ['window.REPORT_DATA = { charts: { sales: {', " categories: ['Q1'],", ' series: ['];
    for (let i = 0; i < 50_000; i++) lines.push(`  { name: 'Filler ${i}', values: [${i}] },`);
    lines.push("  { name: 'Late series', values: [1] }", '] } } };');
    const content = lines.join('\n');
    expect(content.length).toBeGreaterThan(MAX_FILE_BYTES);
    await write('data.js', content);
    const started = Date.now();
    const hints = await findSourceHints(root, selectionFor({ ...bar, html: '<rect data-series="Late series" data-category="Q1"></rect>', text: '', ancestors: svgAncestors('sales') }));
    expect(Date.now() - started).toBeLessThan(3000);
    expect(hints.some(h => h.snippet.includes('Late series'))).toBe(false);
  });

  it('many name lines are capped to the ranked top five', async () => {
    const lines = ['window.REPORT_DATA = { charts: { sales: {', " categories: ['Q1'],", ' series: ['];
    for (let i = 0; i < 2000; i++) lines.push("  { name: 'Dup', values: [1] },");
    lines.push('] } } };');
    await write('data.js', lines.join('\n'));
    const hints = await findSourceHints(root, selectionFor({ ...bar, html: '<rect data-series="Dup" data-category="Q1"></rect>', text: '', ancestors: svgAncestors('sales') }));
    expect(hints.length).toBeLessThanOrEqual(5);
  });

  it('ignores a symlinked data.js and data files in subdirectories', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'td-rep-out-'));
    try {
      await fs.rm(path.join(root, 'data.js'));
      await fs.writeFile(path.join(outside, 'data.js'), reportDataJs());
      await fs.symlink(path.join(outside, 'data.js'), path.join(root, 'data.js'));
      await fs.mkdir(path.join(root, 'sub'));
      await fs.writeFile(path.join(root, 'sub', 'data.js'), reportDataJs());
      const hints = await hintsFor(bar);
      expect(hints.some(h => h.file === 'data.js' || h.file.startsWith('sub'))).toBe(false);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('adds nothing for artifacts that are not reports (no charts data file)', async () => {
    await write('data.js', "window.APP_DATA = { users: [{ name: 'Product B' }] };\n");
    const hints = await hintsFor(legendLabel);
    expect(hints.some(h => h.file === 'data.js' && h.confidence !== 'low')).toBe(false);
  });
});
