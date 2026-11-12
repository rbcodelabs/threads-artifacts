import type { AgentHarness, AgentThreadsApiV1, ThreadArtifactRef } from './contracts';
import {
  applyModeViewport,
  artifactIdForThread,
  designKickoffMessage,
  designRuntimeOf,
  designTitle,
  NEXTJS_UNSUPPORTED_MODES,
  scaffoldDesignArtifact,
  scaffoldReportSupport,
  type DesignArtifact,
  type DesignArtifactFs,
  type DesignRuntime,
} from './designArtifact';
import {
  DESIGN_ACTION_PREVIEW,
  DESIGN_ARTIFACT_KINDS,
  DESIGN_ARTIFACT_SCHEMA_VERSION,
  DESIGN_PROVIDER_ID,
  DESIGN_PROVIDER_OWNER,
} from './designArtifactProvider';
import type { DesignGuidance, DesignGuidanceReader } from './designGuidance';
import type { DesignMode } from './designModes';
import { designFolderName } from './designStorage';
import { normalizeHostTheme, type HostThemeSnapshot } from './hostTheme';

/** Installs/links the shared Next.js dependencies into a freshly scaffolded artifact. */
export interface NextjsDependencies { ensureDependencies(root: string): Promise<void> }

const isDesignRef = (ref: ThreadArtifactRef): boolean => (DESIGN_ARTIFACT_KINDS as readonly string[]).includes(ref.kind);

export interface PrepareDesignOptions {
  mode?: DesignMode;
  checkPermissions?: boolean;
  /** Runtime for a new artifact; for an existing one it must match or be omitted. */
  runtime?: DesignRuntime;
}

export interface PreparedDesign {
  artifact: DesignArtifact;
  created: boolean;
  instructions: string;
}

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

export class DesignService {
  private readonly pending = new Set<ReturnType<AgentThreadsApiV1['threads']['beginProvisional']> extends Promise<infer T> ? T : never>();

  constructor(
    private readonly api: AgentThreadsApiV1,
    private readonly fileFs: DesignArtifactFs,
    private readonly report: (message: string, isError?: boolean) => void = () => {},
    private readonly provideTheme: () => HostThemeSnapshot = () => normalizeHostTheme('dark', {}),
    private readonly readGuidance?: DesignGuidanceReader,
    /** Absent when the Next.js runtime is unavailable (for example no resolvable cache directory). */
    private readonly nextjs?: NextjsDependencies,
  ) {}

  /** Best-effort DESIGN.md lookup; never throws. */
  private async guidanceFor(threadId: string): Promise<DesignGuidance | undefined> {
    if (!this.readGuidance) return undefined;
    try {
      const cwd = (await this.api.threads.get(threadId))?.cwd;
      if (!cwd) return undefined;
      const guidance = await this.readGuidance(cwd);
      if (!guidance) return undefined;
      this.report(`Using DESIGN.md from ${guidance.path}`);
      return guidance;
    } catch {
      return undefined;
    }
  }

  async state(threadId: string): Promise<{ hasArtifacts: boolean; existingTitle?: string } | null> {
    const thread = await this.api.threads.get(threadId);
    if (!thread) return null;
    const ref = (await this.api.artifacts.list(threadId)).find(isDesignRef);
    return { hasArtifacts: !!ref, existingTitle: ref?.title };
  }

  async prepare(threadId: string, brief: string, { mode, checkPermissions = true, runtime }: PrepareDesignOptions = {}): Promise<PreparedDesign> {
    if (checkPermissions) {
      const permissions = await this.api.threads.permissions(threadId);
      if (!permissions) throw new Error('Calling thread is unavailable.');
      if (permissions.planApprovalPending) throw new Error('Design mode is unavailable while plan approval is pending.');
      if (permissions.effectivePermissionMode === 'plan') {
        throw new Error('Design mode writes artifact files and is unavailable in read-only Plan mode.');
      }
    }

    const existing = (await this.api.artifacts.list(threadId)).find(isDesignRef);
    const existingRuntime = existing ? designRuntimeOf(existing.data as DesignArtifact) : undefined;
    if (existing && runtime && existingRuntime !== runtime) {
      // One design artifact per thread; silently switching runtime would orphan the user's work.
      throw new Error(`This thread already has a ${existingRuntime} design artifact; its runtime cannot be changed to ${runtime}. Start a new thread for a ${runtime} design.`);
    }
    const effectiveRuntime = existingRuntime ?? runtime ?? 'static';
    if (mode && effectiveRuntime === 'nextjs' && NEXTJS_UNSUPPORTED_MODES.includes(mode)) {
      throw new Error(`The ${mode} mode is only available for static designs, not Next.js prototypes.`);
    }
    if (!existing && effectiveRuntime === 'nextjs' && !this.nextjs) {
      throw new Error('Next.js design prototypes are unavailable: no dependency cache is configured for this vault.');
    }
    let artifact: DesignArtifact;
    let created = false;
    let allocatedRoot: string | undefined;
    try {
      if (existing) {
        artifact = existing.data as DesignArtifact;
        artifact = { ...artifact, updatedAt: Date.now() };
        const updated = await this.api.artifacts.update(DESIGN_PROVIDER_OWNER, threadId, existing.id, { data: artifact });
        if (!updated.success) throw new Error(updated.message ?? 'Could not update design artifact.');
      } else {
        const artifactId = artifactIdForThread(threadId);
        // Folder name is only a readable label; identity is the artifact id / createdByThreadId.
        // Hosts without visible storage ignore the options and return the hidden path, which we use as-is.
        const allocation = await this.api.artifacts.allocateStorage(threadId, artifactId, {
          location: 'visible',
          folderName: designFolderName(designTitle(brief), artifactId),
          owner: { pluginId: DESIGN_PROVIDER_OWNER.pluginId },
        });
        if (!allocation.success) throw new Error(allocation.message);
        allocatedRoot = allocation.path;
        artifact = await scaffoldDesignArtifact(threadId, allocation.path, brief, Date.now(), this.fileFs, this.provideTheme(), effectiveRuntime, mode);
        if (effectiveRuntime === 'nextjs') await this.nextjs!.ensureDependencies(allocation.path);
        const ref: ThreadArtifactRef = {
          providerId: DESIGN_PROVIDER_ID,
          kind: artifact.kind,
          schemaVersion: DESIGN_ARTIFACT_SCHEMA_VERSION,
          id: artifact.id,
          title: artifact.title,
          data: artifact,
          storageRoot: artifact.storageRoot,
        };
        const attached = await this.api.artifacts.attach(DESIGN_PROVIDER_OWNER, threadId, ref);
        if (!attached.success) throw new Error(attached.message ?? 'Could not attach design artifact.');
        created = true;
      }

      if (mode === 'report' && !created && effectiveRuntime === 'static') await scaffoldReportSupport(this.fileFs, artifact.root);
      if (mode && effectiveRuntime === 'static') await applyModeViewport(artifact.root, mode, this.fileFs);
      await this.api.threads.open(threadId);
      const preview = await this.api.artifacts.invokeAction(threadId, artifact.id, DESIGN_ACTION_PREVIEW);
      if (preview.status === 'error') throw new Error(preview.message);
      if (preview.status === 'warning') this.report(preview.message);
      const guidance = await this.guidanceFor(threadId);
      return { artifact, created, instructions: designKickoffMessage(artifact, brief, mode, guidance) };
    } catch (error) {
      if (allocatedRoot) {
        try { await this.fileFs.rm?.(allocatedRoot, { recursive: true, force: true }); } catch { /* host rollback remains authoritative */ }
      }
      throw error;
    }
  }

  async dispatch(brief: string, harness?: AgentHarness, mode?: DesignMode, runtime?: DesignRuntime): Promise<string> {
    const handle = await this.api.threads.beginProvisional(DESIGN_PROVIDER_OWNER, {
      title: designTitle(brief),
      agentHarness: harness,
      ownerPluginId: DESIGN_PROVIDER_OWNER.pluginId,
    });
    this.pending.add(handle);
    try {
      const prepared = await this.prepare(handle.threadId, brief, { mode, checkPermissions: false, runtime });
      await handle.commit();
      this.pending.delete(handle);
      try {
        await this.api.threads.send(handle.threadId, {
          prompt: prepared.instructions,
          ownerPluginId: DESIGN_PROVIDER_OWNER.pluginId,
          idempotencyKey: crypto.randomUUID(),
        });
      } catch (error) {
        this.report(`Failed to start design turn: ${message(error)}`, true);
      }
      return handle.threadId;
    } catch (error) {
      await handle.rollback();
      this.pending.delete(handle);
      throw error;
    }
  }

  async dispose(): Promise<void> {
    const pending = [...this.pending];
    this.pending.clear();
    await Promise.allSettled(pending.map(handle => handle.rollback()));
  }
}
