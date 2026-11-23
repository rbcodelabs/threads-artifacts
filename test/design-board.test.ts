import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignService } from '../src/DesignService';
import { createAddArtboardAgentTool, createDesignAgentTool } from '../src/designAgentTool';
import { buildDesignManifest, designKickoffMessage, shortDesignTitle, type DesignArtifact } from '../src/designArtifact';
import {
  DESIGN_BOARD_STORAGE_NAMESPACE,
  DESIGN_STORAGE_NAMESPACE,
  presentDesignArtifact,
  previewDesignArtifact,
} from '../src/designArtifactProvider';
import {
  ARTBOARD_PRESETS,
  addArtboardToBoard,
  computeNextArtboardPosition,
  isMultiScreenRequest,
  type CanvasDocument,
} from '../src/designBoard';
import { normalizeHostTheme } from '../src/hostTheme';

const nodeFs = {
  mkdir: (target: string, options: { recursive: true }) => fs.mkdir(target, options),
  writeFile: (target: string, data: string, options?: { flag: 'wx' }) => fs.writeFile(target, data, options),
  readFile: (target: string) => fs.readFile(target, 'utf8'),
  rm: (target: string, options: { recursive: true; force: true }) => fs.rm(target, options),
};

describe('Design Board (Phase 2)', () => {
  let vaultDir: string;

  beforeEach(async () => {
    vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'threads-design-board-'));
  });

  afterEach(async () => {
    await fs.rm(vaultDir, { recursive: true, force: true });
    delete (globalThis as { geode?: unknown }).geode;
  });

  it('creates boards only when multiple screens are requested (or explicitly opted in)', () => {
    expect(isMultiScreenRequest('Settings page')).toBe(false);
    expect(isMultiScreenRequest('A responsive pricing page for a developer tool')).toBe(false);
    expect(isMultiScreenRequest('3 screens for an onboarding flow')).toBe(true);
    expect(isMultiScreenRequest('Pricing page in desktop and mobile')).toBe(true);
    expect(isMultiScreenRequest('Checkout flow with confirmation')).toBe(true);
    expect(isMultiScreenRequest('Design board for billing')).toBe(true);
    expect(isMultiScreenRequest('Settings page', true)).toBe(true);
    expect(isMultiScreenRequest('3 screens for onboarding', false)).toBe(false);
  });

  it('allocates boards under Artifacts/threads-artifacts/<slug>/ and scaffolds board.canvas, tokens.css, and initial artboard', async () => {
    const attached: any[] = [];
    const api: any = {
      capabilities: ['artifacts.visibleStorage'],
      threads: {
        get: vi.fn(async () => ({ id: 't-board' })),
        open: vi.fn(async () => {}),
        permissions: vi.fn(async () => ({ effectivePermissionMode: 'default', planApprovalPending: false })),
      },
      artifacts: {
        list: vi.fn(async () => attached),
        allocateStorage: vi.fn(async (_threadId: string, artifactId: string, opts?: { location?: string; folderName?: string; owner?: { pluginId: string } }) => {
          const ns = opts?.owner?.pluginId ?? 'threads-design';
          const dir = path.join(vaultDir, 'Artifacts', ns, opts?.folderName ?? artifactId);
          await fs.mkdir(dir, { recursive: true });
          return { success: true, status: 'allocated', artifactId, path: dir };
        }),
        attach: vi.fn(async (_owner: unknown, _threadId: string, ref: unknown) => {
          attached.push(ref);
          return { success: true };
        }),
        update: vi.fn(async (_owner: unknown, _threadId: string, _id: string, patch: { data: unknown }) => {
          if (attached[0]) attached[0].data = patch.data;
          return { success: true };
        }),
        invokeAction: vi.fn(async () => ({ status: 'ok' })),
      },
    };

    const service = new DesignService(api, nodeFs, () => {}, () => normalizeHostTheme('dark', {}), undefined, undefined, vaultDir);
    const prepared = await service.prepare('t-board', 'Pricing redesign in desktop and mobile');

    expect(api.artifacts.allocateStorage).toHaveBeenCalledWith('t-board', 'design-t-board', {
      location: 'visible',
      folderName: 'pricing-redesign-in-desktop-and-mobile',
      owner: { pluginId: DESIGN_BOARD_STORAGE_NAMESPACE },
    });

    expect(prepared.artifact.boardPath).toBe(path.join(prepared.artifact.root, 'board.canvas'));
    expect(prepared.artifact.boardVaultPath).toBe('Artifacts/threads-artifacts/pricing-redesign-in-desktop-and-mobile/board.canvas');

    const tokens = await fs.readFile(path.join(prepared.artifact.root, 'tokens.css'), 'utf8');
    expect(tokens).toContain('--bg:');
    const indexHtml = await fs.readFile(path.join(prepared.artifact.root, 'index.html'), 'utf8');
    expect(indexHtml).toContain('href="tokens.css"');

    const board = JSON.parse(await fs.readFile(prepared.artifact.boardPath!, 'utf8')) as CanvasDocument;
    expect(board.nodes).toHaveLength(1);
    expect(board.nodes[0]).toMatchObject({
      id: 'artboard-home',
      type: 'file',
      file: 'Artifacts/threads-artifacts/pricing-redesign-in-desktop-and-mobile/artifact.json',
      x: 0,
      y: 0,
      width: ARTBOARD_PRESETS.desktop.width,
      height: ARTBOARD_PRESETS.desktop.height,
    });

    // Kickoff instructions explain the board model and AddDesignArtboard tool.
    expect(prepared.instructions).toContain('Design Board model:');
    expect(prepared.instructions).toContain('tokens.css');
    expect(prepared.instructions).toContain('AddDesignArtboard');
  });

  it('keeps single-screen designs single-page without board.canvas', async () => {
    const attached: any[] = [];
    const api: any = {
      capabilities: ['artifacts.visibleStorage'],
      threads: {
        get: vi.fn(async () => ({ id: 't-single' })),
        open: vi.fn(async () => {}),
        permissions: vi.fn(async () => ({ effectivePermissionMode: 'default', planApprovalPending: false })),
      },
      artifacts: {
        list: vi.fn(async () => attached),
        allocateStorage: vi.fn(async (_threadId: string, artifactId: string, opts?: { folderName?: string; owner?: { pluginId: string } }) => {
          const ns = opts?.owner?.pluginId ?? 'threads-design';
          const dir = path.join(vaultDir, 'Artifacts', ns, opts?.folderName ?? artifactId);
          await fs.mkdir(dir, { recursive: true });
          return { success: true, status: 'allocated', artifactId, path: dir };
        }),
        attach: vi.fn(async (_owner: unknown, _threadId: string, ref: unknown) => {
          attached.push(ref);
          return { success: true };
        }),
        update: vi.fn(async () => ({ success: true })),
        invokeAction: vi.fn(async () => ({ status: 'ok' })),
      },
    };

    const service = new DesignService(api, nodeFs, () => {}, () => normalizeHostTheme('dark', {}), undefined, undefined, vaultDir);
    const prepared = await service.prepare('t-single', 'Settings page');

    expect(api.artifacts.allocateStorage).toHaveBeenCalledWith('t-single', 'design-t-single', {
      location: 'visible',
      folderName: 'settings-page',
      owner: { pluginId: DESIGN_STORAGE_NAMESPACE },
    });
    expect(prepared.artifact.boardPath).toBeUndefined();
    await expect(fs.access(path.join(prepared.artifact.root, 'board.canvas'))).rejects.toThrow();
    expect(designKickoffMessage(prepared.artifact, 'Settings page')).not.toContain('Design Board model:');
  });

  it('AddDesignArtboard appends screens with tidy grid layout, device presets, groups, and flow edges', async () => {
    const root = path.join(vaultDir, 'Artifacts', 'threads-artifacts', 'checkout-flow');
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, 'artifact.json'), JSON.stringify({ id: 'checkout-flow' }));

    const attached: any[] = [{
      id: 'design-t1',
      kind: 'design-static',
      title: 'Checkout Flow',
      providerId: 'agent-threads.design',
      schemaVersion: 2,
      data: {
        id: 'design-t1',
        kind: 'design-static',
        title: 'Checkout Flow',
        providerId: 'agent-threads.design',
        schemaVersion: 2,
        runtime: 'static',
        storageRoot: root,
        root,
        manifestPath: path.join(root, 'artifact.json'),
        entryPath: path.join(root, 'index.html'),
        createdAt: 1,
        updatedAt: 1,
      } satisfies DesignArtifact,
    }];
    const api: any = {
      threads: {
        permissions: vi.fn(async () => ({ effectivePermissionMode: 'default', planApprovalPending: false })),
      },
      artifacts: {
        list: vi.fn(async () => attached),
        update: vi.fn(async (_owner: unknown, _tid: string, _id: string, patch: { data: unknown }) => {
          attached[0].data = patch.data;
          return { success: true };
        }),
      },
    };

    const service = new DesignService(api, nodeFs, () => {}, () => normalizeHostTheme('dark', {}), undefined, undefined, vaultDir);
    const tool = createAddArtboardAgentTool(service);

    const r1 = await tool.invoke('t1', {
      name: 'Mobile Checkout',
      preset: 'mobile',
      group: 'Mobile',
      fromArtboardId: 'artboard-home',
      edgeLabel: 'Tap Checkout',
    }, {} as any);
    expect(r1.isError).toBeUndefined();
    const added1 = JSON.parse(r1.content[0].text);
    expect(added1.node).toMatchObject({
      id: 'artboard-mobile-checkout',
      type: 'file',
      file: 'Artifacts/threads-artifacts/checkout-flow/artifact.json',
      subpath: '#screens/mobile-checkout.html',
      x: 1540,
      y: 0,
      width: 390,
      height: 844,
    });
    expect(added1.edge).toMatchObject({
      fromNode: 'artboard-home',
      toNode: 'artboard-mobile-checkout',
      toEnd: 'arrow',
      label: 'Tap Checkout',
    });

    const screenHtml = await fs.readFile(added1.screenPath, 'utf8');
    expect(screenHtml).toContain('../tokens.css');
    expect(screenHtml).toContain('Mobile Checkout');

    // Add a second artboard into the same group and verify group expansion + duplicate-name slugging.
    const r2 = await tool.invoke('t1', { name: 'Mobile Checkout', preset: 'tablet', group: 'Mobile' }, {} as any);
    expect(r2.isError).toBeUndefined();
    const added2 = JSON.parse(r2.content[0].text);
    expect(added2.node.id).toBe('artboard-mobile-checkout-2');
    expect(added2.node.width).toBe(820);
    expect(added2.node.height).toBe(1180);
    expect(added2.node.x).toBe(1540 + 390 + 100);

    const board = JSON.parse(await fs.readFile(path.join(root, 'board.canvas'), 'utf8')) as CanvasDocument;
    const groups = board.nodes.filter(n => n.type === 'group');
    expect(groups).toHaveLength(1);
    expect(groups[0].width).toBeGreaterThan(390 + 820 + 100);
    expect(attached[0].data.boardVaultPath).toBe('Artifacts/threads-artifacts/checkout-flow/board.canvas');
  });

  it('wraps tidy grid placement to a new row once MAX_ROW_WIDTH is exceeded', () => {
    const pos = computeNextArtboardPosition(
      [
        { id: 'a', type: 'file', file: 'a', x: 0, y: 0, width: 1440, height: 900 },
        { id: 'b', type: 'file', file: 'b', x: 1540, y: 0, width: 1440, height: 900 },
        { id: 'c', type: 'file', file: 'c', x: 3080, y: 0, width: 1440, height: 900 },
      ],
      1440,
      900,
    );
    expect(pos).toEqual({ x: 0, y: 1020 });
  });

  it('previews board.canvas in Geode CanvasView and falls back to geode-artifact when canvas is unavailable or single-screen', async () => {
    (globalThis as { geode?: unknown }).geode = { captureArtifact: vi.fn() };

    const boardArtifact = {
      root: '/vault/Artifacts/threads-artifacts/pricing',
      manifestPath: '/vault/Artifacts/threads-artifacts/pricing/artifact.json',
      boardVaultPath: 'Artifacts/threads-artifacts/pricing/board.canvas',
    };

    const hostCanvasOk: any = { openView: vi.fn(async () => 'tab'), revealInFolder: vi.fn() };
    await expect(previewDesignArtifact(boardArtifact, hostCanvasOk)).resolves.toEqual({ status: 'opened' });
    expect(hostCanvasOk.openView).toHaveBeenCalledWith({
      type: 'canvas',
      state: { file: 'Artifacts/threads-artifacts/pricing/board.canvas' },
    });

    // If canvas view is unavailable, fall back to geode-artifact.
    const hostCanvasUnavailable: any = {
      openView: vi.fn(async (req: { type: string }) => (req.type === 'canvas' ? 'unavailable' : 'tab')),
      revealInFolder: vi.fn(),
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fallback = await previewDesignArtifact(boardArtifact, hostCanvasUnavailable);
    expect(fallback).toMatchObject({ status: 'opened', warning: expect.stringContaining('board.canvas could not open in CanvasView') });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('board.canvas could not open in CanvasView'));

    // A throwing canvas view also falls back, visibly.
    const hostCanvasThrows: any = {
      openView: vi.fn(async (req: { type: string }) => { if (req.type === 'canvas') throw new Error('no such view'); return 'tab'; }),
      revealInFolder: vi.fn(),
    };
    await expect(previewDesignArtifact(boardArtifact, hostCanvasThrows)).resolves.toMatchObject({
      status: 'opened', warning: expect.stringContaining('no such view'),
    });
    warnSpy.mockRestore();
    expect(hostCanvasUnavailable.openView).toHaveBeenNthCalledWith(1, {
      type: 'canvas',
      state: { file: 'Artifacts/threads-artifacts/pricing/board.canvas' },
    });
    expect(hostCanvasUnavailable.openView).toHaveBeenNthCalledWith(2, {
      type: 'geode-artifact',
      state: { root: boardArtifact.root },
    });

    // Single-screen artifact opens geode-artifact directly.
    const singleHost: any = { openView: vi.fn(async () => 'tab'), revealInFolder: vi.fn() };
    await expect(
      previewDesignArtifact({ root: boardArtifact.root, manifestPath: boardArtifact.manifestPath }, singleHost),
    ).resolves.toEqual({ status: 'opened' });
    expect(singleHost.openView).toHaveBeenCalledWith({
      type: 'geode-artifact',
      state: { root: boardArtifact.root },
    });

    // Presentation reflects Design board subtitle.
    const presentation = presentDesignArtifact({
      id: 'design-1',
      title: 'Pricing',
      kind: 'design-static',
      providerId: 'agent-threads.design',
      schemaVersion: 2,
      data: boardArtifact,
    });
    expect(presentation.subtitle).toBe('Design board');
    expect(presentation.actions[0].label).toBe('Open design board');
  });

  it('EnterDesignMode passes explicit board flag through to DesignService.prepare', async () => {
    const prepare = vi.fn(async () => ({ artifact: { id: 'a' }, created: true, instructions: 'ok' }));
    const tool = createDesignAgentTool({ prepare, state: vi.fn() } as unknown as DesignService);
    const res = await tool.invoke('t1', { brief: 'Dashboard', board: true }, {} as any);
    expect(res.isError).toBeUndefined();
    expect(prepare).toHaveBeenCalledWith('t1', 'Dashboard', { mode: undefined, runtime: undefined, board: true });
  });

  it('rejects unknown fromArtboardId when adding an edge', async () => {
    const root = path.join(vaultDir, 'Artifacts', 'threads-artifacts', 'bad-edge');
    await fs.mkdir(root, { recursive: true });
    await expect(
      addArtboardToBoard(root, { name: 'Step 2', fromArtboardId: 'missing-id' }, nodeFs, normalizeHostTheme('dark', {}), vaultDir),
    ).rejects.toThrow('missing-id');
  });
});


describe('short board titles', () => {
  it('derives a short first-clause title and caps length', () => {
    expect(shortDesignTitle('Pricing page: three tiers, a comparison table and an FAQ for the new plan')).toBe('Pricing page');
    expect(shortDesignTitle('Design a multi-screen onboarding flow for new mobile users of the banking app')).toMatch(/^.{1,48}…$/);
    expect(shortDesignTitle('Dashboard')).toBe('Dashboard');
    expect(shortDesignTitle('')).toBe('Design artifact');
  });

  it('keeps full titles for single-screen manifests and shortens for boards', () => {
    const brief = 'Settings screen, with profile, billing and notification sections for the app';
    expect(buildDesignManifest('t', brief).title).toBe(brief);
    expect(buildDesignManifest('t', brief, 'static', { shortTitle: true }).title).toBe('Settings screen');
  });
});
