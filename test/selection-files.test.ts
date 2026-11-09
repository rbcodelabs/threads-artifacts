import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SelectionFileError, writeSelectionFiles } from '../src/selectionFiles';
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
