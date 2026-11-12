import { describe, expect, it, vi } from 'vitest';
import { DesignService } from '../src/DesignService';

function apiHarness() {
  const artifacts: any[] = [];
  const handle = { threadId: 'new-thread', commit: vi.fn(async () => {}), rollback: vi.fn(async () => {}) };
  const api: any = {
    threads: {
      beginProvisional: vi.fn(async () => handle), open: vi.fn(async () => {}),
      send: vi.fn(async () => ({ runId: 'run' })), permissions: vi.fn(async () => ({ effectivePermissionMode: 'default', planApprovalPending: false })),
    },
    artifacts: {
      list: vi.fn(async () => artifacts),
      allocateStorage: vi.fn(async (_threadId: string, artifactId: string, options?: { owner?: { pluginId: string } }) => options?.owner?.pluginId ? ({ success: true, status: 'allocated', artifactId, path: `/vault/${artifactId}` }) : ({ success: false, message: 'owner required', artifactId, status: 'rejected' })),
      attach: vi.fn(async (_owner: unknown, _threadId: string, ref: unknown) => { artifacts.push(ref); return { success: true }; }),
      update: vi.fn(async () => ({ success: true })),
      invokeAction: vi.fn(async () => ({ status: 'ok' })),
    },
  };
  return { api, handle, artifacts };
}

const fileFs: any = { mkdir: vi.fn(async () => {}), writeFile: vi.fn(async () => {}), rm: vi.fn(async () => {}) };

describe('DesignService', () => {
  it('owns create → scaffold → attach → preview → commit → send', async () => {
    const { api, handle } = apiHarness();
    const service = new DesignService(api, fileFs);

    await expect(service.dispatch('Settings page', 'codex')).resolves.toBe('new-thread');

    expect(api.threads.beginProvisional).toHaveBeenCalled();
    expect(api.artifacts.attach).toHaveBeenCalled();
    expect(api.threads.open).toHaveBeenCalledWith('new-thread');
    expect(api.artifacts.invokeAction).toHaveBeenCalledWith('new-thread', 'design-new-thread', 'preview');
    expect(handle.commit).toHaveBeenCalledOnce();
    expect(api.threads.send).toHaveBeenCalledAfter(handle.commit);
    expect(api.threads.send).toHaveBeenCalledWith('new-thread', expect.objectContaining({ ownerPluginId: expect.any(String), idempotencyKey: expect.stringMatching(/.+/) }));
    expect(handle.rollback).not.toHaveBeenCalled();
  });

  it('passes the mode into dispatched kickoff instructions and titles from the brief', async () => {
    const { api } = apiHarness();
    const service = new DesignService(api, fileFs);

    await service.dispatch('Billing settings', 'claude', 'wireframe');

    expect(api.threads.beginProvisional).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ title: 'Billing settings' }));
    expect(api.threads.send).toHaveBeenCalledWith('new-thread', expect.objectContaining({ prompt: expect.stringContaining('Mode: wireframe') }));
  });

  it('passes the mode into prepared instructions and defaults to none', async () => {
    const { api } = apiHarness();
    const service = new DesignService(api, fileFs);

    expect((await service.prepare('thread-1', 'Plan picker', { mode: 'states' })).instructions).toContain('Mode: states');
    expect((await service.prepare('thread-1', 'Plan picker')).instructions).not.toContain('Mode:');
  });

  it('keeps the existing artifact title when picking a variation', async () => {
    const { api, artifacts } = apiHarness();
    const service = new DesignService(api, fileFs);
    await service.prepare('thread-1', 'Billing settings');

    const picked = await service.prepare('thread-1', 'B, but use A\'s navigation', { mode: 'pick' });

    expect(picked.created).toBe(false);
    expect(picked.artifact.title).toBe('Billing settings');
    expect(api.artifacts.update).toHaveBeenCalledWith(expect.anything(), 'thread-1', 'design-thread-1', { data: expect.objectContaining({ title: 'Billing settings' }) });
    expect(api.artifacts.update.mock.calls[0][3]).not.toHaveProperty('title');
    expect(picked.instructions).toContain('Mode: pick');
    expect(picked.instructions).toContain('B, but use A\'s navigation');
  });

  it('keeps the existing artifact title when annotating with spec', async () => {
    const { api, artifacts } = apiHarness();
    const service = new DesignService(api, fileFs);
    await service.prepare('thread-1', 'Billing settings');

    const specced = await service.prepare('thread-1', 'the pricing page', { mode: 'spec' });

    expect(specced.created).toBe(false);
    expect(specced.artifact.title).toBe('Billing settings');
    expect(api.artifacts.update).toHaveBeenCalledWith(expect.anything(), 'thread-1', 'design-thread-1', { data: expect.objectContaining({ title: 'Billing settings' }) });
    expect(specced.instructions).toContain('Mode: spec');
  });

  it('captures the host theme only when creating a new artifact', async () => {
    const { api, artifacts } = apiHarness();
    const theme = {
      mode: 'light' as const, background: '#fff', text: '#111', mutedText: '#666',
      accent: '#6750a4', border: '#ddd', interfaceFont: 'system-ui',
    };
    const provideTheme = vi.fn(() => theme);
    const service = new DesignService(api, fileFs, () => {}, provideTheme);

    await service.prepare('thread-1', 'First brief');
    expect(provideTheme).toHaveBeenCalledOnce();

    await service.prepare('thread-1', 'Revision');
    expect(artifacts).toHaveLength(1);
    expect(provideTheme).toHaveBeenCalledOnce();
  });

  it('rolls back the provisional thread and allocated storage before commit', async () => {
    const { api, handle } = apiHarness();
    api.artifacts.invokeAction.mockResolvedValueOnce({ status: 'error', message: 'preview failed' });
    const service = new DesignService(api, fileFs);

    await expect(service.dispatch('Settings page', 'claude')).rejects.toThrow('preview failed');
    expect(handle.rollback).toHaveBeenCalledOnce();
    expect(handle.commit).not.toHaveBeenCalled();
    expect(api.threads.send).not.toHaveBeenCalled();
  });

  describe('visible storage', () => {
    it('requests visible allocation named by the slugged title', async () => {
      const { api } = apiHarness();
      const service = new DesignService(api, fileFs);

      await service.prepare('thread-1', 'wireframe: Billing Settings Page!');

      expect(api.artifacts.allocateStorage).toHaveBeenCalledWith('thread-1', 'design-thread-1', { location: 'visible', folderName: 'billing-settings-page', owner: { pluginId: 'threads-design' } });
    });

    it('falls back to the artifact id when the title yields no slug', async () => {
      const { api } = apiHarness();
      const service = new DesignService(api, fileFs);

      await service.prepare('thread-1', '日本語');

      expect(api.artifacts.allocateStorage).toHaveBeenCalledWith('thread-1', 'design-thread-1', { location: 'visible', folderName: 'design-thread-1', owner: { pluginId: 'threads-design' } });
    });

    it('uses the path the host returns for scaffold, attach and kickoff', async () => {
      const { api } = apiHarness();
      api.artifacts.allocateStorage.mockResolvedValueOnce({ success: true, status: 'allocated', artifactId: 'design-thread-1', path: '/vault/Artifacts/design/billing-2' });
      const writes: string[] = [];
      const recordingFs: any = { mkdir: vi.fn(async () => {}), writeFile: vi.fn(async (target: string) => { writes.push(target); }), rm: vi.fn(async () => {}) };
      const service = new DesignService(api, recordingFs);

      const prepared = await service.prepare('thread-1', 'Billing');

      expect(prepared.artifact.root).toBe('/vault/Artifacts/design/billing-2');
      expect(prepared.artifact.storageRoot).toBe('/vault/Artifacts/design/billing-2');
      expect(writes.every(target => target.startsWith('/vault/Artifacts/design/billing-2/'))).toBe(true);
      expect(api.artifacts.attach).toHaveBeenCalledWith(expect.anything(), 'thread-1', expect.objectContaining({ storageRoot: '/vault/Artifacts/design/billing-2' }));
      expect(prepared.instructions).toContain('/vault/Artifacts/design/billing-2');
    });

    it.each(['/vault/Studio/pm/billing', '/vault/Artifacts/design/billing'])('does not assume a visible root name (%s)', async hostPath => {
      const { api } = apiHarness();
      api.artifacts.allocateStorage.mockResolvedValueOnce({ success: true, status: 'allocated', artifactId: 'design-thread-1', path: hostPath });
      const service = new DesignService(api, fileFs);

      const prepared = await service.prepare('thread-1', 'Billing');

      expect(api.artifacts.allocateStorage).toHaveBeenCalledWith('thread-1', 'design-thread-1', { location: 'visible', folderName: 'billing', owner: { pluginId: 'threads-design' } });
      expect(prepared.artifact.root).toBe(hostPath);
    });

    it('still works when an older host ignores the options and returns the hidden path', async () => {
      const { api } = apiHarness();
      api.artifacts.allocateStorage.mockResolvedValueOnce({ success: true, status: 'allocated', artifactId: 'design-thread-1', path: '/vault/.geode/artifacts/design-thread-1' });
      const service = new DesignService(api, fileFs);

      const prepared = await service.prepare('thread-1', 'Billing');

      expect(prepared.created).toBe(true);
      expect(prepared.artifact.root).toBe('/vault/.geode/artifacts/design-thread-1');
    });

    it('removes the host-returned storage when preparation fails', async () => {
      const { api } = apiHarness();
      api.artifacts.allocateStorage.mockResolvedValueOnce({ success: true, status: 'allocated', artifactId: 'design-thread-1', path: '/vault/Artifacts/design/billing' });
      api.artifacts.invokeAction.mockResolvedValueOnce({ status: 'error', message: 'preview failed' });
      const rm = vi.fn(async () => {});
      const service = new DesignService(api, { ...fileFs, rm } as any);

      await expect(service.prepare('thread-1', 'Billing')).rejects.toThrow('preview failed');

      expect(rm).toHaveBeenCalledWith('/vault/Artifacts/design/billing', { recursive: true, force: true });
    });
  });

  describe('DESIGN.md guidance', () => {
    it('loads guidance from the thread cwd, applies it, and reports', async () => {
      const { api } = apiHarness();
      api.threads.get = vi.fn(async () => ({ id: 'thread-1', cwd: '/repo/app' }));
      const reader = vi.fn(async () => ({ path: '/repo/DESIGN.md', content: 'Brand: teal.', truncated: false }));
      const report = vi.fn();
      const service = new DesignService(api, fileFs, report, undefined, reader);

      const prepared = await service.prepare('thread-1', 'Plan picker');

      expect(reader).toHaveBeenCalledWith('/repo/app');
      expect(prepared.instructions).toContain('Brand: teal.');
      expect(prepared.instructions).not.toContain('distinctive visual direction');
      expect(report).toHaveBeenCalledWith('Using DESIGN.md from /repo/DESIGN.md');
    });

    it.each([['no cwd', { id: 'thread-1' }], ['a null thread', null]])('falls back to the lookup bullet when threads.get returns %s', async (_name, thread) => {
      const { api } = apiHarness();
      api.threads.get = vi.fn(async () => thread);
      const reader = vi.fn(async () => null);
      const service = new DesignService(api, fileFs, undefined, undefined, reader);

      const prepared = await service.prepare('thread-1', 'Plan picker');

      expect(reader).not.toHaveBeenCalled();
      expect(prepared.instructions).toContain('distinctive visual direction');
      expect(prepared.instructions).toContain('docs/DESIGN.md');
    });

    it('never breaks prepare when guidance lookup throws', async () => {
      const { api } = apiHarness();
      api.threads.get = vi.fn(async () => { throw new Error('host down'); });
      const service = new DesignService(api, fileFs, undefined, undefined, async () => { throw new Error('read'); });
      await expect(service.prepare('thread-1', 'Plan picker')).resolves.toMatchObject({ created: true });

      api.threads.get = vi.fn(async () => ({ id: 'thread-2', cwd: '/x' }));
      await expect(service.prepare('thread-2', 'Plan picker')).resolves.toBeDefined();
    });
  });

  it('keeps committed work when kickoff send fails', async () => {
    const { api, handle } = apiHarness();
    api.threads.send.mockRejectedValueOnce(new Error('session unavailable'));
    const report = vi.fn();
    const service = new DesignService(api, fileFs, report);

    await expect(service.dispatch('Settings page', 'claude')).resolves.toBe('new-thread');
    expect(handle.commit).toHaveBeenCalledOnce();
    expect(handle.rollback).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith('Failed to start design turn: session unavailable', true);
  });

  it.each([
    [{ effectivePermissionMode: 'plan', planApprovalPending: false }, 'Plan mode'],
    [{ effectivePermissionMode: 'default', planApprovalPending: true }, 'plan approval'],
  ])('rejects restricted in-thread writes before allocation', async (permissions, expected) => {
    const { api } = apiHarness();
    api.threads.permissions.mockResolvedValueOnce(permissions);
    const service = new DesignService(api, fileFs);
    await expect(service.prepare('thread-1', 'Settings')).rejects.toThrow(expected);
    expect(api.artifacts.allocateStorage).not.toHaveBeenCalled();
  });

  describe('nextjs runtime', () => {
    const toolchain = () => ({ ensureDependencies: vi.fn(async () => {}) });

    it('scaffolds, links dependencies, attaches a design-app ref, and previews', async () => {
      const { api } = apiHarness();
      const deps = toolchain();
      const service = new DesignService(api, fileFs, undefined, undefined, undefined, deps);
      const prepared = await service.prepare('thread-1', 'CRM app', { runtime: 'nextjs' });
      expect(deps.ensureDependencies).toHaveBeenCalledWith('/vault/design-thread-1');
      expect(prepared.artifact).toMatchObject({ kind: 'design-app', runtime: 'nextjs' });
      expect(prepared.instructions).toContain('Next.js');
      expect(api.artifacts.attach).toHaveBeenCalledWith(expect.anything(), 'thread-1', expect.objectContaining({ kind: 'design-app', schemaVersion: 2 }));
      expect(api.artifacts.invokeAction).toHaveBeenCalledWith('thread-1', 'design-thread-1', 'preview');
    });

    it('keeps static as the default and never touches the toolchain', async () => {
      const { api } = apiHarness();
      const deps = toolchain();
      const prepared = await new DesignService(api, fileFs, undefined, undefined, undefined, deps).prepare('thread-1', 'Page');
      expect(prepared.artifact.kind).toBe('design-static');
      expect(deps.ensureDependencies).not.toHaveBeenCalled();
    });

    it('rolls back allocated storage when dependency setup fails, and never attaches', async () => {
      const { api } = apiHarness();
      const deps = { ensureDependencies: vi.fn(async () => { throw new Error('npm install exited with code 1'); }) };
      const rm = vi.fn(async () => {});
      const service = new DesignService(api, { ...fileFs, rm }, undefined, undefined, undefined, deps);
      await expect(service.prepare('thread-1', 'CRM', { runtime: 'nextjs' })).rejects.toThrow('npm install exited with code 1');
      expect(rm).toHaveBeenCalledWith('/vault/design-thread-1', { recursive: true, force: true });
      expect(api.artifacts.attach).not.toHaveBeenCalled();
    });

    it('rolls the provisional thread back on dispatch when nextjs setup fails', async () => {
      const { api, handle } = apiHarness();
      const deps = { ensureDependencies: vi.fn(async () => { throw new Error('no npm'); }) };
      const service = new DesignService(api, fileFs, undefined, undefined, undefined, deps);
      await expect(service.dispatch('CRM', 'claude', undefined, 'nextjs')).rejects.toThrow('no npm');
      expect(handle.rollback).toHaveBeenCalledOnce();
      expect(api.threads.send).not.toHaveBeenCalled();
    });

    it('fails before allocating storage when no toolchain is configured', async () => {
      const { api } = apiHarness();
      await expect(new DesignService(api, fileFs).prepare('thread-1', 'CRM', { runtime: 'nextjs' })).rejects.toThrow('unavailable');
      expect(api.artifacts.allocateStorage).not.toHaveBeenCalled();
    });

    it('refuses to change the runtime of an existing artifact', async () => {
      const { api, artifacts } = apiHarness();
      artifacts.push({ id: 'design-thread-1', kind: 'design-static', data: { id: 'design-thread-1', kind: 'design-static', runtime: 'static' } });
      const service = new DesignService(api, fileFs, undefined, undefined, undefined, toolchain());
      await expect(service.prepare('thread-1', 'CRM', { runtime: 'nextjs' })).rejects.toThrow('runtime cannot be changed');
      expect(api.artifacts.update).not.toHaveBeenCalled();
    });

    it('reopens a legacy schema-v1 artifact (no runtime field) without rewriting its version', async () => {
      const { api, artifacts } = apiHarness();
      const legacy = { id: 'design-thread-1', kind: 'design-static', schemaVersion: 1, root: '/old', title: 'Old' };
      artifacts.push({ id: legacy.id, kind: 'design-static', schemaVersion: 1, data: legacy });
      const service = new DesignService(api, fileFs);
      const prepared = await service.prepare('thread-1', 'revise', { runtime: 'static' });
      expect(prepared.created).toBe(false);
      expect(api.artifacts.update).toHaveBeenCalledWith(expect.anything(), 'thread-1', legacy.id, { data: expect.objectContaining({ schemaVersion: 1, kind: 'design-static' }) });
      expect(prepared.instructions).toContain('Inline JavaScript is blocked');
    });

    it('rejects modes that cannot run on nextjs and still allows wireframe/states', async () => {
      const deps = toolchain();
      for (const mode of ['variations', 'pick', 'spec', 'storyboard', 'report'] as const) {
        const { api } = apiHarness();
        await expect(new DesignService(api, fileFs, undefined, undefined, undefined, deps).prepare('thread-1', 'CRM', { mode, runtime: 'nextjs' })).rejects.toThrow('only available for static');
        expect(api.artifacts.allocateStorage).not.toHaveBeenCalled();
      }
      const { api } = apiHarness();
      const prepared = await new DesignService(api, fileFs, undefined, undefined, undefined, deps).prepare('thread-1', 'CRM', { mode: 'wireframe', runtime: 'nextjs' });
      expect(prepared.instructions).toContain('Mode: wireframe');
      expect(prepared.instructions).toContain('Next.js');
    });

    it('rejects a static-only mode against an existing nextjs artifact even without a runtime', async () => {
      const { api, artifacts } = apiHarness();
      artifacts.push({ id: 'design-thread-1', kind: 'design-app', data: { id: 'design-thread-1', kind: 'design-app', runtime: 'nextjs', root: '/r' } });
      await expect(new DesignService(api, fileFs).prepare('thread-1', 'x', { mode: 'variations' })).rejects.toThrow('only available for static');
    });

    it('recognizes an existing design-app artifact in state()', async () => {
      const { api, artifacts } = apiHarness();
      api.threads.get = vi.fn(async () => ({ id: 'thread-1' }));
      artifacts.push({ id: 'x', kind: 'design-app', title: 'My app', data: {} });
      expect(await new DesignService(api, fileFs).state('thread-1')).toEqual({ hasArtifacts: true, existingTitle: 'My app' });
    });
  });
});

describe('DesignService viewport per mode', () => {
  async function run(mode?: string, preset = 'desktop') {
    const { api } = apiHarness();
    let written = JSON.stringify({ viewport: { preset, width: 1440, height: 900 } });
    const fs: any = {
      mkdir: vi.fn(async () => {}), rm: vi.fn(async () => {}),
      writeFile: vi.fn(async (target: string, data: string) => { if (target.endsWith('artifact.json')) written = data; }),
      readFile: vi.fn(async () => written),
    };
    await new DesignService(api, fs).prepare('t1', 'Brief', { mode: mode as any });
    return { preset: JSON.parse(written).viewport.preset, manifestWrites: fs.writeFile.mock.calls.filter((c: any[]) => c[0].endsWith('artifact.json')).length };
  }
  it('fills the pane for variations', async () => { expect((await run('variations')).preset).toBe('fill'); });
  it('fills the pane for storyboard', async () => { expect((await run('storyboard')).preset).toBe('fill'); });
  it('uses the responsive desktop frame for report', async () => { expect((await run('report', 'fill')).preset).toBe('desktop'); });
  it('restores desktop for other modes', async () => { expect((await run('pick', 'fill')).preset).toBe('desktop'); });
  it('does not rewrite the manifest without a mode', async () => { expect((await run(undefined)).manifestWrites).toBe(1); });
});

describe('DesignService report mode scaffold', () => {
  function recordingFs() {
    const names: string[] = [];
    const fs: any = {
      mkdir: vi.fn(async () => {}), rm: vi.fn(async () => {}),
      writeFile: vi.fn(async (target: string) => { names.push(target.split('/').pop()!); }),
      readFile: vi.fn(async () => JSON.stringify({ viewport: { preset: 'desktop', width: 1440, height: 900 } })),
    };
    return { fs, names };
  }

  it('writes the report scaffold for a new report artifact and returns report instructions', async () => {
    const { api } = apiHarness();
    const { fs, names } = recordingFs();
    const prepared = await new DesignService(api, fs).prepare('t1', 'Quarterly analysis', { mode: 'report' });
    expect(prepared.created).toBe(true);
    expect(names).toEqual(expect.arrayContaining(['index.html', 'styles.css', 'report.js', 'data.js']));
    expect(names).not.toContain('app.js');
    expect(prepared.instructions).toContain('Mode: report');
  });

  it('adds only the chart library and data file when report mode runs on an existing static design', async () => {
    const { api } = apiHarness();
    const first = recordingFs();
    await new DesignService(api, first.fs).prepare('t1', 'Landing page');
    const second = recordingFs();
    const again = await new DesignService(api, second.fs).prepare('t1', 'report: add a chart', { mode: 'report' });
    expect(again.created).toBe(false);
    expect(second.names.filter(n => n !== 'artifact.json').sort()).toEqual(['data.js', 'report.js']);
  });
});
