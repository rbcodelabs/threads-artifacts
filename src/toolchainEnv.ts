import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { nodeCommandRunner, type CommandRunner } from './commandRunner';

/**
 * Environment for every external command the plugin spawns (npm install, next dev, next build, zip).
 *
 * A Dock/Finder-launched Geode inherits only PATH=/usr/bin:/bin:/usr/sbin:/sbin, so a bare `npm` fails
 * with ENOENT even though Node is installed. And npm is itself a `#!/usr/bin/env node` script, so PATH
 * must also reach a directory containing `node`. This module builds one augmented PATH (the original
 * entries first, then well-known install locations that exist, then the user's login-shell PATH),
 * resolves npm to an absolute path against it, and never throws.
 */

export const LOGIN_SHELL_BEGIN = '__THREADS_DESIGN_PATH_BEGIN__';
export const LOGIN_SHELL_END = '__THREADS_DESIGN_PATH_END__';
const PROBE_TIMEOUT_MS = 5000;
const MAX_PROBE_PATH = 8192;
const SUPPORTED_SHELLS = new Set(['bash', 'zsh', 'fish', 'sh', 'dash', 'ksh']);
const SAFE_SHELL_PATH = /^\/[A-Za-z0-9_./+-]+$/;
/** printf with fixed text only: works in POSIX shells and fish; "$PATH" is expanded by the shell itself. */
const PROBE_SCRIPT = `printf '%s%s%s' '${LOGIN_SHELL_BEGIN}' "$PATH" '${LOGIN_SHELL_END}'`;

export interface ToolchainEnvFs {
  access(target: string, mode?: number): Promise<unknown>;
  readdir(target: string): Promise<string[]>;
}

export interface ToolchainEnvOptions {
  env?: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
  homedir?: string;
  fs?: ToolchainEnvFs;
  /** Runs the login-shell probe; defaults to a real process runner. */
  probe?: CommandRunner;
}

export type NpmResolution = { ok: true; command: string } | { ok: false; message: string };

export interface ToolchainEnv {
  /** Computes (once) the augmented PATH; always resolves. */
  ready(): Promise<void>;
  path(): Promise<string>;
  /** `{ PATH }` (or `{ Path }` on Windows) to merge over process.env. */
  env(): Promise<Record<string, string>>;
  /** Synchronous view of `env()`; empty until `ready()` has resolved. */
  cachedEnv(): Record<string, string>;
  resolveNpm(): Promise<NpmResolution>;
}

const defaultFs: ToolchainEnvFs = { access: (target, mode) => fs.access(target, mode), readdir: target => fs.readdir(target) };

/** The login-shell PATH never changes while the plugin runs, so one probe serves the whole process. */
const probeCache = new Map<string, Promise<string[]>>();
export function resetToolchainProbeCache(): void { probeCache.clear(); }

const exists = async (fileFs: ToolchainEnvFs, target: string, mode?: number): Promise<boolean> => {
  try { await fileFs.access(target, mode); return true; } catch { return false; }
};

function parseVersion(name: string): number[] | null {
  const match = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(name);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

export function createToolchainEnv(options: ToolchainEnvOptions = {}): ToolchainEnv {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const fileFs = options.fs ?? defaultFs;
  const home = options.homedir ?? os.homedir();
  const win = platform === 'win32';
  const p = win ? path.win32 : path.posix;
  const delimiter = win ? ';' : ':';
  const pathKey = win ? Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'Path' : 'PATH';
  const originalPath = env[pathKey] ?? env.PATH ?? '';
  const exeName = win ? 'npm.cmd' : 'npm';
  const xOk = win ? undefined : fsConstants.X_OK;
  const isAbsolute = (value: string): boolean => p.isAbsolute(value);

  let computed: Promise<string[]> | null = null;
  let cached: Record<string, string> = {};
  let overrideDir: string | null = null;
  let overrideProblem: string | null = null;

  async function nvmBin(): Promise<string[]> {
    const base = p.join(home, '.nvm', 'versions', 'node');
    try {
      const versions = (await fileFs.readdir(base)).map(name => ({ name, parsed: parseVersion(name) })).filter((v): v is { name: string; parsed: number[] } => v.parsed !== null);
      versions.sort((a, b) => compareVersions(b.parsed, a.parsed));
      return versions.length > 0 ? [p.join(base, versions[0].name, 'bin')] : [];
    } catch {
      return [];
    }
  }

  async function wellKnown(): Promise<string[]> {
    const candidates = win
      ? [env.ProgramFiles ? p.join(env.ProgramFiles, 'nodejs') : '', env.APPDATA ? p.join(env.APPDATA, 'npm') : ''].filter(Boolean)
      : [
        '/opt/homebrew/bin',
        '/opt/homebrew/opt/node/bin',
        '/usr/local/bin',
        p.join(home, '.volta', 'bin'),
        p.join(home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin'),
        p.join(home, 'Library', 'Application Support', 'fnm', 'aliases', 'default', 'bin'),
        p.join(home, '.local', 'share', 'mise', 'shims'),
        p.join(home, '.asdf', 'shims'),
        ...(await nvmBin()),
      ];
    const found: string[] = [];
    for (const dir of candidates) if (await exists(fileFs, dir)) found.push(dir);
    return found;
  }

  async function loginShellPath(): Promise<string[]> {
    const shell = env.SHELL;
    if (win || !shell || !SAFE_SHELL_PATH.test(shell) || !isAbsolute(shell) || !SUPPORTED_SHELLS.has(p.basename(shell))) return [];
    if (!(await exists(fileFs, shell))) return [];
    let pending = probeCache.get(shell);
    if (!pending) {
      pending = runProbe(shell).catch(() => []);
      probeCache.set(shell, pending);
    }
    return pending;
  }

  async function runProbe(shell: string): Promise<string[]> {
    const run = options.probe ?? nodeCommandRunner();
    const outcome = await run({ command: shell, args: ['-ilc', PROBE_SCRIPT], cwd: home, timeoutMs: PROBE_TIMEOUT_MS });
    if (outcome.error || outcome.timedOut || outcome.code !== 0) return [];
    // Rc files may print anything; only the text between our markers (the last occurrence) counts.
    const begin = outcome.stdout.lastIndexOf(LOGIN_SHELL_BEGIN);
    if (begin < 0) return [];
    const end = outcome.stdout.indexOf(LOGIN_SHELL_END, begin + LOGIN_SHELL_BEGIN.length);
    if (end < 0) return [];
    const value = outcome.stdout.slice(begin + LOGIN_SHELL_BEGIN.length, end);
    if (value.length === 0 || value.length > MAX_PROBE_PATH || /[\r\n\0]/.test(value)) return [];
    return value.split(':').filter(entry => entry.length > 0 && isAbsolute(entry));
  }

  async function compute(): Promise<string[]> {
    const entries: string[] = [];
    const add = (entry: string) => { if (entry && !entries.includes(entry)) entries.push(entry); };
    originalPath.split(delimiter).forEach(add);

    const override = env.THREADS_DESIGN_NPM;
    if (override !== undefined && override !== '') {
      if (isAbsolute(override) && await exists(fileFs, override, xOk)) overrideDir = p.dirname(override);
      else overrideProblem = `THREADS_DESIGN_NPM is set to "${override}" but that file is not usable (it must be an absolute path to an executable npm).`;
    }
    if (overrideDir) add(overrideDir);
    (await wellKnown()).forEach(add);
    (await loginShellPath()).forEach(add);
    return entries;
  }

  const entriesOnce = (): Promise<string[]> => {
    computed ??= compute().then(entries => {
      cached = { [pathKey]: entries.join(delimiter) };
      return entries;
    }, () => {
      const fallback = originalPath.split(delimiter).filter(Boolean);
      cached = { [pathKey]: fallback.join(delimiter) };
      return fallback;
    });
    return computed;
  };

  const notFoundMessage = (searched: string[]): string => {
    const lines = [
      `npm was not found. Searched: ${searched.length > 0 ? searched.join(', ') : '(no directories)'}.`,
      `Geode was started with PATH=${originalPath}.`,
      overrideProblem ?? '',
      'Fix: install Node.js (https://nodejs.org), or start Geode from a terminal so it inherits your PATH'
        + (platform === 'darwin' ? ', or run `launchctl setenv PATH "/opt/homebrew/bin:$PATH"` and restart Geode' : '')
        + ', or set THREADS_DESIGN_NPM to the full path of npm.',
    ];
    return lines.filter(Boolean).join(' ');
  };

  return {
    ready: async () => { await entriesOnce(); },
    path: async () => (await entriesOnce()).join(delimiter),
    env: async () => { await entriesOnce(); return { ...cached }; },
    cachedEnv: () => ({ ...cached }),
    async resolveNpm() {
      try {
        const entries = await entriesOnce();
        const override = env.THREADS_DESIGN_NPM;
        if (overrideDir && override) return { ok: true, command: override };
        for (const dir of entries) {
          const candidate = p.join(dir, exeName);
          if (await exists(fileFs, candidate, xOk)) return { ok: true, command: candidate };
        }
        return { ok: false, message: notFoundMessage(entries) };
      } catch {
        return { ok: false, message: notFoundMessage([]) };
      }
    },
  };
}

/** Wraps a runner so every command it runs sees the augmented PATH; a spec's own variables win. */
export function withToolchainEnv(run: CommandRunner, toolchainEnv: ToolchainEnv): CommandRunner {
  return async spec => run({ ...spec, env: { ...(await toolchainEnv.env()), ...spec.env } });
}
