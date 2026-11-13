/**
 * Built-in Design artifact provider.
 *
 * This is the reference consumer for ADR-0008's contribution API: it registers
 * through `api.v1.extensions.registerArtifactProvider` with a real peer
 * identity, and reaches the host only through `ArtifactActionHost`. The one
 * thing it touches directly is `window.geode`, which is an ambient host-app
 * global available to any plugin — not a privileged Agent Threads path.
 */

import type {
  ArtifactActionHost,
  ArtifactActionResult,
  ArtifactContribution,
  ArtifactPresentation,
  ThreadArtifactRef,
} from './contracts';
import type { DesignArtifact } from './designArtifact';
import type { RunningDevServer } from './devServerManager';
import type { StaticExportOutcome } from './designExport';

export const DESIGN_PROVIDER_ID = 'agent-threads.design';
/** Static HTML/CSS/JS artifacts (runtime 'static'). */
export const DESIGN_ARTIFACT_KIND = 'design-static';
/** Next.js app prototypes (runtime 'nextjs'). */
export const DESIGN_APP_ARTIFACT_KIND = 'design-app';
export const DESIGN_ARTIFACT_KINDS = [DESIGN_ARTIFACT_KIND, DESIGN_APP_ARTIFACT_KIND] as const;
/**
 * Lives here rather than in `designArtifact.ts` so the design entry points can
 * declare it without statically importing the filesystem-backed module, which
 * the mobile bundle must not pull in.
 *
 * Version 2 added `runtime: 'nextjs'` and `permissions.network: 'loopback'`.
 * Version 1 (static only) artifacts remain readable and fully supported.
 */
export const DESIGN_ARTIFACT_SCHEMA_VERSION = 2 as const;
export const DESIGN_LEGACY_SCHEMA_VERSION = 1 as const;

/** The plugin's own identity when it registers built-in capabilities. */
export const DESIGN_PROVIDER_OWNER = Object.freeze({
  pluginId: 'threads-artifacts',
  displayName: 'Artifacts for Agent Threads',
});

/**
 * Visible-storage namespace: Agent Threads derives `<vault>/Artifacts/<namespace>/` from the
 * `owner.pluginId` passed to `allocateStorage`. It is deliberately the plugin's ORIGINAL id,
 * not `DESIGN_PROVIDER_OWNER.pluginId`, so designs keep living under `Artifacts/threads-design/`
 * after the plugin id changed to `threads-artifacts`. Do not change this without a migration.
 */
export const DESIGN_STORAGE_NAMESPACE = 'threads-design';

export const DESIGN_ACTION_PREVIEW = 'preview';
export const DESIGN_ACTION_CAPTURE = 'capture';
export const DESIGN_ACTION_REVEAL = 'reveal';
export const DESIGN_ACTION_EXPORT = 'export';

/** What the provider needs to serve `design-app` (Next.js) artifacts; absent when the runtime is unavailable. */
export interface NextjsRuntimeDeps {
  devServers: { ensure(artifactId: string, root: string): Promise<RunningDevServer> };
  exportStatic(artifact: Pick<DesignArtifact, 'id' | 'root'>): Promise<StaticExportOutcome>;
}

const NEXTJS_UNAVAILABLE = 'The Next.js design runtime is not available in this environment.';

/** Mirrors the legacy `DesignPreviewResult` the design-mode entry reports. */
export type DesignPreviewOutcome =
  | { status: 'opened' }
  | { status: 'source-revealed' | 'unavailable'; warning: string };

/**
 * `ArtifactActionResult` carries ok/warning/error and a message — deliberately,
 * since the host must not learn provider-specific outcome vocabularies. The
 * design entry still reports the finer `source-revealed` state to its agent
 * caller, so the provider exports its own warning text and recovers the
 * distinction from it. This is provider-internal knowledge, not a host
 * privilege: a peer can do exactly the same with its own constants.
 */
export const DESIGN_SOURCE_REVEALED_WARNING = 'Secure artifact preview requires Geode; revealed the source instead.';

interface GeodeCaptureHost {
  /** `options.url` is passed for Next.js artifacts, which are captured from their dev server instead of the artifact folder. */
  captureArtifact?: (root: string, options?: { url: string }) => Promise<{ path: string; width: number; height: number }>;
}

function geodeHost(): GeodeCaptureHost | undefined {
  return (globalThis as unknown as { geode?: GeodeCaptureHost }).geode;
}

/** Narrows the opaque ref payload back to this provider's own schema. */
function designData(ref: ThreadArtifactRef): DesignArtifact {
  return ref.data as DesignArtifact;
}

export function presentDesignArtifact(ref: ThreadArtifactRef): ArtifactPresentation {
  const isApp = ref.kind === DESIGN_APP_ARTIFACT_KIND;
  return {
    title: ref.title,
    subtitle: isApp ? 'Next.js design prototype' : 'Static design artifact',
    icon: 'panels-top-left',
    actions: [
      { id: DESIGN_ACTION_PREVIEW, label: 'Preview design', variant: 'primary', icon: 'eye', shortLabel: 'Preview' },
      { id: DESIGN_ACTION_CAPTURE, label: 'Capture design screenshot', variant: 'secondary', icon: 'camera' },
      ...(isApp ? [{ id: DESIGN_ACTION_EXPORT, label: 'Export static HTML', tooltip: 'Build a static export and zip it', variant: 'secondary' as const, icon: 'package', shortLabel: 'Export' }] : []),
      { id: DESIGN_ACTION_REVEAL, label: 'Reveal design source', variant: 'secondary', icon: 'folder-open' },
    ],
  };
}

/**
 * Opens the secure artifact view, falling back to revealing the source when
 * the host cannot place it. Exported because design-mode entry (`/design`,
 * `EnterDesignMode`) needs the same outcome shape immediately after creating
 * an artifact, before any card action has been clicked.
 */
export async function previewDesignArtifact(
  artifact: Pick<DesignArtifact, 'root' | 'manifestPath'>,
  host: ArtifactActionHost,
  /** Dev-server URL for Next.js artifacts; static artifacts load from `root`. */
  url?: string,
): Promise<DesignPreviewOutcome> {
  // Obsidian's missing-plugin placeholder preserves the requested view type,
  // so successful placement alone cannot establish that a preview loaded.
  if (typeof geodeHost()?.captureArtifact === 'function') {
    const placement = await host.openView({
      type: 'geode-artifact',
      state: url ? { root: artifact.root, url, runtime: 'nextjs' } : { root: artifact.root },
    });
    if (placement !== 'unavailable') return { status: 'opened' };
  }
  const revealed = await host.revealInFolder(artifact.manifestPath);
  if (revealed) {
    return { status: 'source-revealed', warning: DESIGN_SOURCE_REVEALED_WARNING };
  }
  return { status: 'unavailable', warning: 'Could not open artifact preview or reveal source.' };
}

const describe = (error: unknown): string => error instanceof Error ? error.message : String(error);

async function captureDesignArtifact(ref: ThreadArtifactRef, host: ArtifactActionHost, nextjs: NextjsRuntimeDeps | undefined): Promise<ArtifactActionResult> {
  const artifact = designData(ref);
  const capture = geodeHost()?.captureArtifact;
  if (!capture) {
    return { status: 'warning', message: 'Artifact capture requires Geode with ArtifactView support.' };
  }
  let captured: { path: string; width: number; height: number };
  try {
    if (ref.kind === DESIGN_APP_ARTIFACT_KIND) {
      if (!nextjs) return { status: 'warning', message: NEXTJS_UNAVAILABLE };
      const server = await nextjs.devServers.ensure(artifact.id, artifact.root);
      captured = await capture(artifact.root, { url: server.url });
    } else {
      captured = await capture(artifact.root);
    }
  } catch (error) {
    return { status: 'error', message: `Artifact capture failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  await host.updateArtifact({
    data: { ...artifact, lastCapturePath: captured.path, updatedAt: Date.now() },
  });
  return { status: 'ok', message: `Captured ${captured.width}×${captured.height} artifact screenshot.` };
}

/** Starts (or reuses) the dev server and opens it; server failures are warnings so artifact creation is never rolled back for them. */
async function previewNextjsArtifact(ref: ThreadArtifactRef, host: ArtifactActionHost, nextjs: NextjsRuntimeDeps | undefined): Promise<ArtifactActionResult> {
  if (!nextjs) return { status: 'warning', message: NEXTJS_UNAVAILABLE };
  const artifact = designData(ref);
  let server: RunningDevServer;
  try {
    server = await nextjs.devServers.ensure(artifact.id, artifact.root);
  } catch (error) {
    return { status: 'warning', message: `Could not start the Next.js preview: ${describe(error)}` };
  }
  const preview = await previewDesignArtifact(artifact, host, server.url);
  return preview.status === 'opened' ? { status: 'ok' } : { status: 'warning', message: preview.warning };
}

async function exportNextjsArtifact(ref: ThreadArtifactRef, host: ArtifactActionHost, nextjs: NextjsRuntimeDeps | undefined, exporting: Set<string>): Promise<ArtifactActionResult> {
  if (ref.kind !== DESIGN_APP_ARTIFACT_KIND) return { status: 'error', message: 'Static HTML export is only available for Next.js design artifacts.' };
  if (!nextjs) return { status: 'warning', message: NEXTJS_UNAVAILABLE };
  const artifact = designData(ref);
  if (exporting.has(artifact.id)) return { status: 'warning', message: 'An export is already running for this design.' };
  exporting.add(artifact.id);
  try {
    const outcome = await nextjs.exportStatic(artifact);
    if (!outcome.ok) return { status: 'error', message: outcome.message };
    await host.updateArtifact({ data: { ...artifact, lastExportPath: outcome.folder, updatedAt: Date.now() } });
    const revealed = await host.revealInFolder(outcome.folder);
    const warnings = [...outcome.warnings, ...(revealed ? [] : ['Could not reveal the export folder.'])];
    const summary = `Exported static HTML to ${outcome.folder}${outcome.zip ? ` and ${outcome.zip}` : ''}.`;
    return warnings.length ? { status: 'warning', message: `${summary} ${warnings.join(' ')}` } : { status: 'ok', message: summary };
  } catch (error) {
    return { status: 'error', message: `Static export failed: ${describe(error)}` };
  } finally {
    exporting.delete(artifact.id);
  }
}

export function createDesignArtifactContribution(nextjs?: NextjsRuntimeDeps): ArtifactContribution {
  const exporting = new Set<string>();
  return {
    providerId: DESIGN_PROVIDER_ID,
    kinds: [...DESIGN_ARTIFACT_KINDS],
    present: presentDesignArtifact,
    invoke: async (actionId, ref, host) => {
      if (actionId === DESIGN_ACTION_PREVIEW) {
        if (ref.kind === DESIGN_APP_ARTIFACT_KIND) return previewNextjsArtifact(ref, host, nextjs);
        const preview = await previewDesignArtifact(designData(ref), host);
        return preview.status === 'opened' ? { status: 'ok' } : { status: 'warning', message: preview.warning };
      }
      if (actionId === DESIGN_ACTION_CAPTURE) return captureDesignArtifact(ref, host, nextjs);
      if (actionId === DESIGN_ACTION_EXPORT) return exportNextjsArtifact(ref, host, nextjs, exporting);
      if (actionId === DESIGN_ACTION_REVEAL) {
        const revealed = await host.revealInFolder(designData(ref).manifestPath);
        return revealed ? { status: 'ok' } : { status: 'error', message: 'Could not reveal the design source.' };
      }
      return { status: 'error', message: `Unknown design artifact action: ${actionId}` };
    },
  };
}
