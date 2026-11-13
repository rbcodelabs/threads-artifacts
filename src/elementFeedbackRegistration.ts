import { randomBytes } from 'node:crypto';
import type { AgentThreadsApiV1 } from './contracts';
import { createArtifactCommentsProvider, protectedIdsWithoutStore } from './artifactCommentsProvider';
import { createArtifactFeedbackHandler } from './artifactFeedbackHandler';
import type { InstallKeyProvider } from './commentKey';
import { createCommentStore } from './commentStore';
import { DESIGN_PROVIDER_OWNER } from './designArtifactProvider';
import {
  ARTIFACT_FEEDBACK_CONTRACT_VERSIONS,
  type ArtifactFeedbackHandler,
  type ArtifactFeedbackRegistration,
} from './geodeArtifactFeedback';
import type { ArtifactFeedbackHandlerV2 } from './geodeArtifactFeedbackV2';
import { createSendCoordinator, type CoordinatorClock } from './sendCoordinator';

type Disposable = { dispose(): void };
type Logger = { info(message: string): void; warn(message: string, error?: unknown): void };

interface GeodePluginSurface { registerArtifactFeedbackHandler?: (handler: ArtifactFeedbackHandler | ArtifactFeedbackHandlerV2) => ArtifactFeedbackRegistration }
interface GeodeAppSurface { artifactFeedback?: { contractVersions?: readonly number[] } }

/**
 * Geode-only capability detection (contract section 2): both the Plugin method and a registry that
 * lists our contract version must be present. Anything else means "Geode too old" and is silent.
 */
export function supportsArtifactFeedback(plugin: unknown, app: unknown): boolean {
  const method = (plugin as GeodePluginSurface | null)?.registerArtifactFeedbackHandler;
  const versions = (app as GeodeAppSurface | null)?.artifactFeedback?.contractVersions;
  return typeof method === 'function' && Array.isArray(versions) && ARTIFACT_FEEDBACK_CONTRACT_VERSIONS.every(version => versions.includes(version));
}

/**
 * Which contract version to register (design 1.1): 2 iff the registry lists 2 and the method exists, else 1 when
 * the registry lists 1, else null (silent no-op). The plugin decides; Geode never has to.
 */
export function negotiateContractVersion(plugin: unknown, app: unknown): 2 | 1 | null {
  const method = (plugin as GeodePluginSurface | null)?.registerArtifactFeedbackHandler;
  const versions = (app as GeodeAppSurface | null)?.artifactFeedback?.contractVersions;
  if (typeof method !== 'function' || !Array.isArray(versions)) return null;
  if (versions.includes(2)) return 2;
  return supportsArtifactFeedback(plugin, app) ? 1 : null;
}

export interface ElementFeedbackOptions {
  readonly plugin: unknown;
  readonly app: unknown;
  readonly api: AgentThreadsApiV1;
  /** Vault base path; without it (mobile) there is no host artifact storage to map, so nothing registers. */
  readonly basePath: string | undefined;
  readonly notify: (message: string, isError?: boolean) => void;
  readonly log?: Logger;
  /** Best-effort read of the host's configured escalation keyword. */
  readonly readEscalationKeyword?: () => string | undefined;
  readonly clock?: CoordinatorClock;
  readonly secret?: string;
  /**
   * The install key provider (the guarded plugin data, `createPluginDataGuard(...)`). Without it pins cannot be
   * signed, so the plugin registers the v1 shape even when Geode lists contract version 2.
   */
  readonly installKeys?: InstallKeyProvider;
  /** Recorded in comments.json as `writtenBy`. */
  readonly pluginVersion?: string;
  /** Wall clock in ms (tests). Used to bound how old or new a pinned selection may claim to be. */
  readonly now?: () => number;
}

/**
 * Registers the element-comment handler with Geode and returns one disposable that tears down the
 * registration, pending sends, timers and the thread subscription. Returns null (silently) when
 * Geode lacks the feature; never throws, so /design keeps working whatever happens here.
 */
export function registerElementFeedback(options: ElementFeedbackOptions): Disposable | null {
  const log = options.log ?? console;
  const negotiated = negotiateContractVersion(options.plugin, options.app);
  if (negotiated === null) {
    log.info('threads-design: Geode has no artifact feedback support');
    return null;
  }
  if (!options.basePath) return null;

  // Set once Geode accepted the v2 handler; a queued batch can only finish after that.
  let comments: ReturnType<typeof createArtifactCommentsProvider> | null = null;
  const coordinator = createSendCoordinator({
    api: options.api,
    ownerPluginId: DESIGN_PROVIDER_OWNER.pluginId,
    clock: options.clock,
    onDeferredResult: result => {
      const { outcome } = result;
      if (outcome.status === 'sent') options.notify('Design: your queued comment was sent to the thread.');
      else if (outcome.status === 'rejected') options.notify(`Design: your queued comment could not be sent. ${outcome.message}`, true);
      // A queued pinned batch also needs its comments marked sent, or back to open.
      void comments?.handleDeferredResult(result).catch(error => log.warn('threads-design: could not record a queued send result', error));
    },
  });
  const plugin = options.plugin as GeodePluginSurface;
  const vaultRoot = () => options.basePath;
  const baseDeps = {
    api: options.api,
    coordinator,
    vaultRoot,
    boundarySecret: options.secret ?? randomBytes(32).toString('hex'),
    escalation: () => {
      try {
        const keyword = options.readEscalationKeyword?.();
        if (typeof keyword === 'string' && keyword.trim()) return { keywords: [keyword], known: true };
      } catch {
        // fall through: unknown keyword means conservative defusing
      }
      return { keywords: [], known: false };
    },
    warn: (message: string, error?: unknown) => log.warn(message, error),
  };

  // A host's refusal dispose is documented as an idempotent no-op, but a misbehaving host must not cost us the coordinator or the v1 fallback.
  const safely = (fn: () => void): void => {
    try {
      fn();
    } catch (error) {
      log.warn('threads-design: disposing a refused registration failed', error);
    }
  };

  const register = (handler: ArtifactFeedbackHandler | ArtifactFeedbackHandlerV2): ArtifactFeedbackRegistration | null => {
    try {
      return plugin.registerArtifactFeedbackHandler!(handler);
    } catch (error) {
      log.warn('threads-design: could not register the artifact feedback handler', error);
      return null;
    }
  };

  let registration: ArtifactFeedbackRegistration | null = null;
  let raced = false;

  if (negotiated === 2 && options.installKeys) {
    // The store is lazy and the provider stays inert until Geode accepts this handler (T12): nothing here reads
    // plugin data or writes comments.json before a v2 registration succeeded.
    const store = createCommentStore({ keys: options.installKeys, pluginVersion: options.pluginVersion ? `threads-design@${options.pluginVersion}` : undefined });
    const candidate = createArtifactCommentsProvider({ api: options.api, vaultRoot, store, now: options.now, warn: baseDeps.warn, coordinator, boundarySecret: baseDeps.boundarySecret, escalation: baseDeps.escalation });
    const v1 = createArtifactFeedbackHandler({ ...baseDeps, protectedSelectionIds: (root, artifactId) => candidate.protectedSelectionIds(root, artifactId) });
    const v2: ArtifactFeedbackHandlerV2 = { contractVersion: 2, canHandle: v1.canHandle, submit: v1.submit, comments: candidate.provider };
    const attempt = register(v2);
    if (attempt === null) {
      candidate.dispose();
      coordinator.dispose();
      return null;
    }
    if (attempt.status === 'registered') {
      registration = attempt;
      comments = candidate;
      candidate.activate();
    } else {
      safely(() => attempt.dispose());
      candidate.dispose();
      log.warn(`threads-design: contract v2 handler not registered (${attempt.status}): ${attempt.message}`);
      if (attempt.status !== 'unsupported-version') {
        coordinator.dispose();
        return null;
      }
      // A host that listed 2 but refused it (a race, or a host that lies): fall back to the v1 shape, once.
      raced = true;
    }
  }

  if (registration === null) {
    // v1 is only offered when the registry lists it, or when it just refused our v2 handler.
    if (!raced && !supportsArtifactFeedback(options.plugin, options.app)) {
      coordinator.dispose();
      return null;
    }
    const v1 = createArtifactFeedbackHandler({ ...baseDeps, protectedSelectionIds: root => protectedIdsWithoutStore(root) });
    const attempt = register(v1);
    if (attempt === null) {
      coordinator.dispose();
      return null;
    }
    if (attempt.status !== 'registered') {
      log.warn(`threads-design: artifact feedback handler not registered (${attempt.status}): ${attempt.message}`);
      safely(() => attempt.dispose());
      coordinator.dispose();
      return null;
    }
    registration = attempt;
  }

  const active = registration;
  return {
    dispose: () => {
      try {
        active.dispose();
      } catch (error) {
        log.warn('threads-design: disposing the artifact feedback registration failed', error);
      } finally {
        comments?.dispose();
        coordinator.dispose();
      }
    },
  };
}
