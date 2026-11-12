import * as path from 'node:path';
import { constants as fsConstants } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandResult, CommandRunner } from '../src/commandRunner';
import { createToolchainEnv, resetToolchainProbeCache, withToolchainEnv, type ToolchainEnvFs } from '../src/toolchainEnv';

const posix = path.posix;
const win = path.win32;
const GUI_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const HOME = '/Users/rick';

/** In-memory filesystem: `files` and `dirs` are the paths that exist; `listing` backs readdir. Never touches the real disk. */
function memoryFs(entries: { files?: string[]; dirs?: string[]; listing?: Record<string, string[]>; notExecutable?: string[] }): ToolchainEnvFs & { accessed: string[] } {
  const present = new Set([...(entries.files ?? []), ...(entries.dirs ?? [])]);
  const accessed: string[] = [];
  return {
    accessed,
    access: async (target, mode) => {
      accessed.push(target);
      if (!present.has(target)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      if (mode === fsConstants.X_OK && entries.notExecutable?.includes(target)) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    },
    stat: async target => {
      if (entries.files?.includes(target)) return { isFile: () => true };
      if (present.has(target)) return { isFile: () => false };
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    readdir: async target => {
      const names = entries.listing?.[target];
      if (!names) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return names;
    },
  };
}

const MARK_BEGIN = '__THREADS_DESIGN_PATH_BEGIN__';
const MARK_END = '__THREADS_DESIGN_PATH_END__';
const result = (patch: Partial<CommandResult> = {}): CommandResult => ({ code: 0, stdout: '', stderr: '', timedOut: false, ...patch });
const noProbe: CommandRunner = async () => { throw new Error('the login shell must not be probed here'); };

function make(opts: { files?: string[]; dirs?: string[]; listing?: Record<string, string[]>; notExecutable?: string[]; env?: Record<string, string | undefined>; probe?: CommandRunner; platform?: NodeJS.Platform; homedir?: string }) {
  const fs = memoryFs(opts);
  const toolchain = createToolchainEnv({
    env: opts.env ?? { PATH: GUI_PATH },
    platform: opts.platform ?? 'darwin',
    homedir: opts.homedir ?? HOME,
    fs,
    probe: opts.probe ?? noProbe,
  });
  return { toolchain, fs };
}

beforeEach(() => resetToolchainProbeCache());

describe('npm resolution on a GUI-launched process (the reported failure)', () => {
  it('(a) finds npm under /opt/homebrew/bin, keeps the original PATH first and appends the new directory', async () => {
    const { toolchain } = make({ dirs: ['/opt/homebrew/bin'], files: ['/opt/homebrew/bin/npm'] });
    expect(await toolchain.resolveNpm()).toEqual({ ok: true, command: '/opt/homebrew/bin/npm' });
    const searchPath = await toolchain.path();
    expect(searchPath.startsWith(GUI_PATH)).toBe(true);
    expect(searchPath.split(':')).toContain('/opt/homebrew/bin');
    expect((await toolchain.env()).PATH).toBe(searchPath);
  });

  it('(b) finds npm in the fnm default alias directory', async () => {
    const bin = posix.join(HOME, '.local/share/fnm/aliases/default/bin');
    const { toolchain } = make({ dirs: [bin], files: [posix.join(bin, 'npm')] });
    expect(await toolchain.resolveNpm()).toEqual({ ok: true, command: posix.join(bin, 'npm') });
    expect((await toolchain.path()).split(':')).toContain(bin);
  });

  it('(b) also checks the macOS fnm location and Volta, mise and asdf shims', async () => {
    for (const rel of ['Library/Application Support/fnm/aliases/default/bin', '.volta/bin', '.local/share/mise/shims', '.asdf/shims']) {
      resetToolchainProbeCache();
      const bin = posix.join(HOME, rel);
      const { toolchain } = make({ dirs: [bin], files: [posix.join(bin, 'npm')] });
      expect(await toolchain.resolveNpm(), rel).toEqual({ ok: true, command: posix.join(bin, 'npm') });
    }
  });

  it('(c) picks the newest nvm node version by semver, not by string order', async () => {
    const base = posix.join(HOME, '.nvm/versions/node');
    const newest = posix.join(base, 'v20.11.1', 'bin');
    const { toolchain } = make({
      dirs: [base, posix.join(base, 'v9.0.0', 'bin'), posix.join(base, 'v18.19.0', 'bin'), newest, posix.join(base, 'v20.9.0', 'bin')],
      files: [posix.join(newest, 'npm'), posix.join(base, 'v18.19.0', 'bin', 'npm')],
      listing: { [base]: ['v18.19.0', 'v9.0.0', 'v20.9.0', 'v20.11.1', 'not-a-version', '.DS_Store'] },
    });
    expect(await toolchain.resolveNpm()).toEqual({ ok: true, command: posix.join(newest, 'npm') });
    const entries = (await toolchain.path()).split(':');
    expect(entries).toContain(newest);
    expect(entries.some(entry => entry.includes('v18.19.0'))).toBe(false);
  });

  it('(c) ignores an unreadable nvm directory', async () => {
    const { toolchain } = make({ dirs: [], files: [] });
    expect((await toolchain.resolveNpm()).ok).toBe(false);
  });

  it('does not add well-known directories that do not exist', async () => {
    const { toolchain } = make({ dirs: ['/usr/local/bin'] });
    const entries = (await toolchain.path()).split(':');
    expect(entries).toContain('/usr/local/bin');
    expect(entries).not.toContain('/opt/homebrew/bin');
  });

  it('prefers a directory that is already on PATH over a well-known one', async () => {
    const { toolchain } = make({ env: { PATH: `/first/bin:${GUI_PATH}` }, dirs: ['/first/bin', '/opt/homebrew/bin'], files: ['/first/bin/npm', '/opt/homebrew/bin/npm'] });
    expect(await toolchain.resolveNpm()).toEqual({ ok: true, command: '/first/bin/npm' });
  });
});

describe('(d) login-shell PATH probe', () => {
  const SHELL = '/bin/zsh';
  const probeOutput = (value: string, noise = '') => `${noise}${MARK_BEGIN}${value}${MARK_END}`;
  const withShell = (probe: CommandRunner, extra: { dirs?: string[]; files?: string[]; env?: Record<string, string | undefined> } = {}) =>
    make({ env: { PATH: GUI_PATH, SHELL, ...extra.env }, dirs: [SHELL, ...(extra.dirs ?? [])], files: [SHELL, ...(extra.files ?? [])], probe });

  it('uses PATH entries reported by the login shell and calls it with fixed arguments', async () => {
    const probe = vi.fn<CommandRunner>(async () => result({ stdout: probeOutput('/custom/bin:/Users/rick/n/bin') }));
    const { toolchain } = withShell(probe, { dirs: ['/custom/bin'], files: ['/custom/bin/npm'] });
    expect(await toolchain.resolveNpm()).toEqual({ ok: true, command: '/custom/bin/npm' });
    const spec = probe.mock.calls[0][0];
    expect(spec.command).toBe(SHELL);
    expect(spec.args[0]).toBe('-ilc');
    expect(spec.args).toHaveLength(2);
    expect(spec.args[1]).toContain('$PATH');
    expect(spec.args[1]).toContain(MARK_BEGIN);
    expect(spec.timeoutMs).toBe(5000);
    expect(spec.args[1]).not.toContain(HOME);
  });

  it('parses the marked region even when rc files print noise before and after it', async () => {
    const stdout = `Welcome back!\nnvm: using v20\n${MARK_BEGIN}/custom/bin:${MARK_BEGIN.slice(0, 5)}\n${MARK_END}\ntrailing banner`;
    const probe: CommandRunner = async () => result({ stdout: `fake rc noise\n${probeOutput('/custom/bin')}\nmore noise ${MARK_END}`, stderr: stdout });
    const { toolchain } = withShell(probe, { dirs: ['/custom/bin'], files: ['/custom/bin/npm'] });
    expect(await toolchain.resolveNpm()).toEqual({ ok: true, command: '/custom/bin/npm' });
  });

  it('drops relative and empty entries from the reported PATH', async () => {
    const probe: CommandRunner = async () => result({ stdout: probeOutput('./evil:relative/bin::/custom/bin') });
    const { toolchain } = withShell(probe, { dirs: ['/custom/bin'], files: ['/custom/bin/npm'] });
    await toolchain.resolveNpm();
    const entries = (await toolchain.path()).split(':');
    expect(entries).toContain('/custom/bin');
    expect(entries).not.toContain('./evil');
    expect(entries).not.toContain('relative/bin');
    expect(entries).not.toContain('');
  });

  it.each([
    ['a timeout', result({ code: null, timedOut: true })],
    ['a non-zero exit', result({ code: 1, stdout: probeOutput('/custom/bin') })],
    ['a spawn error', result({ code: null, error: 'spawn ENOENT' })],
    ['missing markers', result({ stdout: '/custom/bin' })],
    ['an end marker before the begin marker', result({ stdout: `${MARK_END}/custom/bin${MARK_BEGIN}` })],
    ['an empty value', result({ stdout: probeOutput('') })],
    ['an oversized value', result({ stdout: probeOutput(`/a:${'x'.repeat(20_000)}`) })],
  ])('ignores %s from the probe without failing', async (_label, outcome) => {
    const { toolchain } = withShell(async () => outcome, { dirs: ['/custom/bin'], files: ['/custom/bin/npm'] });
    expect((await toolchain.resolveNpm()).ok).toBe(false);
    expect(await toolchain.path()).toBe(GUI_PATH);
  });

  it('ignores a probe that throws', async () => {
    const { toolchain } = withShell(async () => { throw new Error('boom'); });
    expect((await toolchain.resolveNpm()).ok).toBe(false);
    expect(await toolchain.path()).toBe(GUI_PATH);
  });

  it.each([
    ['unset', undefined],
    ['relative', 'zsh'],
    ['empty', ''],
    ['an unsupported shell', '/usr/bin/csh'],
    ['a path with a newline', '/bin/zsh\n-c evil'],
  ])('does not run the probe when $SHELL is %s', async (_label, shell) => {
    const probe = vi.fn<CommandRunner>(async () => result({ stdout: probeOutput('/custom/bin') }));
    const { toolchain } = make({ env: { PATH: GUI_PATH, SHELL: shell }, dirs: ['/bin/zsh', '/usr/bin/csh', '/bin/zsh\n-c evil'], files: ['/bin/zsh', '/usr/bin/csh', '/bin/zsh\n-c evil'], probe });
    await toolchain.resolveNpm();
    expect(probe).not.toHaveBeenCalled();
  });

  it('does not run the probe when $SHELL does not exist', async () => {
    const probe = vi.fn<CommandRunner>(async () => result({ stdout: probeOutput('/custom/bin') }));
    const { toolchain } = make({ env: { PATH: GUI_PATH, SHELL: '/bin/zsh' }, probe });
    await toolchain.resolveNpm();
    expect(probe).not.toHaveBeenCalled();
  });

  it.each(['/bin/bash', '/bin/zsh', '/opt/homebrew/bin/fish', '/bin/sh', '/bin/dash', '/bin/ksh'])('supports %s', async shell => {
    const probe = vi.fn<CommandRunner>(async () => result({ stdout: probeOutput('/custom/bin') }));
    const { toolchain } = make({ env: { PATH: GUI_PATH, SHELL: shell }, dirs: [shell], files: [shell], probe });
    await toolchain.resolveNpm();
    expect(probe).toHaveBeenCalledOnce();
    expect(probe.mock.calls[0][0].command).toBe(shell);
  });

  it('(g) probes once per process, shared by every instance and every call', async () => {
    const probe = vi.fn<CommandRunner>(async () => result({ stdout: probeOutput('/custom/bin') }));
    const first = withShell(probe);
    await first.toolchain.resolveNpm();
    await first.toolchain.resolveNpm();
    await first.toolchain.path();
    const second = withShell(probe);
    await second.toolchain.resolveNpm();
    expect(probe).toHaveBeenCalledOnce();
  });

  it('(g) concurrent callers share one probe', async () => {
    const probe = vi.fn<CommandRunner>(async () => result({ stdout: probeOutput('/custom/bin') }));
    const { toolchain } = withShell(probe);
    await Promise.all([toolchain.resolveNpm(), toolchain.resolveNpm(), toolchain.resolveNpm()]);
    expect(probe).toHaveBeenCalledOnce();
  });

  it('does not probe on win32', async () => {
    const probe = vi.fn<CommandRunner>(async () => result({ stdout: probeOutput('/custom/bin') }));
    const { toolchain } = make({ platform: 'win32', env: { Path: 'C:\\Windows\\System32', SHELL: '/bin/zsh' }, probe });
    await toolchain.resolveNpm();
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('(e) npm genuinely absent', () => {
  it('names what was searched, the original PATH and the fixes', async () => {
    const { toolchain } = make({ dirs: ['/usr/local/bin'] });
    const resolution = await toolchain.resolveNpm();
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    const message = resolution.message;
    for (const dir of ['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/usr/local/bin']) expect(message).toContain(dir);
    expect(message).toContain(`PATH=${GUI_PATH}`);
    expect(message).toMatch(/install Node\.js/i);
    expect(message).toMatch(/start Geode from a terminal/i);
    expect(message).toContain('launchctl setenv PATH "/opt/homebrew/bin:$PATH"');
    expect(message).toContain('THREADS_DESIGN_NPM');
    expect(message.length).toBeLessThan(1500);
    expect(message).not.toContain(HOME);
  });

  it('omits the launchctl advice off macOS', async () => {
    const { toolchain } = make({ platform: 'linux' });
    const resolution = await toolchain.resolveNpm();
    expect(!resolution.ok && resolution.message).not.toContain('launchctl');
  });

  it('handles an empty or missing PATH', async () => {
    for (const env of [{ PATH: '' }, {}]) {
      const { toolchain } = make({ env });
      const resolution = await toolchain.resolveNpm();
      expect(resolution.ok).toBe(false);
      expect(!resolution.ok && resolution.message).toContain('PATH=');
    }
  });
});

describe('(f) win32', () => {
  const programFiles = 'C:\\Program Files';
  const appData = 'C:\\Users\\rick\\AppData\\Roaming';
  const env = { Path: 'C:\\Windows\\System32;C:\\Windows', ProgramFiles: programFiles, APPDATA: appData };

  it('resolves npm.cmd under %ProgramFiles%\\nodejs and uses the Path key with semicolons', async () => {
    const bin = win.join(programFiles, 'nodejs');
    const { toolchain } = make({ platform: 'win32', env, homedir: 'C:\\Users\\rick', dirs: [bin], files: [win.join(bin, 'npm.cmd')] });
    expect(await toolchain.resolveNpm()).toEqual({ ok: true, command: win.join(bin, 'npm.cmd') });
    const built = await toolchain.env();
    expect(Object.keys(built)).toEqual(['Path']);
    expect(built.Path.startsWith('C:\\Windows\\System32;C:\\Windows')).toBe(true);
    expect(built.Path.split(';')).toContain(bin);
  });

  it('falls back to %APPDATA%\\npm', async () => {
    const bin = win.join(appData, 'npm');
    const { toolchain } = make({ platform: 'win32', env, dirs: [bin], files: [win.join(bin, 'npm.cmd')] });
    expect(await toolchain.resolveNpm()).toEqual({ ok: true, command: win.join(bin, 'npm.cmd') });
  });

  it('does not offer POSIX directories on win32', async () => {
    const { toolchain } = make({ platform: 'win32', env, dirs: ['/opt/homebrew/bin'] });
    expect((await toolchain.path()).includes('/opt/homebrew')).toBe(false);
  });
});

describe('(h) THREADS_DESIGN_NPM override', () => {
  it('uses an absolute, existing override first and adds its directory to PATH', async () => {
    const { toolchain } = make({ env: { PATH: GUI_PATH, THREADS_DESIGN_NPM: '/opt/custom/bin/npm' }, dirs: ['/opt/homebrew/bin'], files: ['/opt/custom/bin/npm', '/opt/homebrew/bin/npm'] });
    expect(await toolchain.resolveNpm()).toEqual({ ok: true, command: '/opt/custom/bin/npm' });
    expect((await toolchain.path()).split(':')).toContain('/opt/custom/bin');
  });

  it.each([['a relative path', 'npm'], ['a missing file', '/does/not/exist/npm'], ['an empty value', '']])('ignores %s and falls back to the normal search', async (_label, value) => {
    const { toolchain } = make({ env: { PATH: GUI_PATH, THREADS_DESIGN_NPM: value }, dirs: ['/opt/homebrew/bin'], files: ['/opt/homebrew/bin/npm'] });
    expect(await toolchain.resolveNpm()).toEqual({ ok: true, command: '/opt/homebrew/bin/npm' });
  });

  it('mentions an unusable override in the not-found message', async () => {
    const { toolchain } = make({ env: { PATH: GUI_PATH, THREADS_DESIGN_NPM: '/does/not/exist/npm' } });
    const resolution = await toolchain.resolveNpm();
    expect(!resolution.ok && resolution.message).toContain('THREADS_DESIGN_NPM is set to "/does/not/exist/npm" but that file is not usable');
  });
});

describe('(i) PATH de-duplication and ordering', () => {
  it('keeps the original order, drops duplicates and empty entries, and never repeats a well-known directory', async () => {
    const { toolchain } = make({ env: { PATH: '/usr/bin::/opt/homebrew/bin:/usr/bin:/bin:' }, dirs: ['/opt/homebrew/bin', '/usr/local/bin'] });
    expect(await toolchain.path()).toBe('/usr/bin:/opt/homebrew/bin:/bin:/usr/local/bin');
  });

  it('returns a stable, cached value', async () => {
    const { toolchain, fs } = make({ dirs: ['/opt/homebrew/bin'] });
    const first = await toolchain.path();
    const checks = fs.accessed.length;
    expect(await toolchain.path()).toBe(first);
    expect(fs.accessed.length).toBe(checks);
  });

  it('cachedEnv is empty before ready and holds PATH afterwards', async () => {
    const { toolchain } = make({});
    expect(toolchain.cachedEnv()).toEqual({});
    await toolchain.ready();
    expect(toolchain.cachedEnv()).toEqual({ PATH: GUI_PATH });
  });

  it('never throws when the filesystem misbehaves', async () => {
    const toolchain = createToolchainEnv({
      env: { PATH: GUI_PATH }, platform: 'darwin', homedir: HOME, probe: noProbe,
      fs: { access: async () => { throw new Error('EIO'); }, readdir: async () => { throw new Error('EIO'); } },
    });
    expect(await toolchain.path()).toBe(GUI_PATH);
    expect((await toolchain.resolveNpm()).ok).toBe(false);
  });
});

describe('withToolchainEnv', () => {
  it('adds the augmented PATH to every command and lets a spec keep its own variables', async () => {
    const { toolchain } = make({ dirs: ['/opt/homebrew/bin'] });
    const seen: Array<Record<string, string> | undefined> = [];
    const run = withToolchainEnv(async spec => { seen.push(spec.env as Record<string, string> | undefined); return result(); }, toolchain);
    await run({ command: 'zip', args: [], cwd: '/x' });
    await run({ command: 'node', args: [], cwd: '/x', env: { NEXT_TELEMETRY_DISABLED: '1' } });
    expect(seen[0]?.PATH).toContain('/opt/homebrew/bin');
    expect(seen[1]).toMatchObject({ NEXT_TELEMETRY_DISABLED: '1' });
    expect(seen[1]?.PATH).toContain('/opt/homebrew/bin');
  });
});

describe('A2: the login shell is probed lazily', () => {
  const SHELL = '/bin/zsh';
  const spawned = () => vi.fn<CommandRunner>(async () => result({ stdout: `${MARK_BEGIN}/custom/bin${MARK_END}` }));

  it('never runs the user\'s rc files when npm is found on the original PATH plus well-known directories', async () => {
    const probe = spawned();
    const { toolchain } = make({ env: { PATH: GUI_PATH, SHELL }, dirs: ['/opt/homebrew/bin'], files: [SHELL, '/opt/homebrew/bin/npm'], probe });
    await toolchain.ready();
    await toolchain.env();
    await toolchain.path();
    expect(await toolchain.resolveNpm()).toEqual({ ok: true, command: '/opt/homebrew/bin/npm' });
    expect(probe).not.toHaveBeenCalled();
  });

  it('runs it only after the cheap search failed, then folds its entries into PATH', async () => {
    const probe = spawned();
    const { toolchain } = make({ env: { PATH: GUI_PATH, SHELL }, dirs: ['/custom/bin'], files: [SHELL, '/custom/bin/npm'], probe });
    expect((await toolchain.path()).includes('/custom/bin')).toBe(false);
    expect(probe).not.toHaveBeenCalled();
    expect(await toolchain.resolveNpm()).toEqual({ ok: true, command: '/custom/bin/npm' });
    expect(probe).toHaveBeenCalledOnce();
    expect((await toolchain.env()).PATH.split(':')).toContain('/custom/bin');
  });
});

describe('probe deadline: a probe that never settles cannot hang anything', () => {
  const SHELL = '/bin/zsh';
  const never: CommandRunner = () => new Promise<CommandResult>(() => undefined);
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('resolveNpm settles with not-found after the deadline, without waiting for the runner', async () => {
    const { toolchain } = make({ env: { PATH: GUI_PATH, SHELL }, files: [SHELL], probe: never });
    const pending = toolchain.resolveNpm();
    await vi.advanceTimersByTimeAsync(7000);
    expect((await pending).ok).toBe(false);
    expect(await toolchain.path()).toBe(GUI_PATH);
  });

  it('caches the settled empty result instead of a pending promise', async () => {
    const probe = vi.fn<CommandRunner>(never);
    const first = make({ env: { PATH: GUI_PATH, SHELL }, files: [SHELL], probe });
    const pending = first.toolchain.resolveNpm();
    await vi.advanceTimersByTimeAsync(7000);
    await pending;
    const second = make({ env: { PATH: GUI_PATH, SHELL }, files: [SHELL], probe });
    expect((await second.toolchain.resolveNpm()).ok).toBe(false); // immediate: no timers advanced
    expect(probe).toHaveBeenCalledOnce();
  });

  it('a runner whose output arrives but whose promise (close) never settles is also bounded', async () => {
    const outputOnly: CommandRunner = () => new Promise<CommandResult>(() => undefined);
    const { toolchain } = make({ env: { PATH: GUI_PATH, SHELL }, files: [SHELL], probe: outputOnly });
    const ready = toolchain.ready();
    await ready; // ready() itself never waits for the lazy probe
    const pending = toolchain.resolveNpm();
    await vi.advanceTimersByTimeAsync(6500);
    expect((await pending).ok).toBe(false);
  });

  it('asks the runner to kill the whole process tree on timeout', async () => {
    const probe = vi.fn<CommandRunner>(never);
    const { toolchain } = make({ env: { PATH: GUI_PATH, SHELL }, files: [SHELL], probe });
    const pending = toolchain.resolveNpm();
    await vi.advanceTimersByTimeAsync(7000);
    await pending;
    expect(probe.mock.calls[0][0].killTree).toBe(true);
  });
});

describe('A3/A4/A5/A6 hardening', () => {
  it('A3: a $SHELL that is not executable is never run', async () => {
    const probe = vi.fn<CommandRunner>(async () => result({ stdout: `${MARK_BEGIN}/custom/bin${MARK_END}` }));
    const { toolchain } = make({ env: { PATH: GUI_PATH, SHELL: '/bin/zsh' }, files: ['/bin/zsh'], notExecutable: ['/bin/zsh'], probe });
    await toolchain.resolveNpm();
    expect(probe).not.toHaveBeenCalled();
  });

  it('A3: a $SHELL that is a directory is never run', async () => {
    const probe = vi.fn<CommandRunner>(async () => result({ stdout: `${MARK_BEGIN}/custom/bin${MARK_END}` }));
    const { toolchain } = make({ env: { PATH: GUI_PATH, SHELL: '/bin/zsh' }, dirs: ['/bin/zsh'], probe });
    await toolchain.resolveNpm();
    expect(probe).not.toHaveBeenCalled();
  });

  it('A4: a directory named npm is not accepted, the next real file is', async () => {
    const { toolchain } = make({ env: { PATH: '/first/bin:/opt/homebrew/bin' }, dirs: ['/first/bin', '/first/bin/npm', '/opt/homebrew/bin'], files: ['/opt/homebrew/bin/npm'] });
    expect(await toolchain.resolveNpm()).toEqual({ ok: true, command: '/opt/homebrew/bin/npm' });
  });

  it('A4: a non-executable npm file is skipped', async () => {
    const { toolchain } = make({ env: { PATH: '/first/bin:/opt/homebrew/bin' }, dirs: ['/first/bin', '/opt/homebrew/bin'], files: ['/first/bin/npm', '/opt/homebrew/bin/npm'], notExecutable: ['/first/bin/npm'] });
    expect(await toolchain.resolveNpm()).toEqual({ ok: true, command: '/opt/homebrew/bin/npm' });
  });

  it('A4: a THREADS_DESIGN_NPM that is a directory or not executable is rejected with a clear message', async () => {
    for (const patch of [{ dirs: ['/opt/custom/npm'] }, { files: ['/opt/custom/npm'], notExecutable: ['/opt/custom/npm'] }]) {
      resetToolchainProbeCache();
      const { toolchain } = make({ env: { PATH: GUI_PATH, THREADS_DESIGN_NPM: '/opt/custom/npm' }, ...patch });
      const resolution = await toolchain.resolveNpm();
      expect(resolution.ok).toBe(false);
      expect(!resolution.ok && resolution.message).toContain('THREADS_DESIGN_NPM is set to "/opt/custom/npm" but that file is not usable');
    }
  });

  it('A5: relative and empty entries in the original PATH are dropped, so npm can never resolve to a relative path', async () => {
    const { toolchain } = make({ env: { PATH: '.:rel/bin::bin:/usr/bin' }, dirs: ['rel/bin', 'bin', '.'], files: ['rel/bin/npm', 'bin/npm', 'npm'] });
    expect(await toolchain.path()).toBe('/usr/bin');
    expect((await toolchain.resolveNpm()).ok).toBe(false);
  });

  it('A6: the home directory is shown as ~ in the not-found message', async () => {
    const volta = posix.join(HOME, '.volta/bin');
    const { toolchain } = make({ env: { PATH: `${GUI_PATH}:${HOME}/mybin`, THREADS_DESIGN_NPM: `${HOME}/tools/npm` }, dirs: [volta, `${HOME}/mybin`] });
    const resolution = await toolchain.resolveNpm();
    const message = !resolution.ok ? resolution.message : '';
    expect(message).toContain('~/.volta/bin');
    expect(message).toContain('~/mybin');
    expect(message).toContain('THREADS_DESIGN_NPM is set to "~/tools/npm"');
    expect(message).not.toContain(HOME);
  });
});
