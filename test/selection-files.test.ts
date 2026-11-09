import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pruneSelections, SelectionFileError, writeSelectionFiles } from '../src/selectionFiles';
import { PNG_BYTES, SELECTION_ID } from './helpers/feedbackFixtures';

let base: string;
let root: string;
let outside: string;

beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'td-sel-')));
  root = path.join(base, 'artifact');
  outside = path.join(base, 'outside');
  await fs.mkdir(root);
  await fs.mkdir(outside);
});
afterEach(async () => { await fs.rm(base, { recursive: true, force: true }); });

const input = (overrides: Record<string, unknown> = {}) => ({ root, selectionId: SELECTION_ID, json: '{"ok":true}\n', png: PNG_BYTES, vaultRead: false, ...overrides });
const selectionsDir = () => path.join(root, '.threads-design', 'selections');

describe('writeSelectionFiles', () => {
  it('writes the json and png atomically under .threads-design/selections and returns absolute paths', async () => {
    const result = await writeSelectionFiles(input());
    expect(result.jsonPath).toBe(path.join(selectionsDir(), `${SELECTION_ID}.json`));
    expect(result.pngPath).toBe(path.join(selectionsDir(), `${SELECTION_ID}.png`));
    expect(await fs.readFile(result.jsonPath, 'utf8')).toBe('{"ok":true}\n');
    expect(new Uint8Array(await fs.readFile(result.pngPath!))).toEqual(PNG_BYTES);
    expect((await fs.readdir(selectionsDir())).sort()).toEqual([`${SELECTION_ID}.json`, `${SELECTION_ID}.png`]);
  });

  it('never writes a PNG for vault-read artifacts even when bytes are handed in', async () => {
    const result = await writeSelectionFiles(input({ vaultRead: true }));
    expect(result.pngPath).toBeNull();
    expect(await fs.readdir(selectionsDir())).toEqual([`${SELECTION_ID}.json`]);
  });

  it('writes no PNG when none is provided', async () => {
    const result = await writeSelectionFiles(input({ png: null }));
    expect(result.pngPath).toBeNull();
  });

  it('treats an existing file for the same id as a replay and never overwrites it', async () => {
    await writeSelectionFiles(input());
    const replay = await writeSelectionFiles(input({ json: '{"changed":true}', png: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9, 9, 9]) }));
    expect(replay.replay).toBe(true);
    expect(await fs.readFile(replay.jsonPath, 'utf8')).toBe('{"ok":true}\n');
    expect(new Uint8Array(await fs.readFile(replay.pngPath!))).toEqual(PNG_BYTES);
  });

  it('fills in a missing PNG on replay when the earlier attempt only wrote the json', async () => {
    await writeSelectionFiles(input({ png: null }));
    const second = await writeSelectionFiles(input());
    expect(second.pngPath).not.toBeNull();
    expect(await fs.readFile(second.pngPath!)).toHaveLength(PNG_BYTES.length);
  });

  it('rejects a symlinked .threads-design directory and writes nothing outside the root', async () => {
    await fs.symlink(outside, path.join(root, '.threads-design'));
    await expect(writeSelectionFiles(input())).rejects.toBeInstanceOf(SelectionFileError);
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it('rejects a symlinked selections directory', async () => {
    await fs.mkdir(path.join(root, '.threads-design'));
    await fs.symlink(outside, path.join(root, '.threads-design', 'selections'));
    await expect(writeSelectionFiles(input())).rejects.toBeInstanceOf(SelectionFileError);
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it('rejects a symlinked target file and leaves the victim untouched', async () => {
    await fs.mkdir(selectionsDir(), { recursive: true });
    const victim = path.join(outside, 'victim.txt');
    await fs.writeFile(victim, 'original');
    await fs.symlink(victim, path.join(selectionsDir(), `${SELECTION_ID}.json`));
    await expect(writeSelectionFiles(input())).rejects.toBeInstanceOf(SelectionFileError);
    expect(await fs.readFile(victim, 'utf8')).toBe('original');
  });

  it('rejects when .threads-design is a regular file', async () => {
    await fs.writeFile(path.join(root, '.threads-design'), 'x');
    await expect(writeSelectionFiles(input())).rejects.toBeInstanceOf(SelectionFileError);
  });

  it('rejects malformed selection ids before touching the filesystem', async () => {
    for (const id of ['../evil', 'sel_../../x', 'sel_0123', `${SELECTION_ID}/../x`, '', 'SEL_0123456789abcdef0123456789abcdef']) {
      await expect(writeSelectionFiles(input({ selectionId: id }))).rejects.toBeInstanceOf(SelectionFileError);
    }
    await expect(fs.lstat(path.join(root, '.threads-design'))).rejects.toThrow();
  });

  it('rejects a missing or relative root', async () => {
    await expect(writeSelectionFiles(input({ root: path.join(base, 'missing') }))).rejects.toBeInstanceOf(SelectionFileError);
    await expect(writeSelectionFiles(input({ root: 'relative/root' }))).rejects.toBeInstanceOf(SelectionFileError);
  });

  it('resolves a root that is itself a symlink and writes inside the real directory only', async () => {
    const alias = path.join(base, 'alias');
    await fs.symlink(root, alias);
    const result = await writeSelectionFiles(input({ root: alias }));
    expect(result.jsonPath.startsWith(`${root}${path.sep}`)).toBe(true);
  });

  it('leaves no temp file and no target when the rename fails', async () => {
    const realFs = await import('node:fs/promises');
    const failing = { rename: async () => { throw Object.assign(new Error('boom'), { code: 'EIO' }); } };
    await expect(writeSelectionFiles(input(), { ...realFs, ...failing } as never)).rejects.toBeInstanceOf(SelectionFileError);
    expect(await fs.readdir(selectionsDir())).toEqual([]);
  });
});

describe('pruneSelections (A10)', () => {
  const idFor = (n: number) => `sel_${n.toString(16).padStart(32, '0')}`;
  const HOUR = 3_600_000;

  async function seed(count: number): Promise<void> {
    await fs.mkdir(selectionsDir(), { recursive: true });
    const now = Date.now();
    for (let n = 0; n < count; n++) {
      const when = new Date(now - (count - n) * 1000); // n=0 is the oldest
      for (const ext of ['json', 'png']) {
        const file = path.join(selectionsDir(), `${idFor(n)}.${ext}`);
        await fs.writeFile(file, 'x');
        await fs.utimes(file, when, when);
      }
    }
  }

  it('keeps only the newest N pairs and removes the older json and png together', async () => {
    await seed(60);
    const result = await pruneSelections({ root, keep: 50 });
    expect(result.removed).toHaveLength(20); // 10 ids x 2 files
    const left = await fs.readdir(selectionsDir());
    expect(left).toHaveLength(100);
    expect(left).not.toContain(`${idFor(0)}.json`);
    expect(left).not.toContain(`${idFor(9)}.png`);
    expect(left).toContain(`${idFor(10)}.json`);
    expect(left).toContain(`${idFor(59)}.png`);
  });

  it('never removes the protected id even when it is the oldest', async () => {
    await seed(55);
    await pruneSelections({ root, keep: 50, protectId: idFor(0) });
    expect(await fs.readdir(selectionsDir())).toContain(`${idFor(0)}.json`);
  });

  it('only touches regular files named sel_<32 hex>.(json|png)', async () => {
    await seed(52);
    await fs.writeFile(path.join(selectionsDir(), 'notes.txt'), 'keep');
    await fs.writeFile(path.join(selectionsDir(), 'sel_short.json'), 'keep');
    await fs.mkdir(path.join(selectionsDir(), `${idFor(999)}.json`));
    const victim = path.join(outside, 'victim.txt');
    await fs.writeFile(victim, 'original');
    await fs.symlink(victim, path.join(selectionsDir(), `${idFor(1000)}.png`));
    await pruneSelections({ root, keep: 10 });
    const left = await fs.readdir(selectionsDir());
    expect(left).toEqual(expect.arrayContaining(['notes.txt', 'sel_short.json', `${idFor(999)}.json`, `${idFor(1000)}.png`]));
    expect(await fs.readFile(victim, 'utf8')).toBe('original');
  });

  it('removes stale temp files from interrupted writes but keeps fresh ones', async () => {
    await seed(1);
    const stale = path.join(selectionsDir(), `.${idFor(1)}.json.0123456789abcdef.tmp`);
    const fresh = path.join(selectionsDir(), `.${idFor(2)}.json.0123456789abcdef.tmp`);
    await fs.writeFile(stale, 'x');
    await fs.writeFile(fresh, 'x');
    const old = new Date(Date.now() - 2 * HOUR);
    await fs.utimes(stale, old, old);
    await pruneSelections({ root, keep: 50 });
    const left = await fs.readdir(selectionsDir());
    expect(left).not.toContain(path.basename(stale));
    expect(left).toContain(path.basename(fresh));
  });

  it('does nothing and does not throw when the directory is missing or is a symlink', async () => {
    expect((await pruneSelections({ root, keep: 1 })).removed).toEqual([]);
    await fs.mkdir(path.join(root, '.threads-design'));
    await fs.writeFile(path.join(outside, `${idFor(1)}.json`), 'x');
    await fs.symlink(outside, path.join(root, '.threads-design', 'selections'));
    expect((await pruneSelections({ root, keep: 0 })).removed).toEqual([]);
    expect(await fs.readdir(outside)).toEqual([`${idFor(1)}.json`]);
  });
});
