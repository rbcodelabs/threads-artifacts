import { Notice, Plugin } from 'obsidian';
import type { AgentThreadsApiV1, AgentThreadsPlugin } from './contracts';
import { DesignService } from './DesignService';
import { createDesignAgentTool } from './designAgentTool';
import { createDesignArtifactContribution, DESIGN_PROVIDER_OWNER } from './designArtifactProvider';
import { createDesignSlashCommand } from './designSlashCommand';
import * as fs from 'node:fs/promises';

const REQUIRED_CAPABILITIES = [
  'threads.beginProvisional', 'threads.send', 'threads.open', 'threads.permissions',
  'artifacts.list', 'artifacts.allocateStorage', 'artifacts.attach', 'artifacts.update', 'artifacts.invokeAction',
  'extensions.registerArtifactProvider', 'extensions.registerAgentTool', 'extensions.registerSlashCommand',
] as const;

type Disposable = { dispose(): void };

export default class ThreadsArtifactsPlugin extends Plugin {
  private registrations: Disposable[] = [];
  private service: DesignService | null = null;

  async onload(): Promise<void> {
    const workspace = this.app.workspace as unknown as {
      on(name: string, callback: () => void): unknown;
    };
    this.registerEvent(workspace.on('claude-threads:api-ready', () => { void this.connect(); }) as never);
    this.registerEvent(workspace.on('claude-threads:api-stopping', () => { void this.disconnect(); }) as never);
    await this.connect();
  }

  async onunload(): Promise<void> {
    await this.disconnect();
  }

  private getApi(): AgentThreadsApiV1 | undefined {
    const plugins = (this.app as unknown as { plugins?: { plugins?: Record<string, unknown> } }).plugins?.plugins;
    return (plugins?.['claude-threads'] as AgentThreadsPlugin | undefined)?.api?.v1;
  }

  private async connect(): Promise<void> {
    await this.disconnect();
    const api = this.getApi();
    if (!api || api.apiVersion !== 1) {
      new Notice('Artifacts for Agent Threads requires Agent Threads with public API v1.');
      return;
    }
    const missing = REQUIRED_CAPABILITIES.filter(capability => !api.capabilities.includes(capability));
    if (missing.length > 0) {
      new Notice(`Artifacts for Agent Threads needs a newer Agent Threads version (${missing.join(', ')}).`);
      return;
    }

    const service = new DesignService(api, {
      mkdir: (target, options) => fs.mkdir(target, options),
      writeFile: (target, data, options) => fs.writeFile(target, data, options),
      rm: (target, options) => fs.rm(target, options),
    }, (message, isError) => new Notice(isError ? message : `Design: ${message}`));
    const registrations = [
      api.extensions.registerArtifactProvider(DESIGN_PROVIDER_OWNER, createDesignArtifactContribution()),
      api.extensions.registerAgentTool(DESIGN_PROVIDER_OWNER, createDesignAgentTool(service)),
      api.extensions.registerSlashCommand(DESIGN_PROVIDER_OWNER, createDesignSlashCommand({
        getState: threadId => service.state(threadId),
        isDesktopFilesystem: () => true,
        prepare: (threadId, brief) => service.prepare(threadId, brief),
        send: async (threadId, prompt) => { await api.threads.send(threadId, { prompt, ownerPluginId: DESIGN_PROVIDER_OWNER.pluginId }); },
        dispatch: (brief, harness) => service.dispatch(brief, harness),
      })),
    ];
    const refused = registrations.find(registration => !registration.success);
    if (refused) {
      registrations.forEach(registration => registration.dispose());
      await service.dispose();
      new Notice(refused.message ?? 'Agent Threads refused the Design contribution.');
      return;
    }
    this.service = service;
    this.registrations = registrations;
  }

  private async disconnect(): Promise<void> {
    const registrations = this.registrations.splice(0);
    registrations.reverse().forEach(registration => registration.dispose());
    const service = this.service;
    this.service = null;
    if (service) await service.dispose();
  }
}
