import { describe, expect, it, vi } from 'vitest';
import { migrateHiddenDesigns, type MigrationFs } from '../src/designMigration';

const VAULT = '/vault';
const VISIBLE = `${VAULT}/Artifacts/design`;
const HIDDEN = `${VAULT}/.geode/artifacts`;

/** In-memory fs: files are tracked by full path; directories are derived or explicitly created. */
function fakeFs(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial));
  const dirs = new Set<string>();
  const addDirs = (p: string) => { for (let d = p.slice(0, p.lastIndexOf('/')); d; d = d.slice(0, d.lastIndexOf('/'))) dirs.add(d); };
  for (const f of files.keys()) addDirs(f);
  const children = (dir: string) => {
    const names = new Set<string>();
    for (const p of [...files.keys(), ...dirs]) if (p.startsWith(`${dir}/`)) names.add(p.slice(dir.length + 1).split('/')[0]);
    return [...names];
  };
  const fs = {
    files, dirs,
    readdir: vi.fn(async (dir: string) => {
      if (!dirs.has(dir)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return children(dir);
    }),
    readFile: vi.fn(async (p: string) => {
      const v = files.get(p);
      if (v === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return v;
    }),
    rename: vi.fn(async (from: string, to: string) => {
      for (const p of [...files.keys()]) {
        if (p === from || p.startsWith(`${from}/`)) { const next = to + p.slice(from.length); files.set(next, files.get(p)!); files.delete(p); addDirs(next); }
      }
      for (const d of [...dirs]) if (d === from || d.startsWith(`${from}/`)) { dirs.delete(d); dirs.add(to + d.slice(from.length)); }
    }),
    rmdir: vi.fn(async (p: string) => {
      if (children(p).length) throw Object.assign(new Error('ENOTEMPTY'), { code: 'ENOTEMPTY' });
      dirs.delete(p);
    }),
  };
  return fs satisfies MigrationFs & Record<string, unknown>;
}

function hiddenDesign(threadId: string, title = 'Billing settings') {
  const id = `design-${threadId}`;
  const root = `${HIDDEN}/${id}`;
  const manifest = JSON.stringify({ id, title, createdByThreadId: threadId, entry: 'index.html' });
  const data = {
    id, kind: 'design-static', title, providerId: 'agent-threads.design', schemaVersion: 1,
    storageRoot: root, root, manifestPath: `${root}/artifact.json`, entryPath: `${root}/index.html`,
    createdAt: 1, updatedAt: 2, lastCapturePath: `${root}/capture.png`,
  };
  const files = { [`${root}/artifact.json`]: manifest, [`${root}/index.html`]: '<html>', [`${root}/capture.png`]: 'png' };
  return { id, root, data, files };
}

function apiFor(designs: ReturnType<typeof hiddenDesign>[], visibleBase = VISIBLE) {
  const refs = new Map(designs.map(d => [d.id, { providerId: 'agent-threads.design', kind: 'design-static', schemaVersion: 1, id: d.id, title: d.data.title, data: d.data as unknown, storageRoot: d.root as string | undefined }]));
  const api: any = {
    artifacts: {
      list: vi.fn(async (threadId: string) => [...refs.values()].filter(r => r.id === `design-${threadId}`)),
      allocateStorage: vi.fn(async (_t: string, artifactId: string, options?: { folderName?: string; owner?: { pluginId: string } }) => options?.owner?.pluginId ? ({
        success: true, status: 'allocated', artifactId, path: `${visibleBase}/${options?.folderName ?? artifactId}`,
      }) : { success: false, message: 'owner required', artifactId, status: 'rejected' }),
      update: vi.fn(async (_o: unknown, _t: string, id: string, patch: any) => {
        const ref = refs.get(id)!;
        ref.data = patch.data;
        ref.storageRoot = patch.storageRoot;
        return { success: true };
      }),
    },
  };
  return { api, refs };
}

const owner = { pluginId: 'threads-artifacts' };

describe('migrateHiddenDesigns', () => {
  it('moves a hidden design into the host-allocated visible folder and rewrites every stored path', async () => {
    const d = hiddenDesign('t1');
    const fs = fakeFs(d.files);
    const { api, refs } = apiFor([d]);

    const result = await migrateHiddenDesigns({ api, fs, owner, hiddenRoot: HIDDEN });

    expect(api.artifacts.allocateStorage).toHaveBeenCalledWith('t1', 'design-t1', { location: 'visible', folderName: 'billing-settings', owner: { pluginId: 'threads-design' } });
    const target = `${VISIBLE}/billing-settings`;
    expect(fs.files.has(`${target}/index.html`)).toBe(true);
    expect(fs.files.has(`${target}/artifact.json`)).toBe(true);
    expect([...fs.files.keys()].some(p => p.startsWith(d.root))).toBe(false);
    expect(fs.dirs.has(d.root)).toBe(false);
    const stored = refs.get('design-t1')!;
    expect(stored.storageRoot).toBe(target);
    expect(stored.data).toMatchObject({
      storageRoot: target, root: target, manifestPath: `${target}/artifact.json`, entryPath: `${target}/index.html`,
      lastCapturePath: `${target}/capture.png`, createdAt: 1,
    });
    expect(api.artifacts.update).toHaveBeenCalledWith(owner, 't1', 'design-t1', expect.objectContaining({ storageRoot: target }));
    expect(result).toEqual({ migrated: 1, skipped: 0, failed: 0 });
  });

  it.each(['Artifacts/design', 'Studio/pm/designs', 'Work'])('migrates into whatever visible root the host allocates (%s)', async root => {
    const d = hiddenDesign('t1');
    const fs = fakeFs(d.files);
    const { api, refs } = apiFor([d], `${VAULT}/${root}`);

    const result = await migrateHiddenDesigns({ api, fs, owner, hiddenRoot: HIDDEN });

    const target = `${VAULT}/${root}/billing-settings`;
    expect(result).toEqual({ migrated: 1, skipped: 0, failed: 0 });
    expect(fs.files.has(`${target}/index.html`)).toBe(true);
    expect(refs.get('design-t1')!.storageRoot).toBe(target);
  });

  it('is idempotent: a second run finds nothing to do', async () => {
    const d = hiddenDesign('t1');
    const fs = fakeFs(d.files);
    const { api } = apiFor([d]);
    await migrateHiddenDesigns({ api, fs, owner, hiddenRoot: HIDDEN });
    api.artifacts.allocateStorage.mockClear();
    api.artifacts.update.mockClear();

    const again = await migrateHiddenDesigns({ api, fs, owner, hiddenRoot: HIDDEN });

    expect(again).toEqual({ migrated: 0, skipped: 0, failed: 0 });
    expect(api.artifacts.allocateStorage).not.toHaveBeenCalled();
    expect(api.artifacts.update).not.toHaveBeenCalled();
  });

  it('skips silently when the host still returns a hidden path (no visible-storage support)', async () => {
    const d = hiddenDesign('t1');
    const fs = fakeFs(d.files);
    const { api } = apiFor([d], HIDDEN);
    const filesBefore = new Map(fs.files);

    const result = await migrateHiddenDesigns({ api, fs, owner, hiddenRoot: HIDDEN });

    expect(result.migrated).toBe(0);
    expect(result.failed).toBe(0);
    expect(api.artifacts.update).not.toHaveBeenCalled();
    expect(fs.rename).not.toHaveBeenCalled();
    expect(fs.files).toEqual(filesBefore);
  });

  it('leaves the original in place when the metadata update fails', async () => {
    const d = hiddenDesign('t1');
    const fs = fakeFs(d.files);
    const { api } = apiFor([d]);
    api.artifacts.update.mockResolvedValueOnce({ success: false, message: 'denied' });

    const result = await migrateHiddenDesigns({ api, fs, owner, hiddenRoot: HIDDEN });

    expect(result).toEqual({ migrated: 0, skipped: 0, failed: 1 });
    for (const p of Object.keys(d.files)) expect(fs.files.has(p)).toBe(true);
    expect([...fs.files.keys()].some(p => p.startsWith(`${VISIBLE}/`))).toBe(false);
  });

  it('leaves the original in place when a move throws midway', async () => {
    const d = hiddenDesign('t1');
    const fs = fakeFs(d.files);
    const { api } = apiFor([d]);
    let calls = 0;
    const real = fs.rename.getMockImplementation()!;
    fs.rename.mockImplementation(async (a: string, b: string) => {
      if (++calls === 2) throw new Error('EXDEV');
      return real(a, b);
    });

    const result = await migrateHiddenDesigns({ api, fs, owner, hiddenRoot: HIDDEN });

    expect(result.failed).toBe(1);
    expect(api.artifacts.update).not.toHaveBeenCalled();
    for (const p of Object.keys(d.files)) expect(fs.files.has(p)).toBe(true);
    expect([...fs.files.keys()].some(p => p.startsWith(`${VISIBLE}/`))).toBe(false);
  });

  it('never overwrites: skips when the visible target already holds a colliding file', async () => {
    const d = hiddenDesign('t1');
    const target = `${VISIBLE}/billing-settings`;
    const fs = fakeFs({ ...d.files, [`${target}/index.html`]: 'USER CONTENT' });
    const { api } = apiFor([d]);

    const result = await migrateHiddenDesigns({ api, fs, owner, hiddenRoot: HIDDEN });

    expect(result).toEqual({ migrated: 0, skipped: 1, failed: 0 });
    expect(fs.files.get(`${target}/index.html`)).toBe('USER CONTENT');
    expect(fs.files.has(`${d.root}/index.html`)).toBe(true);
    expect(api.artifacts.update).not.toHaveBeenCalled();
  });

  it('skips directories this plugin does not own and survives a failing thread lookup', async () => {
    const mine = hiddenDesign('t1');
    const foreign = { [`${HIDDEN}/other-plugin-thing/artifact.json`]: JSON.stringify({ id: 'x', createdByThreadId: 'tX' }) };
    const junk = { [`${HIDDEN}/design-broken/artifact.json`]: '{not json' };
    const orphan = hiddenDesign('t9');
    const fs = fakeFs({ ...mine.files, ...foreign, ...junk, ...orphan.files });
    const { api } = apiFor([mine]);
    const list = api.artifacts.list.getMockImplementation()!;
    api.artifacts.list.mockImplementation(async (id: string) => {
      if (id === 'tX') throw new Error('boom');
      return list(id);
    });

    const result = await migrateHiddenDesigns({ api, fs, owner, hiddenRoot: HIDDEN });

    expect(result.migrated).toBe(1);
    expect(fs.files.has(`${orphan.root}/index.html`)).toBe(true);
    expect(fs.files.has(`${HIDDEN}/other-plugin-thing/artifact.json`)).toBe(true);
  });

  it('does nothing when the hidden root does not exist', async () => {
    const fs = fakeFs();
    const { api } = apiFor([]);
    await expect(migrateHiddenDesigns({ api, fs, owner, hiddenRoot: HIDDEN })).resolves.toEqual({ migrated: 0, skipped: 0, failed: 0 });
  });

  it('keys on artifact.json identity, not on the hidden folder name', async () => {
    const d = hiddenDesign('t1');
    const renamed = Object.fromEntries(Object.entries(d.files).map(([k, v]) => [k.replace('design-t1', 'whatever'), v]));
    const root = `${HIDDEN}/whatever`;
    const data = { ...d.data, root, storageRoot: root, manifestPath: `${root}/artifact.json`, entryPath: `${root}/index.html`, lastCapturePath: `${root}/capture.png` };
    const fs = fakeFs(renamed);
    const { api } = apiFor([{ ...d, data, root }]);

    const result = await migrateHiddenDesigns({ api, fs, owner, hiddenRoot: HIDDEN });

    expect(result.migrated).toBe(1);
  });
});
