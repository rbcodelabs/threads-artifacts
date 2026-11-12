import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { AgentThreadsApiV1 } from './contracts';
import type { CommentRootHandle, CommentStore } from './commentStore';
import { validateFeedbackRequest, validateStoredSelection } from './elementFeedbackValidation';
import { resolveFeedbackTarget, type IntakeResult } from './feedbackIntake';
import type {
  AdoptCommentsInput,
  ArtifactCommentDetail,
  ArtifactCommentsChange,
  ArtifactCommentsProvider,
  ArtifactCommentsRejectReason,
  ArtifactCommentsResult,
} from './geodeArtifactFeedbackV2';
import { ARTIFACT_COMMENT_ID_PATTERN, ARTIFACT_COMMENTS_CAPS } from './geodeArtifactFeedbackV2';
import type { ArtifactFeedbackRequest, ArtifactFeedbackTarget } from './geodeArtifactFeedback';
import { pruneSelections, readSelectionJson, removeSelectionFiles, SELECTION_RETENTION, SIDECAR_DIR, writeSelectionFiles } from './selectionFiles';
import { serializeSelectionRecord } from './selectionRecord';

/**
 * The `comments` provider of the v2 handler (design 1.2 to 1.5, threats T5, T6, T11, T12): a thin, defensive layer
 * over the P1 store. Every call re-resolves the target through the same intake as Send, so a call can only ever
 * reach a real Design artifact inside the vault. Values go back to Geode by value (structured clones).
 *
 * Inert until `activate()`: the registration code calls it only after Geode accepted the v2 handler, so a v2
 * handler that was refused (or never registered) can never create the install key or touch comments.json.
 */

const SKEW_MS = 24 * 60 * 60 * 1000;
const MAX_BATCH = ARTIFACT_COMMENTS_CAPS.maxBatch;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;
const MESSAGES = {
  inactive: 'Comments are not available right now.',
  aborted: 'Cancelled before it was saved.',
  invalidTarget: 'This design could not be found.',
  invalidRequest: 'This pin could not be saved',
  notRedacted: 'This design can read vault notes, so pins must be redacted, and this version of Geode did not do that.',
  staleClock: 'This pin was captured too long ago or in the future. Pick the element again.',
  files: 'Could not save the selection. Check disk space and folder permissions, then try again.',
  unexpected: 'Something went wrong with the comments. Try again.',
  batchLater: 'Sending pinned comments is not available in this version yet.',
  tooManySubscribers: 'Too many listeners are watching these comments.',
} as const;

export interface CommentsProviderDeps {
  readonly api: Pick<AgentThreadsApiV1, 'threads' | 'artifacts'>;
  readonly vaultRoot: () => string | undefined;
  readonly store: CommentStore;
  readonly now?: () => number;
  /** Newest-N retention for selection files that no comment references. */
  readonly retention?: number;
  readonly warn?: (message: string, error?: unknown) => void;
}

export interface CommentsProviderController {
  readonly provider: ArtifactCommentsProvider;
  /** Allows provider calls. Idempotent. Call only after Geode accepted the v2 handler. */
  activate(): void;
  /** Selection ids retention must keep for this artifact; null when they cannot be listed (skip pruning). */
  protectedSelectionIds(root: string, artifactId: string): Promise<readonly string[] | null>;
  /** Stops answering, drops every subscription and closes the store handles. Idempotent. */
  dispose(): void;
}

const fail = (reason: ArtifactCommentsRejectReason, message: string): ArtifactCommentsResult<never> => ({ status: 'rejected', reason, message: message.slice(0, ARTIFACT_COMMENTS_CAPS.maxMessageUnits) });
const done = <T,>(value: T): ArtifactCommentsResult<T> => ({ status: 'ok', value });
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const clone = <T,>(result: ArtifactCommentsResult<T>): ArtifactCommentsResult<T> => (result.status === 'ok' ? { status: 'ok', value: structuredClone(result.value) } : { status: 'rejected', reason: result.reason, message: result.message });
const clean = (text: string): string => text.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();

/** Short display string for the rail: the tag plus the accessible name or text. Nothing at all for redacted selections. */
function labelFor(selection: ArtifactFeedbackRequest['selection']): string {
  const name = selection.redacted ? '' : clean(selection.a11y.name ?? selection.textAnchor.text ?? '');
  const label = name ? `${selection.tag} "${name}"` : selection.tag;
  return label.length > ARTIFACT_COMMENTS_CAPS.maxLabelUnits ? `${label.slice(0, ARTIFACT_COMMENTS_CAPS.maxLabelUnits - 1)}…` : label;
}

export function createArtifactCommentsProvider(deps: CommentsProviderDeps): CommentsProviderController {
  const now = deps.now ?? (() => Date.now());
  const retention = deps.retention ?? SELECTION_RETENTION;
  const warn = deps.warn ?? (() => undefined);
  const handles = new Map<string, Promise<CommentRootHandle>>();
  const subscriptions = new Set<{ dispose(): void }>();
  let active = false;
  let disposed = false;

  function handleFor(root: string, artifactId: string): Promise<CommentRootHandle> {
    let handle = handles.get(root);
    if (!handle) {
      handle = deps.store.open({ root, artifactId });
      handles.set(root, handle);
    }
    return handle;
  }

  async function intakeOf(target: unknown): Promise<Extract<IntakeResult, { ok: true }> | ArtifactCommentsResult<never>> {
    if (!isObject(target)) return fail('unavailable', MESSAGES.invalidTarget);
    const intake = await resolveFeedbackTarget(target as unknown as ArtifactFeedbackTarget, { api: deps.api, vaultRoot: deps.vaultRoot });
    return intake.ok ? intake : fail('unavailable', intake.message);
  }

  /** Common shell: active check, intake, store handle, fault isolation, data-only result. */
  async function run<T>(target: unknown, body: (handle: CommentRootHandle, intake: Extract<IntakeResult, { ok: true }>) => Promise<ArtifactCommentsResult<T>>): Promise<ArtifactCommentsResult<T>> {
    if (!active) return fail('unavailable', MESSAGES.inactive);
    try {
      const intake = await intakeOf(target);
      if ('status' in intake) return intake;
      if (!active) return fail('unavailable', MESSAGES.inactive);
      const handle = await handleFor(intake.root, intake.manifest.id);
      return clone(await body(handle, intake));
    } catch (error) {
      warn('threads-design: comments call failed', error);
      return fail('failed', MESSAGES.unexpected);
    }
  }

  async function readSelection(root: string, artifactId: string, selectionId: string, mustBeRedacted: boolean): Promise<ArtifactCommentDetail['selection']> {
    const text = await readSelectionJson(root, selectionId);
    if (text === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }
    if (!isObject(parsed)) return null;
    const selection = validateStoredSelection(parsed.selection, artifactId);
    if (selection === null || selection.selectionId !== selectionId) return null;
    // A redacted pin must never hand back an unredacted snapshot, whatever the file on disk says.
    if (mustBeRedacted && !selection.redacted) return null;
    return selection;
  }

  const provider: ArtifactCommentsProvider = {
    capabilities: { pins: true, batchSend: true, textEdit: false },

    list(target) {
      return run(target, async (handle) => done(await handle.snapshot()));
    },

    get(target, id) {
      if (typeof id !== 'string' || !ARTIFACT_COMMENT_ID_PATTERN.test(id)) return Promise.resolve(fail('invalid', 'That is not a comment id.'));
      return run(target, async (handle, intake) => {
        const found = await handle.get(id);
        if (found.status !== 'ok') return found;
        const selection = await readSelection(intake.root, intake.manifest.id, found.value.selectionId, found.value.redacted || intake.vaultRead);
        return done({ comment: found.value, selection });
      });
    },

    save(target, input, ctx) {
      return run(target, async (handle, intake) => {
        const raw = isObject(input) ? input.request : undefined;
        const validated = validateFeedbackRequest(raw);
        if (!validated.ok) return fail('invalid', `${MESSAGES.invalidRequest}: ${validated.message}`);
        const request = validated.value;
        const asked = target as ArtifactFeedbackTarget;
        if (request.artifact.artifactId !== asked.artifactId || request.artifact.root !== asked.root) return fail('invalid', `${MESSAGES.invalidRequest}: it belongs to another design.`);
        const { selection } = request;
        if (intake.vaultRead && !selection.redacted) return fail('invalid', MESSAGES.notRedacted);
        const captured = Date.parse(selection.capturedAt);
        if (!Number.isFinite(captured) || Math.abs(now() - captured) > SKEW_MS) return fail('invalid', MESSAGES.staleClock);
        if (ctx?.signal?.aborted) return fail('unavailable', MESSAGES.aborted);

        // A vault-read pin never has a PNG, even if bytes were sent, and never a text anchor (the validator already blanks it).
        const png = request.screenshot ? request.screenshot.bytes : null;
        let files;
        try {
          files = await writeSelectionFiles({
            root: intake.root,
            selectionId: selection.selectionId,
            json: serializeSelectionRecord({ request, title: intake.title, vaultRead: intake.vaultRead, png, contractVersion: 2 }),
            png,
            vaultRead: intake.vaultRead,
          });
        } catch (error) {
          warn('threads-design: could not write pin selection files', error);
          return fail('failed', MESSAGES.files);
        }

        const result = await handle.create({
          selectionId: selection.selectionId,
          createdAt: selection.capturedAt,
          artifactRevision: selection.artifactRevision,
          viewSessionId: selection.viewSessionId,
          kind: 'pin',
          text: request.comment,
          anchor: {
            route: selection.route,
            tag: selection.tag,
            selector: selection.selector,
            selectorAlternates: [...selection.selectorAlternates],
            textAnchor: { tag: selection.textAnchor.tag, text: selection.redacted ? '' : selection.textAnchor.text },
            landmark: selection.redacted ? null : selection.landmark,
            lastRect: { ...selection.boundingBox.document },
          },
          label: labelFor(selection),
          hasScreenshot: png !== null,
          redacted: selection.redacted || intake.vaultRead,
        });
        if (result.status !== 'ok') {
          // Nothing references the files we just wrote: do not leave them behind.
          if (!files.replay) await removeSelectionFiles(intake.root, selection.selectionId);
          return result;
        }
        await pruneAround(handle, intake.root, selection.selectionId);
        return result;
      });
    },

    update(target, input) {
      return run(target, (handle) => handle.update(input));
    },

    remove(target, input) {
      return run(target, (handle) => handle.remove(input));
    },

    adopt(target, input) {
      const ids = isObject(input) ? (input as unknown as AdoptCommentsInput).ids : undefined;
      if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_BATCH || !ids.every((id) => typeof id === 'string' && ARTIFACT_COMMENT_ID_PATTERN.test(id))) {
        return Promise.resolve(fail('invalid', 'Choose between 1 and 20 comments to adopt.'));
      }
      return run(target, (handle) => handle.adopt([...new Set(ids as string[])]));
    },

    subscribe(target, listener) {
      let cancelled = false;
      let inner: { dispose(): void } | null = null;
      const subscription = {
        dispose() {
          cancelled = true;
          inner?.dispose();
          inner = null;
          subscriptions.delete(subscription);
        },
      };
      if (!active || typeof listener !== 'function') return subscription;
      subscriptions.add(subscription);
      void (async () => {
        try {
          const intake = await intakeOf(target);
          if ('status' in intake || cancelled || !active) return;
          const handle = await handleFor(intake.root, intake.manifest.id);
          if (cancelled || !active) return;
          const attached = handle.subscribe((change: ArtifactCommentsChange) => {
            if (cancelled) return;
            try {
              listener(structuredClone(change));
            } catch (error) {
              warn('threads-design: a comments listener threw', error);
            }
          });
          if (attached === null) {
            warn(MESSAGES.tooManySubscribers);
            return;
          }
          if (cancelled) attached.dispose();
          else inner = attached;
        } catch (error) {
          warn('threads-design: could not subscribe to comments', error);
        }
      })();
      return subscription;
    },

    // P2b replaces this with the batch sender. Declared now because the v2 contract requires the method.
    sendBatch() {
      return Promise.resolve(fail('unavailable', MESSAGES.batchLater));
    },
  };

  /** Retention around a fresh pin: every comment's selection is exempt; if they cannot be listed, nothing is pruned. */
  async function pruneAround(handle: CommentRootHandle, root: string, selectionId: string): Promise<void> {
    try {
      const protectIds = await handle.protectedSelectionIds();
      await pruneSelections({ root, keep: retention, protectId: selectionId, protectIds });
    } catch {
      // A store that is not healthy cannot say which selections are pinned: keep everything.
    }
  }

  return {
    provider,
    activate() {
      if (!disposed) active = true;
    },
    async protectedSelectionIds(root, artifactId) {
      if (!active) return null;
      try {
        return await (await handleFor(root, artifactId)).protectedSelectionIds();
      } catch {
        return null;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      active = false;
      for (const subscription of [...subscriptions]) subscription.dispose();
      const open = [...handles.values()];
      handles.clear();
      for (const pending of open) void pending.then((handle) => handle.dispose(), () => undefined);
    },
  };
}

/**
 * Retention guard for the v1-only registration (no store): if comments were ever written for this artifact, the
 * pinned selections are unknown, so pruning is skipped. Otherwise nothing extra needs protecting.
 */
export async function protectedIdsWithoutStore(root: string): Promise<readonly string[] | null> {
  for (const name of ['comments.json', 'comments.prev.json']) {
    try {
      await fs.lstat(path.join(root, SIDECAR_DIR, name));
      return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
    }
  }
  return [];
}
