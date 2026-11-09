/**
 * Vendored copy of Geode's `src/artifacts/feedback-contract.ts` (ADR 0006), contract version 1.
 * Source commit: geode feat/artifact-element-picker-p1 @ 143add69. Vendored 2026-11-08 from the
 * ADR/contract note text (Geode implementation file not yet merged); re-sync verbatim when it lands.
 * Types and constants only; no runtime dependencies. The plugin builds against the `obsidian`
 * types, so Geode-only members are reached through casts at the detection site.
 */
export const ARTIFACT_FEEDBACK_CONTRACT_VERSIONS = [1] as const;
export const ARTIFACT_FEEDBACK_SUBMIT_TIMEOUT_MS = 15_000;

export interface ArtifactFeedbackTarget {
  readonly root: string;             // absolute, as given to the view. Plugin must realpath + contain it
  readonly artifactId: string;       // manifest.id
  readonly title: string;
  readonly runtime: "static";
  readonly vaultRead: boolean;       // manifest permissions.vault === "read"
}

export interface ArtifactFeedbackHandler {
  readonly contractVersion: 1;
  canHandle?(target: ArtifactFeedbackTarget): boolean;
  submit(request: ArtifactFeedbackRequest, context: { readonly signal: AbortSignal }): Promise<ArtifactFeedbackResult>;
}

export type ArtifactFeedbackResult =
  | { readonly status: "accepted"; readonly message?: string }
  | { readonly status: "rejected"; readonly reason: "busy" | "invalid" | "unsupported" | "unavailable" | "failed"; readonly message: string };

export type ArtifactFeedbackRegistration =
  | { readonly status: "registered"; dispose(): void }
  | { readonly status: "unsupported-version" | "conflict" | "invalid" | "unavailable"; readonly message: string; dispose(): void };

export interface ArtifactFeedbackRegistry {
  readonly contractVersions: readonly number[];
  has(target: ArtifactFeedbackTarget): boolean;
  onDidChange(listener: () => void): () => void;
}

export interface Rect { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

export interface ElementSelection {
  readonly schemaVersion: 1;
  // ---- origin E: produced by Geode's embedder (trusted) ----
  readonly selectionId: string;            // /^sel_[0-9a-f]{32}$/
  readonly artifactId: string;
  readonly artifactRevision: number;
  readonly viewSessionId: string;
  readonly viewportPreset: "desktop" | "tablet" | "mobile" | "custom" | "fill";
  readonly capturedAt: string;             // ISO 8601 UTC
  readonly redacted: boolean;              // true iff vault: read
  // ---- origin G: from the page (UNTRUSTED data) ----
  readonly route: string;
  readonly tag: string;
  readonly selector: string;
  readonly selectorAlternates: readonly string[];
  readonly textAnchor: { readonly tag: string; readonly text: string };
  readonly landmark: string | null;
  readonly outerHTML: { readonly html: string; readonly truncated: boolean };
  readonly ancestors: readonly { readonly tag: string; readonly id: string | null; readonly classes: readonly string[] }[];
  readonly computedStyles: Readonly<Record<string, string>>;
  readonly boundingBox: { readonly viewport: Rect; readonly document: Rect };
  readonly viewport: { readonly width: number; readonly height: number; readonly devicePixelRatio: number; readonly scrollX: number; readonly scrollY: number };
  readonly a11y: { readonly role: string | null; readonly name: string | null; readonly tabIndex: number | null };
}

export type ScreenshotOmittedReason = "vault-read" | "too-large" | "capture-failed" | "empty-rect";

export interface ElementScreenshot {
  readonly mimeType: "image/png";
  readonly bytes: Uint8Array;              // 1..524288 bytes
  readonly width: number;
  readonly height: number;
  readonly cssRect: Rect;
  readonly devicePixelRatio: number;
  readonly downscaled: boolean;
}

export interface ArtifactFeedbackRequest {
  readonly contractVersion: 1;
  readonly artifact: ArtifactFeedbackTarget;
  readonly comment: string;                // TRUSTED, 1..4000, trimmed
  readonly selection: ElementSelection;    // origin-G fields UNTRUSTED
  readonly screenshot: ElementScreenshot | null;
  readonly screenshotOmitted: ScreenshotOmittedReason | null;   // non-null iff screenshot is null
  readonly stale: boolean;
  readonly submittedAt: string;
}
