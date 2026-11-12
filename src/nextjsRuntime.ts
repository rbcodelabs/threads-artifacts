import { nodeCommandRunner, type CommandRunner } from './commandRunner';
import type { NextjsRuntimeDeps } from './designArtifactProvider';
import { exportStaticSite, type StaticExportDeps } from './designExport';
import {
  DevServerManager,
  nodeFindFreePort,
  nodeIsReady,
  nodeSchedule,
  nodeSleep,
  nodeSpawnServer,
  type DevServerDeps,
} from './devServerManager';
import { NextjsToolchain, type ToolchainFs } from './nextjsToolchain';
import { createToolchainEnv, withToolchainEnv, type ToolchainEnv } from './toolchainEnv';

export interface NextjsRuntime {
  toolchain: NextjsToolchain;
  devServers: DevServerManager;
  provider: NextjsRuntimeDeps;
  /** Stops every dev server; call on plugin unload. */
  dispose(): void;
}

export interface NextjsRuntimeOptions {
  cacheDir: string;
  run?: CommandRunner;
  /** Test seams; production uses the defaults. */
  toolchainEnv?: ToolchainEnv;
  toolchainFs?: ToolchainFs;
  spawnServer?: DevServerDeps['spawn'];
  findFreePort?: DevServerDeps['findFreePort'];
  isReady?: DevServerDeps['isReady'];
  sleep?: DevServerDeps['sleep'];
  exportOverrides?: Partial<Pick<StaticExportDeps, 'fs' | 'scan' | 'tmpRoot'>>;
}

/** Wires the real toolchain, dev-server manager and exporter together. */
export function createNextjsRuntime(options: NextjsRuntimeOptions): NextjsRuntime {
  // One shared place for the spawn environment: every command (npm install, next build, zip, tar) and every
  // dev server gets the augmented PATH, so a GUI-launched Geode finds npm and node.
  const toolchainEnv = options.toolchainEnv ?? createToolchainEnv();
  const run = withToolchainEnv(options.run ?? nodeCommandRunner(), toolchainEnv);
  const toolchain = new NextjsToolchain({ cacheDir: options.cacheDir, run, toolchainEnv, fs: options.toolchainFs });
  const devServers = new DevServerManager({
    commandFor: (root, port) => ({
      command: toolchain.nodeCommand,
      args: [toolchain.nextBin(root), 'dev', '--webpack', '-H', '127.0.0.1', '-p', String(port)],
      cwd: root,
      env: toolchain.nodeEnv,
    }),
    spawn: options.spawnServer ?? nodeSpawnServer,
    findFreePort: options.findFreePort ?? nodeFindFreePort,
    isReady: options.isReady ?? nodeIsReady,
    sleep: options.sleep ?? nodeSleep,
    schedule: nodeSchedule,
    beforeStart: async root => { await toolchainEnv.ready(); await toolchain.ensureDependencies(root); },
  });
  return {
    toolchain,
    devServers,
    provider: {
      devServers,
      exportStatic: async artifact => {
        await toolchainEnv.ready();
        return exportStaticSite(artifact, {
        ...options.exportOverrides,
        run,
        nodeCommand: toolchain.nodeCommand,
        nextBin: root => toolchain.nextBin(root),
        nodeEnv: toolchain.nodeEnv,
        ensureDependencies: root => toolchain.ensureDependencies(root),
        });
      },
    },
    dispose: () => devServers.stopAll(),
  };
}
