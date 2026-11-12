import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { CommandRunner } from './commandRunner';
import { nextjsPackageJson } from './nextjsTemplate';
import type { ToolchainEnv } from './toolchainEnv';

/** The subset of fs used by the toolchain; injectable for tests. */
export interface ToolchainFs {
  mkdir(target: string, options: { recursive: true }): Promise<unknown>;
  writeFile(target: string, data: string): Promise<unknown>;
  lstat(target: string): Promise<{ isSymbolicLink(): boolean }>;
  readlink(target: string): Promise<string>;
  symlink(target: string, linkPath: string, type?: 'junction' | 'dir'): Promise<unknown>;
  rm(target: string, options: { recursive: true; force: true }): Promise<unknown>;
  access(target: string): Promise<unknown>;
}

export interface NextjsToolchainOptions {
  /** Shared cache root, e.g. `<vault>/.geode/cache/design-nextjs`. */
  cacheDir: string;
  run: CommandRunner;
  fs?: ToolchainFs;
  /** Executable used to run Node scripts (`next dev` / `next build`). Electron needs ELECTRON_RUN_AS_NODE, which `nodeEnv` supplies. */
  nodeCommand?: string;
  npmCommand?: string;
  platform?: NodeJS.Platform;
  installTimeoutMs?: number;
  /** PATH augmentation and npm resolution for GUI-launched processes; without it the bare npm name is used. */
  toolchainEnv?: ToolchainEnv;
}

const READY_MARKER = '.design-template-ready';
export const NODE_ENV: Readonly<Record<string, string>> = Object.freeze({ ELECTRON_RUN_AS_NODE: '1', NEXT_TELEMETRY_DISABLED: '1' });

const exists = async (fileFs: ToolchainFs, target: string): Promise<boolean> => {
  try { await fileFs.access(target); return true; } catch { return false; }
};

/**
 * Avoids a full `npm install` per artifact: the pinned dependency set is
 * installed once into a shared cache directory and every nextjs artifact gets a
 * `node_modules` symlink to it. The cache key is a hash of the template
 * package.json, so bumping pinned versions installs a fresh copy exactly once.
 */
export class NextjsToolchain {
  private readonly fileFs: ToolchainFs;
  private installing: Promise<string> | null = null;

  constructor(private readonly options: NextjsToolchainOptions) {
    this.fileFs = options.fs ?? (fs as unknown as ToolchainFs);
  }

  get nodeCommand(): string { return this.options.nodeCommand ?? process.execPath; }
  /** NODE_ENV plus the augmented PATH once the toolchain environment is ready (callers await `ready()` first). */
  get nodeEnv(): Readonly<Record<string, string>> { return { ...NODE_ENV, ...(this.options.toolchainEnv?.cachedEnv() ?? {}) }; }

  nextBin(root: string): string { return path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next'); }

  templateDir(): string {
    const key = createHash('sha1').update(nextjsPackageJson('design-template')).digest('hex').slice(0, 12);
    return path.join(this.options.cacheDir, key);
  }

  /** Installs the shared dependency set once (concurrent callers share one install). Returns its node_modules path. */
  ensureTemplateInstall(): Promise<string> {
    this.installing ??= this.install().finally(() => { this.installing = null; });
    return this.installing;
  }

  private async install(): Promise<string> {
    const dir = this.templateDir();
    const modules = path.join(dir, 'node_modules');
    if (await exists(this.fileFs, path.join(dir, READY_MARKER)) && await exists(this.fileFs, modules)) return modules;

    let command = this.options.npmCommand;
    let env: Record<string, string> | undefined;
    if (this.options.toolchainEnv) {
      env = await this.options.toolchainEnv.env();
      if (!command) {
        const npm = await this.options.toolchainEnv.resolveNpm();
        if (!npm.ok) throw new Error(`Could not install Next.js design dependencies: ${npm.message}`);
        command = npm.command;
      }
    }
    command ??= (this.options.platform ?? process.platform) === 'win32' ? 'npm.cmd' : 'npm';

    // Anything present without the ready marker is a partial install; start clean.
    await this.fileFs.rm(dir, { recursive: true, force: true });
    await this.fileFs.mkdir(dir, { recursive: true });
    await this.fileFs.writeFile(path.join(dir, 'package.json'), nextjsPackageJson('design-template'));
    const result = await this.options.run({
      command,
      args: ['install', '--no-audit', '--no-fund', '--no-package-lock', '--loglevel=error'],
      cwd: dir,
      ...(env ? { env } : {}),
      timeoutMs: this.options.installTimeoutMs ?? 10 * 60_000,
    });
    if (result.error || result.code !== 0) {
      await this.fileFs.rm(dir, { recursive: true, force: true });
      const reason = result.error
        ? `${result.error} (is Node.js/npm installed and on PATH?)`
        : result.timedOut ? 'npm install timed out'
          : `npm install exited with code ${result.code}${/env: node|node: not found|node: No such file/i.test(result.stderr) ? ' (npm could not find node on PATH)' : ''}`;
      throw new Error(`Could not install Next.js design dependencies: ${reason}\n${(result.stderr || result.stdout).slice(-1500)}`.trim());
    }
    await this.fileFs.writeFile(path.join(dir, READY_MARKER), `${new Date().toISOString()}\n`);
    return modules;
  }

  /** Ensures `<root>/node_modules` resolves to the shared install. A real node_modules directory is left alone. */
  async ensureDependencies(root: string): Promise<void> {
    const target = await this.ensureTemplateInstall();
    const link = path.join(root, 'node_modules');
    let stat: Awaited<ReturnType<ToolchainFs['lstat']>> | undefined;
    try { stat = await this.fileFs.lstat(link); } catch { /* absent */ }
    if (stat) {
      if (!stat.isSymbolicLink()) return;
      if (await this.fileFs.readlink(link) === target) return;
      await this.fileFs.rm(link, { recursive: true, force: true });
    }
    await this.fileFs.symlink(target, link, (this.options.platform ?? process.platform) === 'win32' ? 'junction' : 'dir');
  }
}
