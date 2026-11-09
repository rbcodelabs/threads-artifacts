import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findSourceHints, MAX_FILE_BYTES } from '../src/sourceHints';
import { validRequest } from './helpers/feedbackFixtures';

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'td-hints-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

const write = (name: string, content: string) => fs.writeFile(path.join(root, name), content);

function selection(patch: Record<string, unknown> = {}) {
  const base = validRequest().selection as any;
  return { ...base, ...patch };
}

const html = [
  '<!doctype html>',
  '<html>',
  '<body>',
  '  <main>',
  '    <h1 id="hero-title" class="title big">Build faster</h1>',
  '    <p class="lede">Ship designs in minutes.</p>',
  '  </main>',
  '</body>',
  '</html>',
].join('\n');

describe('findSourceHints', () => {
  it('finds a unique id in html with high confidence and the right line', async () => {
    await write('index.html', html);
    const hints = await findSourceHints(root, selection());
    expect(hints[0]).toMatchObject({ file: 'index.html', line: 5, confidence: 'high' });
    expect(hints[0].snippet).toContain('hero-title');
  });

  it('ranks id above class above text, and lowers confidence for ambiguous matches', async () => {
    await write('index.html', ['<div class="card">a</div>', '<div class="card">b</div>', '<div class="card featured" data-x="1">Pricing card</div>'].join('\n'));
    await write('styles.css', '.card.featured { color: red; }\n#unrelated { color: blue; }\n');
    const hints = await findSourceHints(root, selection({
      tag: 'div',
      outerHTML: { html: '<div class="card featured" data-x="1">Pricing card</div>', truncated: false },
      textAnchor: { tag: 'div', text: 'Pricing card' },
    }));
    expect(hints[0]).toMatchObject({ file: 'index.html', line: 3, confidence: 'high' }); // unique class combination
    expect(hints.map(h => h.confidence)).toEqual([...hints.map(h => h.confidence)].sort((a, b) => ['high', 'med', 'low'].indexOf(a) - ['high', 'med', 'low'].indexOf(b)));
    expect(hints.some(h => h.file === 'styles.css' && h.line === 1 && h.confidence === 'med')).toBe(true);
  });

  it('downgrades a repeated id to medium', async () => {
    await write('index.html', '<h1 id="hero-title">a</h1>\n<h2 id="hero-title">b</h2>\n');
    const hints = await findSourceHints(root, selection());
    expect(hints.filter(h => h.file === 'index.html').every(h => h.confidence !== 'high')).toBe(true);
    expect(hints.length).toBeGreaterThanOrEqual(2);
  });

  it('falls back to text content when there is no id or class', async () => {
    await write('index.html', '<p>Ship designs in minutes.</p>\n');
    const hints = await findSourceHints(root, selection({
      tag: 'p',
      outerHTML: { html: '<p>Ship designs in minutes.</p>', truncated: false },
      textAnchor: { tag: 'p', text: 'Ship designs in minutes.' },
    }));
    expect(hints[0]).toMatchObject({ file: 'index.html', line: 1, confidence: 'med' });
  });

  it('labels hits that only exist in JavaScript-built DOM as low confidence', async () => {
    await write('index.html', '<div id="mount"></div>\n');
    await write('app.js', "const el = document.createElement('div');\nel.innerHTML = '<h1 id=\"hero-title\" class=\"title big\">Build faster</h1>';\n");
    const hints = await findSourceHints(root, selection());
    const js = hints.filter(h => h.file === 'app.js');
    expect(js.length).toBeGreaterThan(0);
    expect(js.every(h => h.confidence === 'low')).toBe(true);
    expect(js[0].line).toBe(2);
  });

  it('returns at most five hints', async () => {
    await write('index.html', Array.from({ length: 30 }, () => '<h1 id="hero-title" class="title big">Build faster</h1>').join('\n'));
    expect((await findSourceHints(root, selection())).length).toBeLessThanOrEqual(5);
  });

  it('skips the text step for redacted selections', async () => {
    await write('index.html', '<p>secret words here</p>\n');
    const hints = await findSourceHints(root, selection({
      redacted: true, tag: 'p',
      outerHTML: { html: '<p>...</p>', truncated: false },
      textAnchor: { tag: 'p', text: '' },
    }));
    expect(hints).toEqual([]);
  });

  it('handles regex metacharacters in ids and classes without throwing', async () => {
    await write('index.html', '<div id="a.b(c" class="x+y">hi there</div>\n');
    const hints = await findSourceHints(root, selection({
      tag: 'div',
      outerHTML: { html: '<div id="a.b(c" class="x+y">hi there</div>', truncated: false },
      textAnchor: { tag: 'div', text: 'hi there' },
    }));
    expect(hints[0]).toMatchObject({ file: 'index.html', line: 1 });
  });

  it('ignores symlinks, subdirectories, artifact.json and dotfiles', async () => {
    await fs.mkdir(path.join(root, 'sub'));
    await fs.writeFile(path.join(root, 'sub', 'page.html'), '<h1 id="hero-title">x</h1>');
    await write('artifact.json', '{"note":"hero-title"}');
    await write('.hidden.html', '<h1 id="hero-title">x</h1>');
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'td-hints-out-'));
    try {
      await fs.writeFile(path.join(outside, 'secret.html'), '<h1 id="hero-title">leak</h1>');
      await fs.symlink(path.join(outside, 'secret.html'), path.join(root, 'link.html'));
      expect(await findSourceHints(root, selection())).toEqual([]);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('bounds work: only the first chunk of a large file is scanned', async () => {
    const filler = `${'<p>filler</p>\n'.repeat(Math.ceil(MAX_FILE_BYTES / 14) + 100)}`;
    await write('index.html', `${filler}<h1 id="hero-title">late</h1>\n`);
    const started = Date.now();
    const hints = await findSourceHints(root, selection());
    expect(hints).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('copes with a minified single-line file and windows the snippet', async () => {
    await write('index.html', `<div>${'x'.repeat(5000)}<h1 id="hero-title">late</h1>${'y'.repeat(5000)}</div>`);
    const hints = await findSourceHints(root, selection());
    expect(hints[0].line).toBe(1);
    expect(hints[0].snippet.length).toBeLessThanOrEqual(200);
    expect(hints[0].snippet).toContain('hero-title');
  });

  it('returns [] for a missing root instead of throwing', async () => {
    expect(await findSourceHints(path.join(root, 'nope'), selection())).toEqual([]);
  });
});
