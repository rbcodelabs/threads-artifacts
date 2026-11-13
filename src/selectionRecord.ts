import type { ArtifactFeedbackRequest } from './geodeArtifactFeedback';

/**
 * The `selections/<id>.json` sidecar: the validated request minus the screenshot bytes. Shared by the
 * Send path (contract v1) and the Pin path (contract v2) so both write the same shape; the `selection`
 * member is what `comments.get` later reads back and re-validates.
 */
export interface SelectionRecordInput {
  readonly request: ArtifactFeedbackRequest;
  readonly title: string;
  readonly vaultRead: boolean;
  /** The PNG bytes that will be written, or null when none is stored (vault-read never stores one). */
  readonly png: Uint8Array | null;
  readonly contractVersion: 1 | 2;
}

export function serializeSelectionRecord(input: SelectionRecordInput): string {
  const { request, png } = input;
  const { selection } = request;
  const screenshotOmitted = png ? null : request.screenshot ? 'vault-read' : request.screenshotOmitted;
  return `${JSON.stringify({
    schemaVersion: 1,
    contractVersion: input.contractVersion,
    artifact: { artifactId: request.artifact.artifactId, title: input.title, runtime: 'static', vaultRead: input.vaultRead },
    comment: request.comment,
    selection,
    screenshot: png && request.screenshot ? { file: `${selection.selectionId}.png`, width: request.screenshot.width, height: request.screenshot.height, cssRect: request.screenshot.cssRect, devicePixelRatio: request.screenshot.devicePixelRatio, downscaled: request.screenshot.downscaled } : null,
    screenshotOmitted,
    stale: request.stale,
    submittedAt: request.submittedAt,
  }, null, 2)}\n`;
}
