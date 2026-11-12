import * as vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { REPORT_JS, REPORT_PALETTE, reportCss, reportDataJs, reportHtml } from '../src/reportTemplate';
import { normalizeHostTheme } from '../src/hostTheme';

interface ChartApi {
  renderChartSvg(spec: unknown, id: string): string;
  renderFigure(spec: unknown, id: string): string;
  niceScale(min: number, max: number): { lo: number; hi: number; ticks: number[] };
  format(value: number, format?: unknown, compact?: boolean): string;
}

function loadApi(): ChartApi {
  const sandbox = { window: {} as { ReportCharts?: ChartApi } };
  vm.runInNewContext(REPORT_JS, sandbox);
  return sandbox.window.ReportCharts!;
}

const stacked = {
  type: 'stacked-bar', title: 'Cash by year', categories: ['2026', '2027'], format: { prefix: '$', decimals: 0 },
  series: [{ name: 'Salary', values: [100, 110] }, { name: 'Bonus', values: [20, 30] }],
};
const grouped = { ...stacked, type: 'grouped-bar', title: 'Grouped' };
const line = { ...stacked, type: 'line', title: 'Trend' };

describe('report chart library', () => {
  const api = loadApi();

  it('renders one rect per series per category for stacked bars, with value tooltips', () => {
    const svg = api.renderChartSvg(stacked, 'c1');
    expect(svg.match(/<rect /g)).toHaveLength(4);
    expect(svg).toContain('<title>Salary / 2026: $100</title>');
    expect(svg).toContain('<title>Bonus / 2027: $30</title>');
    expect(svg).toContain('role="img"');
    expect(svg).toContain('class="bar s0"');
    expect(svg).toContain('class="bar s1"');
  });

  it('stacks the second series on top of the first', () => {
    const svg = api.renderChartSvg({ ...stacked, categories: ['A'], series: [{ name: 'S', values: [50] }, { name: 'T', values: [50] }] }, 'c');
    const ys = [...svg.matchAll(/<rect [^>]*y="([\d.]+)" [^>]*height="([\d.]+)"/g)].map(m => [Number(m[1]), Number(m[2])]);
    expect(ys).toHaveLength(2);
    expect(ys[1][0] + ys[1][1]).toBeCloseTo(ys[0][0], 0);
  });

  it('renders side-by-side bars for grouped charts at the same baseline', () => {
    const svg = api.renderChartSvg(grouped, 'c2');
    const rects = [...svg.matchAll(/<rect [^>]*x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)];
    expect(rects).toHaveLength(4);
    const [first, second] = rects.map(m => ({ x: Number(m[1]), y: Number(m[2]), height: Number(m[4]) }));
    expect(second.x).toBeGreaterThan(first.x);
    expect(first.y + first.height).toBeCloseTo(second.y + second.height, 0);
  });

  it('renders a polyline and one point per value for line charts', () => {
    const svg = api.renderChartSvg(line, 'c3');
    expect(svg.match(/<polyline /g)).toHaveLength(2);
    expect(svg.match(/<circle /g)).toHaveLength(4);
  });

  it('wraps the chart with a legend and a data table fallback including totals for stacked', () => {
    const html = api.renderFigure(stacked, 'chart-revenue');
    expect(html).toContain('<ul class="legend">');
    expect(html).toContain('<table class="chart-table">');
    expect(html).toContain('<th scope="col">Total</th>');
    expect(html).toContain('<td>$120</td>');
    expect(html).toContain('<td>$140</td>');
    expect(api.renderFigure(grouped, 'g')).not.toContain('Total');
  });

  it('escapes titles, series names, categories and ids', () => {
    const hostile = { ...stacked, title: '<script>x</script>', categories: ['<b>"A"</b>', 'B'], series: [{ name: '</title><img src=x>', values: [1, 2] }] };
    const html = api.renderFigure(hostile, '"><x');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&quot;&gt;&lt;x');
  });

  it('degrades to a visible message for a missing or malformed spec instead of throwing', () => {
    expect(api.renderFigure(undefined, 'nope')).toContain('chart-error');
    expect(api.renderFigure({ type: 'pie', categories: [], series: [] }, 'nope')).toContain('chart-error');
  });

  it('handles empty series, ragged values, negatives and all-zero data', () => {
    expect(() => api.renderFigure({ ...stacked, series: [] }, 'e')).not.toThrow();
    expect(() => api.renderFigure({ ...stacked, series: [{ name: 'a', values: [1] }] }, 'r')).not.toThrow();
    expect(() => api.renderFigure({ ...grouped, series: [{ name: 'a', values: [0, 0] }] }, 'z')).not.toThrow();
    const neg = api.renderChartSvg({ ...stacked, series: [{ name: 'a', values: [-5, 10] }] }, 'n');
    expect(neg).not.toContain('NaN');
    expect(api.renderChartSvg({ ...line, series: [{ name: 'a', values: [Number.NaN, 3] }] }, 'x')).not.toContain('NaN');
  });

  it('builds nice axis ticks and formats numbers', () => {
    const scale = api.niceScale(0, 137);
    expect(scale.lo).toBe(0);
    expect(scale.hi).toBeGreaterThanOrEqual(137);
    expect(scale.ticks[0]).toBe(0);
    expect(api.format(1234.5, { prefix: '$', decimals: 1 }, false)).toBe('$1,234.5');
    expect(api.format(2500000, { prefix: '$' }, true)).toBe('$2.5M');
    expect(api.format(-40, { suffix: '%' }, false)).toBe('-40%');
  });
});

describe('report scaffold safety', () => {
  const files = { 'index.html': reportHtml(), 'styles.css': reportCss(normalizeHostTheme('dark', {})), 'report.js': REPORT_JS, 'data.js': reportDataJs() };

  it('has no inline script bodies and loads only same-folder scripts', () => {
    const scripts = [...files['index.html'].matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    expect(scripts.map(m => m[1].trim())).toEqual(['src="data.js"', 'src="report.js"']);
    for (const m of scripts) expect(m[2].trim()).toBe('');
    expect(files['index.html']).not.toMatch(/\son[a-z]+\s*=/i);
    expect(files['index.html'].indexOf('data.js')).toBeLessThan(files['index.html'].indexOf('report.js'));
  });

  it('contains no network access or remote resources', () => {
    for (const [name, content] of Object.entries(files)) {
      expect(content, name).not.toMatch(/https?:\/\//i);
      expect(content, name).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource|importScripts|@import|url\(/);
      expect(content, name).not.toMatch(/\beval\s*\(|new Function|document\.write/);
    }
  });

  it('ships synthetic sample data only, covering stacked, grouped and line charts', () => {
    const sandbox = { window: {} as { REPORT_DATA?: { charts: Record<string, { type: string }> } } };
    vm.runInNewContext(files['data.js'], sandbox);
    expect(Object.values(sandbox.window.REPORT_DATA!.charts).map(c => c.type).sort()).toEqual(['grouped-bar', 'line', 'stacked-bar']);
    expect(files['data.js']).toMatch(/sample/i);
  });

  it('defines every categorical color for both themes and the series classes', () => {
    expect(REPORT_PALETTE.light).toHaveLength(8);
    expect(REPORT_PALETTE.dark).toHaveLength(8);
    expect(new Set(REPORT_PALETTE.light).size).toBe(8);
    expect(new Set(REPORT_PALETTE.dark).size).toBe(8);
    const css = files['styles.css'];
    for (let i = 0; i < 8; i++) expect(css).toContain(`.s${i} { --c: var(--c${i}); }`);
    expect(css).toContain('@media (prefers-color-scheme: light)');
    expect(css).toContain('@media print');
  });

  it('keeps the page accessible: landmarks, skip link, contents and labelled sections', () => {
    const html = files['index.html'];
    expect(html).toContain('<main id="content"');
    expect(html).toContain('class="skip"');
    expect(html).toContain('aria-label="Contents"');
    expect(html).toContain('lang="en"');
  });
});

describe('report page wiring', () => {
  it('fills fields, renders figures from REPORT_DATA and builds the contents list', () => {
    const el = (attrs: Record<string, string>, extra: Record<string, unknown> = {}) => ({ getAttribute: (k: string) => attrs[k], textContent: '', innerHTML: '', id: '', ...extra });
    const title = el({ 'data-report-field': 'title' });
    const figure = el({ 'data-chart': 'a' });
    const missing = el({ 'data-chart': 'b' });
    const h2a = el({}, { textContent: 'Summary', id: 'summary' });
    const h2b = el({}, { textContent: 'Cash flow' });
    const toc = el({});
    const document = {
      readyState: 'complete', title: '',
      querySelectorAll: (sel: string) => sel === '[data-report-field]' ? [title] : sel === 'figure[data-chart]' ? [figure, missing] : [h2a, h2b],
      getElementById: (id: string) => id === 'toc' ? toc : null,
      addEventListener: () => undefined,
    };
    const window: Record<string, unknown> = { REPORT_DATA: { title: 'My Report', charts: { a: { type: 'line', title: 'T', categories: ['x'], series: [{ name: 's', values: [1] }] } } } };
    vm.runInNewContext(REPORT_JS, { window, document, Array });
    expect(title.textContent).toBe('My Report');
    expect(document.title).toBe('My Report');
    expect(figure.innerHTML).toContain('<svg');
    expect(missing.innerHTML).toContain('chart-error');
    expect(h2b.id).toBe('cash-flow');
    expect(toc.innerHTML).toContain('href="#summary"');
    expect(toc.innerHTML).toContain('href="#cash-flow"');
  });
});
