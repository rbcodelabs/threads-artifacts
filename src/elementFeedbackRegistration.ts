import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import type { AgentThreadsApiV1 } from './contracts';
import { createArtifactFeedbackHandler } from './artifactFeedbackHandler';
import {
  ARTIFACT_FEEDBACK_CONTRACT_VERSIONS,
  type ArtifactFeedbackHandler,
  type ArtifactFeedbackRegistration,
} from './geodeArtifactFeedback';
import { createSendCoordinator, type CoordinatorClock } from './sendCoordinator';

type Disposable = { dispose(): void };
type Logger = { info(message: string): void; warn(message: string, error?: unknown): void };

interface GeodePluginSurface { registerArtifactFeedbackHandler?: (handler: ArtifactFeedbackHandler) => ArtifactFeedbackRegistration }
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
}

/**
 * Registers the element-comment handler with Geode and returns one disposable that tears down the
 * registration, pending sends, timers and the thread subscription. Returns null (silently) when
 * Geode lacks the feature; never throws, so /design keeps working whatever happens here.
 */
export function registerElementFeedback(options: ElementFeedbackOptions): Disposable | null {
  const log = options.log ?? console;
  if (!supportsArtifactFeedback(options.plugin, options.app)) {
    log.info('threads-design: Geode has no artifact feedback support');
    return null;
  }
  if (!options.basePath) return null;

  const coordinator = createSendCoordinator({
    api: options.api,
    ownerPluginId: 'threads-design',
    clock: options.clock,
    onDeferredResult: ({ outcome }) => {
      if (outcome.status === 'sent') options.notify('Design: your queued comment was sent to the thread.');
      else if (outcome.status === 'rejected') options.notify(`Design: your queued comment could not be sent. ${outcome.message}`, true);
    },
  });
  const handler = createArtifactFeedbackHandler({
    api: options.api,
    coordinator,
    allowedRoots: () => [path.join(options.basePath as string, '.geode', 'artifacts'), path.join(options.basePath as string, 'Artifacts', 'threads-design')],
    boundarySecret: options.secret ?? randomBytes(32).toString('hex'),
    escalationKeywords: () => {
      try {
        const keyword = options.readEscalationKeyword?.();
        return typeof keyword === 'string' && keyword.trim() ? [keyword] : [];
      } catch {
        return [];
      }
    },
    warn: (message, error) => log.warn(message, error),
  });

  let registration: ArtifactFeedbackRegistration;
  try {
    registration = (options.plugin as GeodePluginSurface).registerArtifactFeedbackHandler!(handler);
  } catch (error) {
    log.warn('threads-design: could not register the artifact feedback handler', error);
    coordinator.dispose();
    return null;
  }
  if (registration.status !== 'registered') {
    log.warn(`threads-design: artifact feedback handler not registered (${registration.status}): ${registration.message}`);
    registration.dispose();
    coordinator.dispose();
    return null;
  }
  return { dispose: () => { registration.dispose(); coordinator.dispose(); } };
}
