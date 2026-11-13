// Vendored copy of Geode's src/artifacts/feedback-contract-v2.ts (artifact feedback contract v2, ADR 0006 addendum 1).
// Source: rbcodelabs/geode feat/picker-pins-g1-contract-v2 @ 7e75a77451aa3cd0f083212be1adf9c25521440b (PR #457;
// file last changed in 276e9ac2574814a3fe55dc71c9a9a107be195ac6). Everything below the marker is byte-for-byte
// that file, except the ONE import specifier ("./feedback-contract" became "./geodeArtifactFeedback", the
// plugin's vendored v1 file name). When Geode changes it, RE-DIFF and update the hash in
// test/geode-contract-v2-vendor.test.ts.
// --- begin verbatim copy ---
/**
 * Artifact feedback contract, version 2 (ADR 0006 Addendum 1, Phase 2b-i).
 *
 * A superset of v1 in a new file: `feedback-contract.ts` is unchanged (a test hashes it) and this file takes one
 * `import type` from it. A v2 handler is a v1 handler (it still implements `submit`) plus `contractVersion: 2` and a
 * required `comments` provider. Types and constants only, so the Design plugin can vendor a verbatim copy.
 *
 * The block from the import below to the end of the file is the normative text of ADR 0006 Addendum 1, A.3, and is
 * kept identical to it by a unit test.
 */
import type {
  ArtifactFeedbackHandler,
  ArtifactFeedbackRequest,
  ArtifactFeedbackTarget,
  ElementSelection,
  Rect,
} from "./geodeArtifactFeedback";

/** What this Geode accepts. v1 lives in feedback-contract.ts and is unchanged. */
export const ARTIFACT_FEEDBACK_SUPPORTED_VERSIONS = [1, 2] as const;

export const ARTIFACT_COMMENTS_CALL_TIMEOUT_MS = 10_000;  // list, get, save, update, remove, adopt, reportAnchors
export const ARTIFACT_COMMENTS_SEND_TIMEOUT_MS = 15_000;  // sendBatch (same as v1 submit)

export const ARTIFACT_COMMENTS_CAPS = {
  maxComments: 200,            // live comments per artifact, all statuses
  maxBatch: 20,                // ids per sendBatch
  maxTextUnits: 4000,          // UTF-16 units, same as the v1 comment
  maxLabelUnits: 120,
  maxNoticeUnits: 300,
  maxMessageUnits: 500,
  maxSubscribersPerRoot: 8,
  maxReportAnchors: 100,
} as const;

/** `cmt_` + the 32 hex digits of the embedder-generated selectionId (`sel_<32 hex>`). Never supplied by the page. */
export const ARTIFACT_COMMENT_ID_PATTERN = /^cmt_[0-9a-f]{32}$/;
/** Embedder-generated idempotency token for one user action (batch send, text edit). */
export const ARTIFACT_COMMENTS_REQUEST_ID_PATTERN = /^req_[0-9a-f]{32}$/;

export type ArtifactCommentStatus = "open" | "pending" | "sent" | "resolved" | "dismissed";

/** "foreign" = the signature does not verify on this install (copied, imported, hand-edited). Foreign comments cannot be sent until adopted. */
export type ArtifactCommentProvenance = "local" | "foreign";

/** "pin" is the only kind 2b-i produces. "text-edit" is reserved for the 2b-ii fallback comment; consumers must tolerate unknown kinds. */
export type ArtifactCommentKind = "pin" | "text-edit";

/** Computed by Geode from guest results; never stored by the plugin as truth. */
export type ArtifactAnchorState = "exact" | "moved" | "approximate" | "detached" | "other-route" | "unknown";

export interface ArtifactCommentAnchor {
  readonly route: string;                                   // <= 512
  readonly tag: string;                                     // /^[a-z][a-z0-9:-]{0,31}$/
  readonly selector: string;                                // <= 512, may be ""
  readonly selectorAlternates: readonly string[];           // <= 3 x <= 512
  readonly textAnchor: { readonly tag: string; readonly text: string };   // text <= 80, "" when redacted
  readonly landmark: string | null;                         // <= 120
  /** Document-space CSS px at the last observation (selection time or last healed anchor). Advisory. */
  readonly lastRect: Rect | null;
}

/** Everything in `anchor`, `label` and `selection` is origin G (page-derived): untrusted data, render with textContent only. */
export interface ArtifactComment {
  readonly id: string;                                      // ARTIFACT_COMMENT_ID_PATTERN
  readonly selectionId: string;                             // sel_<32 hex>; the sidecar selections/<selectionId>.json
  readonly ordinal: number;                                 // >= 1, monotonic per artifact, never reused: the number on the badge
  readonly version: number;                                 // >= 1, +1 on every change to this comment (optimistic concurrency)
  readonly kind: ArtifactCommentKind;
  readonly status: ArtifactCommentStatus;
  readonly provenance: ArtifactCommentProvenance;
  /** 1..4000. Typed by the user. Trustworthy only when provenance === "local". */
  readonly text: string;
  readonly createdAt: string;                               // ISO 8601 UTC
  readonly updatedAt: string;
  readonly sentAt: string | null;
  readonly artifactRevision: number;                        // opaque; meaningful only with viewSessionId
  readonly viewSessionId: string;
  readonly anchor: ArtifactCommentAnchor;
  /** Short display string (<= 120): tag plus accessible name or text. Untrusted. */
  readonly label: string;
  readonly hasScreenshot: boolean;
  readonly redacted: boolean;                               // the artifact had vault: read when this was pinned
  readonly send: {
    readonly attempts: number;
    readonly lastOutcome: "sent" | "queued" | "failed" | "unknown" | null;
    /** true after a crash or reload while pending: the message may already have reached the thread. */
    readonly maybeSent: boolean;
    readonly lastMessage: string | null;                    // <= 500, plugin-authored
  };
}

/** `get` additionally returns the stored selection snapshot (origin G). Null when the sidecar file was pruned or failed validation. */
export interface ArtifactCommentDetail {
  readonly comment: ArtifactComment;
  readonly selection: ElementSelection | null;
}

export interface ArtifactCommentsSnapshot {
  /** Random per store instance. A different storeId means cached revisions are meaningless: refetch everything. */
  readonly storeId: string;
  /** Monotonic within a storeId; bumps on every committed change, including external-edit recovery. */
  readonly revision: number;
  readonly health: "ok" | "recovered" | "read-only" | "unavailable";
  /** Plain text, <= 300. Set when health !== "ok" or when foreign comments exist. */
  readonly notice: string | null;
  /** Ordered by ordinal ascending. At most ARTIFACT_COMMENTS_CAPS.maxComments. */
  readonly comments: readonly ArtifactComment[];
  readonly foreignCount: number;
}

export type ArtifactCommentsRejectReason =
  | "not-found" | "conflict" | "invalid" | "invalid-transition" | "limit"
  | "read-only" | "foreign" | "busy" | "unavailable" | "failed";

export type ArtifactCommentsResult<T> =
  | { readonly status: "ok"; readonly value: T }
  | { readonly status: "rejected"; readonly reason: ArtifactCommentsRejectReason; readonly message: string };   // message <= 500, plain text

export interface ArtifactCommentsCallContext { readonly signal: AbortSignal }

/**
 * Save a pin. The input is the v1 request Geode already builds for Send (comment, selection, screenshot, stale), so the
 * pixels, redaction and validation rules are identical. Idempotent: the comment id is derived from
 * request.selection.selectionId; saving the same selectionId with the same content returns the existing comment (ok),
 * with different content returns "conflict".
 */
export interface SavePinnedCommentInput { readonly request: ArtifactFeedbackRequest }

export type UpdateCommentChange =
  | { readonly action: "resolve" | "dismiss" | "reopen" | "unqueue" }
  | { readonly text: string };

export interface UpdateCommentInput {
  readonly id: string;
  /** Must equal the comment's current version, else "conflict" (the caller refetches). */
  readonly expectedVersion: number;
  readonly change: UpdateCommentChange;
}

export interface RemoveCommentInput { readonly id: string; readonly expectedVersion: number }

export interface AdoptCommentsInput { readonly ids: readonly string[] }   // <= maxBatch

export type ArtifactCommentsChangeReason = "local" | "send-result" | "external" | "recovered";

export interface ArtifactCommentsChange {
  readonly storeId: string;
  readonly revision: number;
  readonly reason: ArtifactCommentsChangeReason;
  /** Ids touched (<= 200), or "all" after recovery or an external rewrite. Geode answers with one `list`. */
  readonly ids: readonly string[] | "all";
}

export interface SendCommentsInput {
  /** Embedder-generated per user action; a retry after Geode's timeout reuses it. */
  readonly requestId: string;
  /** 1..20 distinct ids. Sent in ordinal order regardless of this order. */
  readonly ids: readonly string[];
  /** true only for the explicit "Send again" action on comments already in status "sent". */
  readonly resend: boolean;
  /** Geode's view of where each pin is now. Advisory enum data for the prompt; never trusted for anything else. */
  readonly anchorStates: Readonly<Record<string, ArtifactAnchorState>>;
}

export type BatchItemResult = "sent" | "queued" | "deferred" | "skipped";
export type BatchSkipReason = "not-found" | "not-sendable" | "foreign" | "too-large" | "conflict";

export interface BatchSendReport {
  readonly requestId: string;
  /** sent: all delivered. queued: all held for the busy agent. partial: some deferred or skipped. none: nothing left the plugin. */
  readonly outcome: "sent" | "queued" | "partial" | "none";
  readonly items: readonly {
    readonly id: string;
    readonly result: BatchItemResult;
    readonly reason?: BatchSkipReason;                      // present iff skipped
  }[];
  readonly message: string;                                  // <= 500, plain text, shown in the rail status line
}

export interface AnchorReport {
  readonly id: string;
  readonly state: ArtifactAnchorState;
  /** Guest-computed replacement anchor for a healed pin ("moved"/"approximate"); absent otherwise. Untrusted, same caps as ArtifactCommentAnchor. */
  readonly healed?: Pick<ArtifactCommentAnchor, "selector" | "selectorAlternates" | "textAnchor" | "landmark" | "lastRect">;
}

export interface ArtifactCommentsCapabilities {
  readonly pins: true;
  readonly batchSend: true;
  /** 2b-ii. When false, commitTextEdit/undoTextEdit are absent and Geode does not offer double-click editing. */
  readonly textEdit: boolean;
}

export interface ArtifactCommentsProvider {
  readonly capabilities: ArtifactCommentsCapabilities;
  list(target: ArtifactFeedbackTarget, ctx: ArtifactCommentsCallContext): Promise<ArtifactCommentsResult<ArtifactCommentsSnapshot>>;
  get(target: ArtifactFeedbackTarget, id: string, ctx: ArtifactCommentsCallContext): Promise<ArtifactCommentsResult<ArtifactCommentDetail>>;
  save(target: ArtifactFeedbackTarget, input: SavePinnedCommentInput, ctx: ArtifactCommentsCallContext): Promise<ArtifactCommentsResult<{ readonly comment: ArtifactComment; readonly created: boolean }>>;
  update(target: ArtifactFeedbackTarget, input: UpdateCommentInput, ctx: ArtifactCommentsCallContext): Promise<ArtifactCommentsResult<ArtifactComment>>;
  remove(target: ArtifactFeedbackTarget, input: RemoveCommentInput, ctx: ArtifactCommentsCallContext): Promise<ArtifactCommentsResult<{ readonly id: string }>>;
  /** foreign -> local, after the user has read the text in the rail. Re-signs. */
  adopt(target: ArtifactFeedbackTarget, input: AdoptCommentsInput, ctx: ArtifactCommentsCallContext): Promise<ArtifactCommentsResult<{ readonly adopted: readonly string[] }>>;
  /** At most one live listener per call; the plugin coalesces bursts into one change per microtask turn. */
  subscribe(target: ArtifactFeedbackTarget, listener: (change: ArtifactCommentsChange) => void): { dispose(): void };
  sendBatch(target: ArtifactFeedbackTarget, input: SendCommentsInput, ctx: ArtifactCommentsCallContext): Promise<ArtifactCommentsResult<BatchSendReport>>;
  /** Optional. Geode calls it debounced (>= 2 s stable, only on a state change). The plugin ignores reports for foreign comments. */
  reportAnchors?(target: ArtifactFeedbackTarget, reports: readonly AnchorReport[], ctx: ArtifactCommentsCallContext): Promise<ArtifactCommentsResult<{ readonly applied: number }>>;
  // ---- 2b-ii, shape only. Present iff capabilities.textEdit. Nothing in 2b-i implements or calls these. ----
  commitTextEdit?(target: ArtifactFeedbackTarget, commit: ArtifactTextEditCommit, ctx: ArtifactCommentsCallContext): Promise<ArtifactCommentsResult<ArtifactTextEditOutcome>>;
  undoTextEdit?(target: ArtifactFeedbackTarget, input: { readonly undoId: string }, ctx: ArtifactCommentsCallContext): Promise<ArtifactCommentsResult<{ readonly restored: boolean }>>;
}

export interface ArtifactTextEditCommit {
  readonly requestId: string;                                // ARTIFACT_COMMENTS_REQUEST_ID_PATTERN
  readonly route: string;
  readonly selector: string;
  readonly selectorAlternates: readonly string[];
  readonly before: string;                                   // raw textContent, <= 2048 UTF-8 bytes
  readonly after: string;                                    // <= 2048 UTF-8 bytes; the plugin validates and escapes
  readonly occurrence: { readonly k: number; readonly n: number } | null;   // k-th of n identical-text matches, document order
  /** The full v1 selection so a refusal can become a pending comment without a second round trip. */
  readonly selection: ElementSelection;
  readonly artifactRevision: number;
  readonly viewSessionId: string;
}

export type ArtifactTextEditFallbackReason =
  | "ambiguous" | "js-rendered" | "mixed-inline" | "unsafe-text" | "file-changed" | "not-writable" | "unsupported";

export type ArtifactTextEditOutcome =
  | { readonly status: "written"; readonly undoId: string; readonly file: string; readonly message: string }
  | { readonly status: "fallback"; readonly commentId: string; readonly reason: ArtifactTextEditFallbackReason; readonly message: string };

/** v2 handler: the v1 handler (including its required `submit`) with contractVersion 2 and a required provider. */
export interface ArtifactFeedbackHandlerV2 extends Omit<ArtifactFeedbackHandler, "contractVersion"> {
  readonly contractVersion: 2;
  readonly comments: ArtifactCommentsProvider;
}

export type AnyArtifactFeedbackHandler = ArtifactFeedbackHandler | ArtifactFeedbackHandlerV2;
