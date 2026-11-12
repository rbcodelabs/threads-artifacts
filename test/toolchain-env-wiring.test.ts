import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandResult, CommandRunner, CommandSpec } from '../src/commandRunner';
import type { ServerProcess, ServerSpawnSpec } from '../src/devServerManager';
import { createNextjsRuntime } from '../src/nextjsRuntime';
import { NextjsToolchain, type ToolchainFs } from '../src/nextjsToolchain';
import { createToolchainEnv, resetToolchainProbeCache, type ToolchainEnvFs } from '../src/toolchainEnv';

const GUI_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const ok = (patch: Partial<CommandResult> = {}): CommandResult => ({ code: 0, stdout: '', stderr: '', timedOut: false, ...patch });
const noProbe: CommandRunner = async () => { throw new Error('no probe'); };

function envWith(present: string[]) {
  const have = new Set(present);
  const fs: ToolchainEnvFs = {
    access: async target => { if (!have.has(target)) throw new Error('ENOENT'); },
    readdir: async () => { throw new Error('ENOENT'); },
  };
  return createToolchainEnv({ env: { PATH: GUI_PATH }, platform: 'darwin', homedir: '/Users/rick', fs, probe: noProbe });
}

/** Toolchain file system: access succeeds only for `ready` paths; everything else is a no-op. */
function toolchainFs(ready: (target: string) => boolean): ToolchainFs {
  return {
    mkdir: async () => undefined,
    writeFile: async () => undefined,
    lstat: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    readlink: async () => '',
    symlink: async () => undefined,
    rm: async () => undefined,
    access: async target => { if (!ready(target)) throw new Error('ENOENT'); },
  };
}

beforeEach(() => resetToolchainProbeCache());

describe('NextjsToolchain.install with a toolchain environment', () => {
  it('runs npm by its absolute path with the augmented PATH', async () => {
    const specs: CommandSpec[] = [];
    const run: CommandRunner = async spec => { specs.push(spec); return ok(); };
    const toolchain = new NextjsToolchain({ cacheDir: '/cache', run, fs: toolchainFs(() => false), platform: 'darwin', toolchainEnv: envWith(['/opt/homebrew/bin', '/opt/homebrew/bin/npm']) });
    await toolchain.ensureTemplateInstall();
    expect(specs).toHaveLength(1);
    expect(specs[0].command).toBe('/opt/homebrew/bin/npm');
    expect(specs[0].env?.PATH?.split(':')).toContain('/opt/homebrew/bin');
    expect(specs[0].env?.PATH?.startsWith(GUI_PATH)).toBe(true);
  });

  it('fails with the clear message and the existing prefix, without running anything or leaving a partial install', async () => {
    const run = vi.fn<CommandRunner>(async () => ok());
    const fs = toolchainFs(() => false);
    const rm = vi.spyOn(fs, 'rm');
    const toolchain = new NextjsToolchain({ cacheDir: '/cache', run, fs, platform: 'darwin', toolchainEnv: envWith([]) });
    const failure = await toolchain.ensureTemplateInstall().then(() => null, (error: Error) => error);
    expect(run).not.toHaveBeenCalled();
    expect(failure?.message.startsWith('Could not install Next.js design dependencies: npm was not found')).toBe(true);
    expect(failure?.message).toContain(`PATH=${GUI_PATH}`);
    expect(failure?.message).toContain('launchctl setenv PATH');
    expect(rm).not.toHaveBeenCalled();
  });

  it('an explicit npmCommand still bypasses the search', async () => {
    const specs: CommandSpec[] = [];
    const toolchain = new NextjsToolchain({ cacheDir: '/cache', run: async spec => { specs.push(spec); return ok(); }, fs: toolchainFs(() => false), platform: 'darwin', npmCommand: '/custom/npm', toolchainEnv: envWith([]) });
    await toolchain.ensureTemplateInstall();
    expect(specs[0].command).toBe('/custom/npm');
  });

  it('adds a hint when npm starts but cannot find node (exit 127)', async () => {
    const run: CommandRunner = async () => ok({ code: 127, stderr: 'env: node: No such file or directory' });
    const toolchain = new NextjsToolchain({ cacheDir: '/cache', run, fs: toolchainFs(() => false), platform: 'darwin', toolchainEnv: envWith(['/opt/homebrew/bin', '/opt/homebrew/bin/npm']) });
    await expect(toolchain.ensureTemplateInstall()).rejects.toThrow(/node.*PATH/is);
  });

  it('exposes the augmented PATH in nodeEnv once ready, and only NODE_ENV before', async () => {
    const toolchainEnv = envWith(['/opt/homebrew/bin']);
    const toolchain = new NextjsToolchain({ cacheDir: '/cache', run: async () => ok(), fs: toolchainFs(() => false), toolchainEnv });
    expect(toolchain.nodeEnv.PATH).toBeUndefined();
    await toolchainEnv.ready();
    expect(toolchain.nodeEnv.PATH?.split(':')).toContain('/opt/homebrew/bin');
    expect(toolchain.nodeEnv.ELECTRON_RUN_AS_NODE).toBe('1');
  });
});

describe('(j) every spawn site receives the augmented PATH', () => {
  const fakeServer = (specs: ServerSpawnSpec[]) => (spec: ServerSpawnSpec): ServerProcess => {
    specs.push(spec);
    return { onOutput: () => undefined, onExit: () => undefined, kill: () => undefined };
  };

  function runtimeWith(ready: (target: string) => boolean) {
    const commands: CommandSpec[] = [];
    const servers: ServerSpawnSpec[] = [];
    const runtime = createNextjsRuntime({
      cacheDir: '/cache',
      run: async spec => { commands.push(spec); return ok(); },
      toolchainEnv: envWith(['/opt/homebrew/bin', '/opt/homebrew/bin/npm']),
      toolchainFs: toolchainFs(ready),
      spawnServer: fakeServer(servers),
      findFreePort: async () => 4321,
      isReady: async () => true,
      sleep: async () => undefined,
      exportOverrides: {
        scan: async () => [],
        tmpRoot: '/tmp',
        fs: {
          rm: async () => undefined,
          mkdir: async () => undefined,
          mkdtemp: async prefix => `${prefix}x`,
          cp: async () => undefined,
          access: async () => { throw new Error('ENOENT'); },
        },
      },
    });
    return { runtime, commands, servers };
  }

  const hasBrew = (env: Readonly<Record<string, string>> | undefined) => (env?.PATH ?? '').split(':').includes('/opt/homebrew/bin');

  it('npm install', async () => {
    const { runtime, commands } = runtimeWith(() => false);
    await runtime.toolchain.ensureTemplateInstall();
    expect(commands[0].command).toBe('/opt/homebrew/bin/npm');
    expect(hasBrew(commands[0].env)).toBe(true);
  });

  it('next dev', async () => {
    const { runtime, servers } = runtimeWith(() => true);
    await runtime.devServers.ensure('art', '/art');
    expect(servers).toHaveLength(1);
    expect(hasBrew(servers[0].env)).toBe(true);
    runtime.dispose();
  });

  it('next build for the static export', async () => {
    const { runtime, commands } = runtimeWith(() => true);
    await runtime.provider.exportStatic({ id: 'art', root: '/art' });
    const build = commands.find(spec => spec.args.includes('build'));
    expect(build).toBeDefined();
    expect(hasBrew(build?.env)).toBe(true);
  });

  it('any other command the runtime runs, such as zip or tar, gets it too', async () => {
    const { runtime, commands } = runtimeWith(() => true);
    await runtime.provider.exportStatic({ id: 'art', root: '/art' });
    expect(commands.length).toBeGreaterThan(0);
    for (const spec of commands) expect(hasBrew(spec.env), spec.command).toBe(true);
  });
});
