// Vendored copy of Geode's src/artifacts/feedback-contract.ts (artifact feedback contract v1, ADR 0006).
// Source: rbcodelabs/geode feat/artifact-element-picker-p1 @ 807be0c143e145e2f8d8184507ce196857114efb
// (file last changed in f37399df). Everything below the marker is byte-for-byte that file; re-sync it
// verbatim and update the hash in test/geode-contract-vendor.test.ts when Geode changes it.
// --- begin verbatim copy ---
/**
 * Artifact feedback contract, version 1 (ADR 0006, D1-D3).
 *
 * Types and constants only: no runtime dependencies, no imports, so the Design
 * plugin can vendor a verbatim copy. Everything here is plain data. No DOM node,
 * webview, event, `NativeImage`, function or class instance ever crosses this
 * boundary (the single exception is the handler object itself, which flows from
 * the plugin to Geode, and the `AbortSignal` Geode hands back).
 *
 * Compatibility policy: Geode may add optional fields within a version; the
 * plugin must ignore unknown fields. A removal, type change or semantic change
 * bumps the version and Geode keeps accepting the old one for at least a release.
 */

/** What this Geode accepts. A handler's `contractVersion` must be one of these. */
export const ARTIFACT_FEEDBACK_CONTRACT_VERSIONS = [1] as const;
export const ARTIFACT_FEEDBACK_SUBMIT_TIMEOUT_MS = 15_000;

/** Geode-derived from the plugin manifest (id, name). Never self-declared. */
export interface ArtifactFeedbackOwner {
  readonly pluginId: string;
  readonly displayName: string;
}

/** Identifies the artifact for routing and the visibility check. Data only. */
export interface ArtifactFeedbackTarget {
  /** Absolute path as given to the view. The plugin must realpath and contain it. */
  readonly root: string;
  /** `manifest.id`. */
  readonly artifactId: string;
  readonly title: string;
  /** v1 never offers nextjs. */
  readonly runtime: "static";
  /** `manifest.permissions.vault === "read"`. */
  readonly vaultRead: boolean;
}

export interface ArtifactFeedbackHandler {
  /** Must equal a value in `app.artifactFeedback.contractVersions`. */
  readonly contractVersion: 1;
  /**
   * Optional, synchronous, side-effect free. Evaluated when a view loads, when the
   * registry changes, and when pick mode is toggled. Throwing or returning a
   * non-boolean counts as false. Omitted means "handles every static artifact".
   */
  canHandle?(target: ArtifactFeedbackTarget): boolean;
  /**
   * Called once per user Send (and again, with the SAME selectionId, if the user
   * retries). Resolves when the plugin has taken responsibility for the feedback,
   * NOT when the agent has finished. Must be idempotent per selection.selectionId.
   */
  submit(
    request: ArtifactFeedbackRequest,
    context: { readonly signal: AbortSignal },
  ): Promise<ArtifactFeedbackResult>;
}

export type ArtifactFeedbackRejectReason = "busy" | "invalid" | "unsupported" | "unavailable" | "failed";

export type ArtifactFeedbackResult =
  | { readonly status: "accepted"; readonly message?: string }
  | { readonly status: "rejected"; readonly reason: ArtifactFeedbackRejectReason; readonly message: string };

export type ArtifactFeedbackRegistration =
  | { readonly status: "registered"; dispose(): void }
  | {
      readonly status: "unsupported-version" | "conflict" | "invalid" | "unavailable";
      readonly message: string;
      /** Idempotent no-op here. */
      dispose(): void;
    };

/** `app.artifactFeedback`, as plugins see it (read-only). */
export interface ArtifactFeedbackRegistry {
  readonly contractVersions: readonly number[];
  /** True when some handler's `canHandle` passes for `target`. */
  has(target: ArtifactFeedbackTarget): boolean;
  /** Returns the unsubscribe function. */
  onDidChange(listener: () => void): () => void;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type ArtifactViewportPreset = "desktop" | "tablet" | "mobile" | "custom" | "fill";

export interface ElementSelection {
  readonly schemaVersion: 1;
  // ---- origin E: produced by Geode's embedder (trusted) ----
  /** `/^sel_[0-9a-f]{32}$/`, 128 random bits from the embedder. */
  readonly selectionId: string;
  /** `manifest.id`. */
  readonly artifactId: string;
  /** The view's last observed runtime revision at selection time. A lower bound, not an identity. */
  readonly artifactRevision: number;
  /** The registration id; the revision counter restarts per registration. */
  readonly viewSessionId: string;
  readonly viewportPreset: ArtifactViewportPreset;
  /** ISO 8601 UTC, embedder clock. */
  readonly capturedAt: string;
  /** True iff the artifact has `vault: read`. */
  readonly redacted: boolean;
  // ---- origin G: from the page (UNTRUSTED data, sanitized and validated) ----
  /** `location.pathname + location.hash`, at most 512. */
  readonly route: string;
  /** Lower-case local name, `/^[a-z][a-z0-9:-]{0,31}$/`. */
  readonly tag: string;
  /** At most 512; verified in the guest to resolve to this element. */
  readonly selector: string;
  /** At most 3 entries, each at most 512, distinct. */
  readonly selectorAlternates: readonly string[];
  /** Normalized text, at most 80 ("" when redacted). */
  readonly textAnchor: { readonly tag: string; readonly text: string };
  /** Nearest heading text or data-variation value, at most 120. */
  readonly landmark: string | null;
  /** At most 4096 UTF-16 units including the truncation marker. */
  readonly outerHTML: { readonly html: string; readonly truncated: boolean };
  /** At most 3; id at most 128; at most 8 classes of at most 64. */
  readonly ancestors: readonly {
    readonly tag: string;
    readonly id: string | null;
    readonly classes: readonly string[];
  }[];
  /** Keys only from the 40-name allowlist; values at most 200. */
  readonly computedStyles: Readonly<Record<string, string>>;
  /** CSS px; `document` = `viewport` + scroll (derived by the embedder). */
  readonly boundingBox: { readonly viewport: Rect; readonly document: Rect };
  readonly viewport: {
    readonly width: number;
    readonly height: number;
    readonly devicePixelRatio: number;
    readonly scrollX: number;
    readonly scrollY: number;
  };
  /** role at most 64, name at most 200 (null when redacted), tabIndex integer in [-1, 32767]. */
  readonly a11y: {
    readonly role: string | null;
    readonly name: string | null;
    readonly tabIndex: number | null;
  };
}

export type ScreenshotOmittedReason = "vault-read" | "too-large" | "capture-failed" | "empty-rect";

export interface ElementScreenshot {
  readonly mimeType: "image/png";
  /** 1..524288 bytes, PNG signature checked by Geode. */
  readonly bytes: Uint8Array;
  /** Pixels of the PNG. */
  readonly width: number;
  readonly height: number;
  /** The crop in guest viewport CSS px (element + 8 px padding, clipped to the viewport). */
  readonly cssRect: Rect;
  readonly devicePixelRatio: number;
  readonly downscaled: boolean;
}

export interface ArtifactFeedbackRequest {
  readonly contractVersion: 1;
  readonly artifact: ArtifactFeedbackTarget;
  /** TRUSTED: typed by the user in the embedder popover. 1..4000 UTF-16 units, trimmed, never seen by the guest. */
  readonly comment: string;
  /** UNTRUSTED data: every origin-G field inside. Only origin-E fields may be used outside a data fence. */
  readonly selection: ElementSelection;
  readonly screenshot: ElementScreenshot | null;
  /** Non-null iff `screenshot` is null. */
  readonly screenshotOmitted: ScreenshotOmittedReason | null;
  /** The runtime revision advanced between selection and submit. */
  readonly stale: boolean;
  /** ISO 8601 UTC. */
  readonly submittedAt: string;
}
