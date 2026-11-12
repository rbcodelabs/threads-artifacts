import { Notice, Plugin } from 'obsidian';
import type { AgentThreadsApiV1, AgentThreadsPlugin } from './contracts';
import { DesignService } from './DesignService';
import { createDesignAgentTool } from './designAgentTool';
import { createDesignArtifactContribution, DESIGN_PROVIDER_OWNER } from './designArtifactProvider';
import { createDesignSlashCommand } from './designSlashCommand';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { migrateHiddenDesigns } from './designMigration';
import { captureHostTheme } from './hostTheme';
import { loadDesignGuidance } from './designGuidance';
import { createNextjsRuntime, type NextjsRuntime } from './nextjsRuntime';
import { registerElementFeedback } from './elementFeedbackRegistration';
import { createPluginDataGuard, type PluginDataGuard } from './commentKey';

const REQUIRED_CAPABILITIES = [
  'threads.beginProvisional', 'threads.send', 'threads.open', 'threads.permissions',
  'artifacts.list', 'artifacts.allocateStorage', 'artifacts.attach', 'artifacts.update', 'artifacts.invokeAction',
  'extensions.registerArtifactProvider', 'extensions.registerAgentTool', 'extensions.registerSlashCommand',
] as const;

type Disposable = { dispose(): void };

export default class ThreadsDesignPlugin extends Plugin {
  private registrations: Disposable[] = [];
  private startupNoticeTimer: ReturnType<typeof setTimeout> | null = null;
  private service: DesignService | null = null;
  private nextjs: NextjsRuntime | null = null;
  /** The only door to plugin data (loadData/saveData): it owns the comment-signing key, so nothing else may call them. */
  private readonly pluginData: PluginDataGuard = createPluginDataGuard({ loadData: this.loadData.bind(this), saveData: this.saveData.bind(this) });

  async onload(): Promise<void> {
    const workspace = this.app.workspace as unknown as {
      on(name: string, callback: () => void): unknown;
    };
    this.registerEvent(workspace.on('claude-threads:api-ready', () => { void this.connect(); }) as never);
    this.registerEvent(workspace.on('claude-threads:api-stopping', () => { void this.disconnect(); }) as never);
    await this.connect(true);
    if (!this.service) {
      // Agent Threads may simply load after us; `api-ready` will retry. Only warn if it never shows up.
      this.startupNoticeTimer = setTimeout(() => {
        if (!this.service) this.notifyUnavailable();
      }, 15000);
    }
  }

  async onunload(): Promise<void> {
    if (this.startupNoticeTimer) clearTimeout(this.startupNoticeTimer);
    await this.disconnect();
  }

  private getApi(): AgentThreadsApiV1 | undefined {
    const plugins = (this.app as unknown as { plugins?: { plugins?: Record<string, unknown> } }).plugins?.plugins;
    return (plugins?.['claude-threads'] as AgentThreadsPlugin | undefined)?.api?.v1;
  }

  private notifyUnavailable(): void {
    new Notice('Design for Agent Threads requires Agent Threads with public API v1.');
  }

  private async connect(quietIfMissing = false): Promise<void> {
    await this.disconnect();
    const api = this.getApi();
    if (!api || api.apiVersion !== 1) {
      if (!quietIfMissing) this.notifyUnavailable();
      return;
    }
    const missing = REQUIRED_CAPABILITIES.filter(capability => !api.capabilities.includes(capability));
    if (missing.length > 0) {
      new Notice(`Design for Agent Threads needs a newer Agent Threads version (${missing.join(', ')}).`);
      return;
    }

    // Next.js prototypes need a real vault directory for the shared dependency cache.
    const basePath = (this.app.vault.adapter as { getBasePath?: () => string }).getBasePath?.();
    const nextjs = basePath ? createNextjsRuntime({ cacheDir: path.join(basePath, '.geode', 'cache', 'design-nextjs') }) : null;

    const service = new DesignService(api, {
      mkdir: (target, options) => fs.mkdir(target, options),
      writeFile: (target, data, options) => fs.writeFile(target, data, options),
      readFile: target => fs.readFile(target, 'utf8'),
      rm: (target, options) => fs.rm(target, options),
    }, (message, isError) => new Notice(isError ? message : `Design: ${message}`), () => captureHostTheme(), cwd => loadDesignGuidance(cwd, {
      readFile: target => fs.readFile(target, 'utf8'),
      exists: target => fs.access(target).then(() => true, () => false),
    }), nextjs?.toolchain);
    const registrations = [
      api.extensions.registerArtifactProvider(DESIGN_PROVIDER_OWNER, createDesignArtifactContribution(nextjs?.provider)),
      api.extensions.registerAgentTool(DESIGN_PROVIDER_OWNER, createDesignAgentTool(service)),
      api.extensions.registerSlashCommand(DESIGN_PROVIDER_OWNER, createDesignSlashCommand({
        getState: threadId => service.state(threadId),
        isDesktopFilesystem: () => true,
        prepare: (threadId, brief, mode, runtime) => service.prepare(threadId, brief, { mode, runtime }),
        send: async (threadId, prompt) => { await api.threads.send(threadId, { prompt, ownerPluginId: DESIGN_PROVIDER_OWNER.pluginId, idempotencyKey: crypto.randomUUID() }); },
        dispatch: (brief, harness, mode, runtime) => service.dispatch(brief, harness, mode, runtime),
      })),
    ];
    const refused = registrations.find(registration => !registration.success);
    if (refused) {
      registrations.forEach(registration => registration.dispose());
      nextjs?.dispose();
      await service.dispose();
      new Notice(refused.message ?? 'Agent Threads refused the Design contribution.');
      return;
    }
    this.service = service;
    this.nextjs = nextjs;
    this.registrations = registrations;
    this.registerElementComments(api, basePath);
    void this.migrateLegacyDesigns(api);
  }

  /**
   * Geode-only element comments. Optional: on Geode builds without the artifact feedback registry (or on
   * any failure here) this registers nothing and stays silent, and the rest of Design is unaffected.
   */
  private registerElementComments(api: AgentThreadsApiV1, basePath: string | undefined): void {
    try {
      const feedback = registerElementFeedback({
        plugin: this,
        app: this.app,
        api,
        basePath,
        installKeys: this.pluginData,
        pluginVersion: this.manifest.version,
        notify: (message, isError) => new Notice(message, isError ? 8000 : undefined),
        readEscalationKeyword: () => {
          const host = (this.app as unknown as { plugins?: { plugins?: Record<string, { settings?: { escalationKeyword?: unknown } } | undefined> } }).plugins?.plugins?.['claude-threads'];
          const keyword = host?.settings?.escalationKeyword;
          return typeof keyword === 'string' ? keyword : undefined;
        },
      });
      if (feedback) this.registrations.push(feedback);
    } catch (error) {
      console.warn('threads-design: element comments are unavailable', error);
    }
  }

  /** Moves pre-existing hidden designs into host-allocated visible storage; failures never affect the plugin. */
  private async migrateLegacyDesigns(api: AgentThreadsApiV1): Promise<void> {
    try {
      const basePath = (this.app.vault.adapter as { getBasePath?: () => string }).getBasePath?.();
      if (!basePath) return;
      await migrateHiddenDesigns({
        api,
        owner: DESIGN_PROVIDER_OWNER,
        hiddenRoot: path.join(basePath, '.geode', 'artifacts'),
        fs: {
          readdir: target => fs.readdir(target),
          readFile: target => fs.readFile(target, 'utf8'),
          rename: (from, to) => fs.rename(from, to),
          rmdir: target => fs.rmdir(target),
        },
      });
    } catch {
      // Migration is best-effort; the original directories remain valid.
    }
  }

  private async disconnect(): Promise<void> {
    const registrations = this.registrations.splice(0);
    registrations.reverse().forEach(registration => registration.dispose());
    const service = this.service;
    this.service = null;
    this.nextjs?.dispose();
    this.nextjs = null;
    if (service) await service.dispose();
  }
}
