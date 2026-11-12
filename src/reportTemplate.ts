import { normalizeHostTheme, type HostThemeMode, type HostThemeSnapshot } from './hostTheme';

/**
 * Scaffold for the `report` design mode: a document-style page with a small, dependency-free SVG
 * chart library. Everything is external, same-origin and static, because the artifact CSP blocks
 * inline script and network access. Numbers live in data.js (a script that sets
 * window.REPORT_DATA), so a data change never requires regenerating the page.
 *
 * Only synthetic placeholder numbers appear here; real figures belong in the vault artifact only.
 */

/** Categorical palette, eight slots, tuned separately for light and dark backgrounds. */
export const REPORT_PALETTE: Record<HostThemeMode, readonly string[]> = {
  light: ['#2563c9', '#d9731f', '#178f7e', '#a53d92', '#6b7a1a', '#c23b4e', '#5b5fc7', '#7a6a5a'],
  dark: ['#6ea0ff', '#f0a05c', '#4fd0bb', '#d98bcb', '#b5c75a', '#ff7f8e', '#9da0ff', '#b8a898'],
};

const oppositeMode = (mode: HostThemeMode): HostThemeMode => (mode === 'dark' ? 'light' : 'dark');

function tokenBlock(theme: HostThemeSnapshot, indent: string): string {
  const palette = REPORT_PALETTE[theme.mode].map((color, i) => `${indent}--c${i}: ${color};`).join('\n');
  return `${indent}color-scheme: ${theme.mode};
${indent}--bg: ${theme.background};
${indent}--text: ${theme.text};
${indent}--muted: ${theme.mutedText};
${indent}--accent: ${theme.accent};
${indent}--border: ${theme.border};
${indent}--font: ${theme.interfaceFont};
${palette}`;
}

export function reportHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Report</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <a class="skip" href="#content">Skip to report</a>
  <header class="report-head">
    <p class="eyebrow">Agent Threads &middot; Report</p>
    <h1 data-report-field="title">Report</h1>
    <p class="subtitle" data-report-field="subtitle"></p>
    <p class="byline" data-report-field="byline"></p>
  </header>
  <nav class="toc" aria-label="Contents" id="toc"></nav>
  <main id="content" class="report-body">
    <section aria-labelledby="summary">
      <h2 id="summary">Summary</h2>
      <p>Placeholder summary. Replace this paragraph with the findings, most important first.</p>
    </section>
    <section aria-labelledby="sample-revenue">
      <h2 id="sample-revenue">Sample stacked chart</h2>
      <p>Placeholder section using synthetic sample data from data.js.</p>
      <figure class="chart" id="chart-revenue" data-chart="revenue"></figure>
    </section>
    <section aria-labelledby="sample-headcount">
      <h2 id="sample-headcount">Sample grouped chart</h2>
      <figure class="chart" id="chart-headcount" data-chart="headcount"></figure>
    </section>
    <section aria-labelledby="sample-trend">
      <h2 id="sample-trend">Sample line chart</h2>
      <figure class="chart" id="chart-trend" data-chart="trend"></figure>
    </section>
    <section aria-labelledby="assumptions">
      <h2 id="assumptions">Assumptions and caveats</h2>
      <ul>
        <li>List every assumption and data limitation here.</li>
      </ul>
    </section>
  </main>
  <script src="data.js"></script>
  <script src="report.js"></script>
</body>
</html>
`;
}

export function reportCss(theme: HostThemeSnapshot): string {
  const other = normalizeHostTheme(oppositeMode(theme.mode), {});
  return `/* Tokens come from the host theme captured at creation; prefers-color-scheme swaps to the other palette. */
:root {
${tokenBlock(theme, '  ')}
}
@media (prefers-color-scheme: ${other.mode}) {
  :root {
${tokenBlock(other, '    ')}
  }
}
* { box-sizing: border-box; }
html { background: var(--bg); }
body { margin: 0 auto; max-width: 860px; padding: clamp(20px, 5vw, 56px); color: var(--text); background: var(--bg); font-family: var(--font); font-size: 16px; line-height: 1.6; }
.skip { position: absolute; left: -999px; }
.skip:focus { left: 8px; top: 8px; padding: 6px 10px; background: var(--bg); border: 1px solid var(--accent); }
.eyebrow { margin: 0; color: var(--accent); font-size: 11px; font-weight: 600; letter-spacing: .12em; text-transform: uppercase; }
h1 { margin: 8px 0 4px; font-size: clamp(26px, 5vw, 36px); line-height: 1.15; letter-spacing: -.02em; }
h2 { margin: 2.2em 0 .5em; font-size: 22px; line-height: 1.25; scroll-margin-top: 16px; }
h3 { margin: 1.6em 0 .4em; font-size: 17px; }
.subtitle { margin: 0 0 6px; color: var(--muted); font-size: 18px; }
.byline { margin: 0; color: var(--muted); font-size: 13px; }
.toc { margin: 28px 0 0; padding: 14px 18px; border: 1px solid var(--border); border-radius: 10px; }
.toc:empty { display: none; }
.toc ol { margin: 0; padding-left: 1.2em; }
.toc a { color: var(--accent); }
a { color: var(--accent); }
a:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
p, ul, ol { margin: .7em 0; }
table { width: 100%; border-collapse: collapse; font-size: 14px; font-variant-numeric: tabular-nums; }
caption { text-align: left; color: var(--muted); padding-bottom: 6px; }
th, td { padding: 6px 10px; border-bottom: 1px solid var(--border); text-align: right; }
th:first-child, td:first-child { text-align: left; }
thead th { color: var(--muted); font-weight: 600; }
.table-scroll { overflow-x: auto; }
figure.chart { margin: 1.4em 0; }
figure.chart figcaption { margin-bottom: 8px; }
figure.chart figcaption strong { display: block; font-size: 15px; }
figure.chart figcaption span { color: var(--muted); font-size: 13px; }
.chart-scroll, .table-scroll { overflow-x: auto; }
.chart-scroll:focus-visible, .table-scroll:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.chart-svg { display: block; width: 100%; height: auto; }
.chart-svg text { fill: var(--muted); font-family: var(--font); font-size: 12px; }
.chart-svg .grid { stroke: var(--border); stroke-width: 1; }
.chart-svg .axis { stroke: var(--muted); stroke-width: 1; }
.chart-svg .tick-y { text-anchor: end; }
.chart-svg .tick-x { text-anchor: middle; }
.chart-svg .bar { fill: var(--c); }
.chart-svg .bar:hover { opacity: .8; }
.chart-svg .line { fill: none; stroke: var(--c); stroke-width: 2.5; stroke-linejoin: round; stroke-linecap: round; }
.chart-svg .pt { fill: var(--c); stroke: var(--bg); stroke-width: 1.5; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 16px; margin: 0 0 8px; padding: 0; list-style: none; font-size: 13px; }
.legend li { display: flex; align-items: center; gap: 6px; }
.swatch { width: 12px; height: 12px; border-radius: 3px; background: var(--c); }
.s0 { --c: var(--c0); } .s1 { --c: var(--c1); } .s2 { --c: var(--c2); } .s3 { --c: var(--c3); }
.s4 { --c: var(--c4); } .s5 { --c: var(--c5); } .s6 { --c: var(--c6); } .s7 { --c: var(--c7); }
.chart-table { margin-top: 10px; }
.chart-error { padding: 10px 14px; border: 1px dashed var(--border); border-radius: 8px; color: var(--muted); }
@media (max-width: 520px) {
  /* The chart keeps a readable width and scrolls sideways; 640 / 720 scale makes 14 user units about 12px. */
  .chart-svg { min-width: 640px; }
  .chart-svg text { font-size: 14px; }
  table { font-size: 12px; }
  th, td { padding: 4px 6px; }
}
@media print {
  :root { color-scheme: light; --bg: #ffffff; --text: #1f2328; --muted: #57606a; --border: #d0d7de; --accent: #0b57d0;
${REPORT_PALETTE.light.map((color, i) => `    --c${i}: ${color};`).join('\n')} }
  body { max-width: none; padding: 0; }
  .toc, .skip { display: none; }
  figure.chart, table { break-inside: avoid; }
}
`;
}

/** Synthetic placeholder data; the agent replaces this file's contents with the report's real data. */
export function reportDataJs(): string {
  return `// Single source of truth for report numbers. index.html holds the prose; edit this file for data changes.
// Chart types: "stacked-bar", "grouped-bar", "line". Optional format: { prefix, suffix, decimals }.
window.REPORT_DATA = {
  title: 'Report title',
  subtitle: 'One-line description of what this report covers',
  byline: 'Sample data shown until the report is written',
  charts: {
    revenue: {
      type: 'stacked-bar',
      title: 'Quarterly revenue by product (sample)',
      caption: 'Synthetic sample numbers.',
      categories: ['Q1', 'Q2', 'Q3', 'Q4'],
      format: { prefix: '$', suffix: 'k', decimals: 0 },
      series: [
        { name: 'Product A', values: [120, 135, 150, 170] },
        { name: 'Product B', values: [80, 95, 90, 110] },
        { name: 'Product C', values: [40, 45, 60, 65] }
      ]
    },
    headcount: {
      type: 'grouped-bar',
      title: 'Headcount by team (sample)',
      categories: ['Design', 'Engineering', 'Support'],
      series: [
        { name: 'Start of year', values: [8, 24, 12] },
        { name: 'End of year', values: [10, 31, 15] }
      ]
    },
    trend: {
      type: 'line',
      title: 'Weekly active users (sample)',
      categories: ['W1', 'W2', 'W3', 'W4', 'W5', 'W6'],
      format: { decimals: 0 },
      series: [
        { name: 'Web', values: [1200, 1260, 1330, 1310, 1420, 1500] },
        { name: 'Mobile', values: [900, 980, 1050, 1180, 1240, 1390] }
      ]
    }
  }
};
`;
}

/**
 * Chart library and page wiring. Pure string building (no DOM) for the SVG part, so it is testable
 * in Node; DOM wiring only runs when a document exists. Written without template literals or
 * backslashes so it embeds safely in this TypeScript string.
 */
export const REPORT_JS = `/* Dependency-free SVG charts for report mode. Reads window.REPORT_DATA from data.js. */
(function () {
  'use strict';
  var W = 720, H = 360, M = { top: 14, right: 16, bottom: 44, left: 64 };
  var SLOTS = 8;

  function esc(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function num(value) { return typeof value === 'number' && isFinite(value) ? value : 0; }
  function round(value) { return parseFloat(value.toPrecision(12)); }
  function trimZeros(text) { return text.indexOf('.') >= 0 ? text.replace(/0+$/, '').replace(/[.]$/, '') : text; }

  function fmt(value, format, compact) {
    format = format || {};
    var decimals = format.decimals == null ? 0 : format.decimals;
    var abs = Math.abs(value), body, unit = '';
    if (compact && /^ *(k|m|mm|b|bn|thousand|million|billion)([^a-z]|$)/i.test(format.suffix || '')) { compact = false; }
    if (compact && abs >= 1e9) { body = trimZeros((abs / 1e9).toFixed(1)); unit = 'B'; }
    else if (compact && abs >= 1e6) { body = trimZeros((abs / 1e6).toFixed(1)); unit = 'M'; }
    else if (compact && abs >= 1e4) { body = trimZeros((abs / 1e3).toFixed(1)); unit = 'k'; }
    else { body = abs.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }); }
    var negative = value < 0 && ((compact && abs >= 1e4) || Number(abs.toFixed(decimals)) !== 0);
    return (negative ? '-' : '') + (format.prefix || '') + body + unit + (format.suffix || '');
  }

  function niceScale(min, max) {
    if (!(max > min)) { max = min + 1; }
    var raw = (max - min) / 5;
    var mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var ratio = raw / mag;
    var step = (ratio <= 1 ? 1 : ratio <= 2 ? 2 : ratio <= 5 ? 5 : 10) * mag;
    var lo = round(Math.floor(min / step) * step), hi = round(Math.ceil(max / step) * step);
    var ticks = [];
    for (var v = lo; v <= hi + step / 2; v += step) { ticks.push(round(v)); }
    var decimals = 0;
    while (decimals < 6 && Math.abs(step * Math.pow(10, decimals) - Math.round(step * Math.pow(10, decimals))) > 1e-9) { decimals += 1; }
    return { lo: lo, hi: hi, ticks: ticks, step: step, decimals: decimals };
  }

  function seriesOf(spec) {
    var list = Array.isArray(spec.series) ? spec.series : [];
    var count = Array.isArray(spec.categories) ? spec.categories.length : 0;
    return list.map(function (s, i) {
      var values = [];
      for (var k = 0; k < count; k++) { values.push(num(s && s.values ? s.values[k] : 0)); }
      return { name: String(s && s.name != null ? s.name : 'Series ' + (i + 1)), values: values, slot: i % SLOTS };
    });
  }

  function domain(spec, series) {
    var count = spec.categories.length, lo = 0, hi = 0, first = true;
    for (var k = 0; k < count; k++) {
      var pos = 0, neg = 0;
      for (var i = 0; i < series.length; i++) {
        var v = series[i].values[k];
        if (spec.type === 'stacked-bar') { if (v >= 0) { pos += v; } else { neg += v; } }
        else if (first) { lo = v; hi = v; first = false; }
        else { lo = Math.min(lo, v); hi = Math.max(hi, v); }
      }
      if (spec.type === 'stacked-bar') { lo = Math.min(lo, neg); hi = Math.max(hi, pos); }
    }
    if (spec.type !== 'line') { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
    return niceScale(lo, hi);
  }

  function tip(series, category, value, format) {
    return '<title>' + esc(series + ' / ' + category + ': ' + fmt(value, format, false)) + '</title>';
  }

  function renderChartSvg(spec, id) {
    var categories = spec.categories.map(String);
    var series = seriesOf(spec);
    var scale = domain(spec, series);
    var plotW = W - M.left - M.right, plotH = H - M.top - M.bottom;
    var band = plotW / Math.max(categories.length, 1);
    var tickFormat = {};
    for (var key in (spec.format || {})) { tickFormat[key] = spec.format[key]; }
    tickFormat.decimals = Math.max(tickFormat.decimals == null ? 0 : tickFormat.decimals, scale.decimals);
    function y(v) { return M.top + plotH * (1 - (v - scale.lo) / (scale.hi - scale.lo)); }
    function cx(k) { return M.left + band * (k + 0.5); }
    var out = [];
    var label = (spec.title || 'Chart') + '. ' + series.length + ' series across ' + categories.length + ' categories.';
    out.push('<svg class="chart-svg" id="' + esc(id) + '-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-labelledby="' + esc(id) + '-t">');
    out.push('<title id="' + esc(id) + '-t">' + esc(label) + '</title>');
    scale.ticks.forEach(function (t) {
      out.push('<line class="grid" x1="' + M.left + '" x2="' + (W - M.right) + '" y1="' + y(t).toFixed(1) + '" y2="' + y(t).toFixed(1) + '"/>');
      out.push('<text class="tick-y" x="' + (M.left - 8) + '" y="' + (y(t) + 4).toFixed(1) + '">' + esc(fmt(t === 0 ? 0 : t, tickFormat, true)) + '</text>');
    });
    var stride = Math.ceil(categories.length / 10);
    categories.forEach(function (name, k) {
      if (k % stride !== 0) { return; }
      var shortened = name.length > 14;
      var shown = shortened ? name.slice(0, 13) + '...' : name;
      // The tick text is its own label. A title (hover tooltip) exists only when the visible text was shortened, so the
      // full name stays reachable and a label shown in full is never doubled in its accessible name.
      out.push('<text class="tick-x" data-category="' + esc(name) + '" x="' + cx(k).toFixed(1) + '" y="' + (H - M.bottom + 20) + '">' + esc(shown) + (shortened ? '<title>' + esc(name) + '</title>' : '') + '</text>');
    });
    var axisY = Math.min(Math.max(y(0), M.top), M.top + plotH).toFixed(1);
    out.push('<line class="axis" x1="' + M.left + '" x2="' + (W - M.right) + '" y1="' + axisY + '" y2="' + axisY + '"/>');

    if (spec.type === 'stacked-bar') {
      var barW = band * 0.6;
      categories.forEach(function (name, k) {
        var up = 0, down = 0;
        series.forEach(function (s) {
          var v = s.values[k];
          if (v === 0) { return; }
          var from = v > 0 ? up : down, to = from + v;
          if (v > 0) { up = to; } else { down = to; }
          var top = y(Math.max(from, to)), height = Math.abs(y(from) - y(to));
          out.push('<rect class="bar s' + s.slot + '" data-series="' + esc(s.name) + '" data-category="' + esc(name) + '" x="' + (cx(k) - barW / 2).toFixed(1) + '" y="' + top.toFixed(1) + '" width="' + barW.toFixed(1) + '" height="' + height.toFixed(1) + '">' + tip(s.name, name, v, spec.format) + '</rect>');
        });
      });
    } else if (spec.type === 'grouped-bar') {
      var groupW = band * 0.8, each = groupW / Math.max(series.length, 1);
      categories.forEach(function (name, k) {
        series.forEach(function (s, i) {
          var v = s.values[k];
          var top = y(Math.max(v, 0)), height = Math.abs(y(v) - y(0));
          out.push('<rect class="bar s' + s.slot + '" data-series="' + esc(s.name) + '" data-category="' + esc(name) + '" x="' + (cx(k) - groupW / 2 + each * i + 1).toFixed(1) + '" y="' + top.toFixed(1) + '" width="' + Math.max(each - 2, 1).toFixed(1) + '" height="' + height.toFixed(1) + '">' + tip(s.name, name, v, spec.format) + '</rect>');
        });
      });
    } else {
      series.forEach(function (s) {
        var points = s.values.map(function (v, k) { return cx(k).toFixed(1) + ',' + y(v).toFixed(1); });
        out.push('<polyline class="line s' + s.slot + '" data-series="' + esc(s.name) + '" points="' + points.join(' ') + '"><title>' + esc(s.name) + '</title></polyline>');
        s.values.forEach(function (v, k) {
          out.push('<circle class="pt s' + s.slot + '" data-series="' + esc(s.name) + '" data-category="' + esc(categories[k]) + '" cx="' + cx(k).toFixed(1) + '" cy="' + y(v).toFixed(1) + '" r="4">' + tip(s.name, categories[k], v, spec.format) + '</circle>');
        });
      });
    }
    out.push('</svg>');
    return out.join('');
  }

  function renderTable(spec, series) {
    var stacked = spec.type === 'stacked-bar';
    var head = '<th scope="col">' + esc(spec.categoryLabel || 'Category') + '</th>' + series.map(function (s) { return '<th scope="col">' + esc(s.name) + '</th>'; }).join('') + (stacked ? '<th scope="col">Total</th>' : '');
    var rows = spec.categories.map(function (name, k) {
      var total = 0;
      var cells = series.map(function (s) { total += s.values[k]; return '<td>' + esc(fmt(s.values[k], spec.format, false)) + '</td>'; }).join('');
      return '<tr><th scope="row">' + esc(name) + '</th>' + cells + (stacked ? '<td>' + esc(fmt(total, spec.format, false)) + '</td>' : '') + '</tr>';
    }).join('');
    return '<div class="table-scroll" tabindex="0" role="region" aria-label="' + esc('Data table: ' + (spec.title || 'chart')) + '"><table class="chart-table"><caption>Data for: ' + esc(spec.title || 'chart') + '</caption><thead><tr>' + head + '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  function renderFigure(spec, id) {
    var known = spec && (spec.type === 'stacked-bar' || spec.type === 'grouped-bar' || spec.type === 'line');
    if (!known || !Array.isArray(spec.categories) || !Array.isArray(spec.series)) {
      return '<p class="chart-error">Chart "' + esc(id) + '" is missing or invalid in data.js (type must be stacked-bar, grouped-bar or line, with categories and series).</p>';
    }
    var series = seriesOf(spec);
    var legend = '<ul class="legend">' + series.map(function (s) { return '<li class="s' + s.slot + '" data-series="' + esc(s.name) + '"><span class="swatch" data-series="' + esc(s.name) + '" aria-hidden="true"></span>' + esc(s.name) + '</li>'; }).join('') + '</ul>';
    var caption = '<figcaption><strong>' + esc(spec.title || '') + '</strong>' + (spec.caption ? '<span>' + esc(spec.caption) + '</span>' : '') + '</figcaption>';
    var scroller = '<div class="chart-scroll" tabindex="0" role="region" aria-label="' + esc('Chart: ' + (spec.title || id)) + '">' + renderChartSvg(spec, id) + '</div>';
    return caption + legend + scroller + renderTable(spec, series);
  }

  var api = { renderChartSvg: renderChartSvg, renderFigure: renderFigure, renderTable: renderTable, niceScale: niceScale, format: fmt, escape: esc };
  window.ReportCharts = api;

  function slug(text, used) {
    var base = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'section';
    var id = base, n = 2;
    while (used[id]) { id = base + '-' + n; n += 1; }
    used[id] = true;
    return id;
  }

  function init() {
    var data = window.REPORT_DATA || {};
    Array.prototype.forEach.call(document.querySelectorAll('[data-report-field]'), function (el) {
      var value = data[el.getAttribute('data-report-field')];
      el.textContent = value == null ? '' : String(value);
    });
    if (data.title) { document.title = String(data.title); }
    Array.prototype.forEach.call(document.querySelectorAll('figure[data-chart]'), function (el) {
      var key = el.getAttribute('data-chart');
      if (!el.id) { el.id = 'chart-' + key; }
      el.innerHTML = renderFigure((data.charts || {})[key], 'chart-' + key);
    });
    var toc = document.getElementById('toc');
    if (toc) {
      var used = {};
      var items = [];
      Array.prototype.forEach.call(document.querySelectorAll('main h2'), function (h) {
        if (!h.id) { h.id = slug(h.textContent || '', used); } else { used[h.id] = true; }
        items.push('<li><a href="#' + esc(h.id) + '">' + esc(h.textContent || '') + '</a></li>');
      });
      toc.innerHTML = items.length > 1 ? '<ol>' + items.join('') + '</ol>' : '';
    }
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); } else { init(); }
  }
})();
`;
