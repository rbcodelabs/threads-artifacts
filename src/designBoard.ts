import * as path from 'node:path';
import type { DesignArtifactFs } from './designArtifact';
import { slugifyFolderName } from './designStorage';
import type { HostThemeSnapshot } from './hostTheme';

export const ARTBOARD_PRESETS = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 820, height: 1180 },
  mobile: { width: 390, height: 844 },
} as const;

export type ArtboardPreset = keyof typeof ARTBOARD_PRESETS;

export function isArtboardPreset(value: unknown): value is ArtboardPreset {
  return typeof value === 'string' && value in ARTBOARD_PRESETS;
}

export interface CanvasFileNode {
  id: string;
  type: 'file';
  file: string;
  subpath?: string;
  /** Short header text for the artboard (extra JSON Canvas property; ignored by hosts that don't use it). */
  label?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
}

export interface CanvasGroupNode {
  id: string;
  type: 'group';
  label?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
}

export interface CanvasOtherNode {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  [key: string]: unknown;
}

export type CanvasNode = CanvasFileNode | CanvasGroupNode | CanvasOtherNode;

export interface CanvasEdge {
  id: string;
  fromNode: string;
  fromSide?: 'top' | 'right' | 'bottom' | 'left';
  fromEnd?: 'none' | 'arrow';
  toNode: string;
  toSide?: 'top' | 'right' | 'bottom' | 'left';
  toEnd?: 'none' | 'arrow';
  label?: string;
  color?: string;
}

export interface CanvasDocument {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  [key: string]: unknown;
}

export interface BoardScaffoldResult {
  boardPath: string;
  boardVaultPath: string;
  tokensPath: string;
  initialArtboardId: string;
}

export interface AddArtboardInput {
  name: string;
  preset?: ArtboardPreset;
  width?: number;
  height?: number;
  group?: string;
  fromArtboardId?: string;
  edgeLabel?: string;
}

export interface AddedArtboardResult {
  node: CanvasFileNode;
  screenPath: string;
  screenRelativePath: string;
  boardPath: string;
  boardVaultPath: string;
  edge?: CanvasEdge;
}

const GRID_GAP_X = 100;
const GRID_GAP_Y = 120;
const MAX_ROW_WIDTH = 4600;
const GROUP_PADDING = 40;
const INITIAL_ARTBOARD_ID = 'artboard-home';

const MULTI_SCREEN_PATTERNS = [
  /\b(?:multiple|several|two|three|four|five|six|[2-9]|\d{2,})\s+(?:screens?|pages?|views?|artboards?|variants?|variations?|layouts?|flows?)\b/i,
  /\b(?:desktop\s+(?:and|&|\+|\/)\s+mobile|mobile\s+(?:and|&|\+|\/)\s+desktop|desktop\s*,\s*tablet\s*(?:,?\s*and\s*)?mobile)\b/i,
  /\b(?:design\s+board|design\s+canvas|artboard\s+canvas|multi[- ]screen|multi[- ]page|multi[- ]view)\b/i,
  /\b(?:onboarding|checkout|signup|sign[- ]up|user|screen)\s+flow\b/i,
];

/**
 * Determines whether a design request should scaffold a multi-screen Design Board (`board.canvas`).
 * Explicit `board` flag always wins; otherwise boards are created only when multiple screens/flows are requested.
 */
export function isMultiScreenRequest(brief: string, explicitBoard?: boolean): boolean {
  if (typeof explicitBoard === 'boolean') return explicitBoard;
  const trimmed = brief.trim();
  if (!trimmed) return false;
  return MULTI_SCREEN_PATTERNS.some(pattern => pattern.test(trimmed));
}

/** Converts an absolute path under a vault root to a vault-relative POSIX path. */
export function toVaultRelativePath(targetPath: string, vaultRoot?: string): string {
  const normalizedTarget = targetPath.replace(/\\/g, '/');
  if (vaultRoot) {
    const normalizedRoot = vaultRoot.replace(/\\/g, '/').replace(/\/+$/, '');
    if (normalizedTarget.startsWith(`${normalizedRoot}/`)) {
      return normalizedTarget.slice(normalizedRoot.length + 1);
    }
  }
  const artifactsIdx = normalizedTarget.indexOf('/Artifacts/');
  if (artifactsIdx !== -1) {
    return normalizedTarget.slice(artifactsIdx + 1);
  }
  return path.posix.basename(normalizedTarget);
}

export function scaffoldTokensCss(theme: HostThemeSnapshot): string {
  const isLight = theme.mode === 'light';
  const surface = isLight ? '#ffffff' : '#181b23';
  return `:root {
  color-scheme: ${theme.mode};
  --bg: ${theme.background};
  --surface: ${surface};
  --text: ${theme.text};
  --muted: ${theme.mutedText};
  --accent: ${theme.accent};
  --border: ${theme.border};
  --radius-sm: 8px;
  --radius-md: 14px;
  --radius-lg: 24px;
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-6: 24px;
  --space-8: 32px;
  --font-sans: ${theme.interfaceFont};
  --font-mono: ui-monospace, SFMono-Regular, Menlo, monospace;
}
`;
}

/** Shared external script every screen links via ../app.js. Artifact pages run under script-src artifact:, so inline scripts and handlers never run. */
export const BOARD_SHARED_SCRIPT = `document.documentElement.dataset.artifactReady = 'true';\n`;

export function screenScaffoldHtml(title: string): string {
  const safeTitle = title
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${safeTitle}</title>
  <link rel="stylesheet" href="../tokens.css">
  <link rel="stylesheet" href="../styles.css">
</head>
<body>
  <main class="design-shell" aria-live="polite">
    <p class="eyebrow">Design Board</p>
    <h1>${safeTitle}</h1>
    <p class="status">Ready to design.</p>
  </main>
  <script src="../app.js"></script>
</body>
</html>
`;
}

async function writeIfMissing(fileFs: DesignArtifactFs, target: string, content: string): Promise<void> {
  try {
    await fileFs.writeFile(target, content, { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

export async function scaffoldBoardFiles(
  root: string,
  fileFs: DesignArtifactFs,
  theme: HostThemeSnapshot,
  vaultRoot?: string,
  /** Short title shown as the first artboard's header label. */
  title?: string,
): Promise<BoardScaffoldResult> {
  const tokensPath = path.join(root, 'tokens.css');
  const boardPath = path.join(root, 'board.canvas');
  const manifestVaultPath = toVaultRelativePath(path.join(root, 'artifact.json'), vaultRoot);
  const boardVaultPath = toVaultRelativePath(boardPath, vaultRoot);

  await fileFs.mkdir(path.join(root, 'screens'), { recursive: true });
  await writeIfMissing(fileFs, tokensPath, scaffoldTokensCss(theme));
  await writeIfMissing(fileFs, path.join(root, 'app.js'), BOARD_SHARED_SCRIPT);

  const initialCanvas: CanvasDocument = {
    nodes: [
      {
        id: INITIAL_ARTBOARD_ID,
        type: 'file',
        file: manifestVaultPath,
        ...(title ? { label: title } : {}),
        x: 0,
        y: 0,
        width: ARTBOARD_PRESETS.desktop.width,
        height: ARTBOARD_PRESETS.desktop.height,
      },
    ],
    edges: [],
  };
  await writeIfMissing(fileFs, boardPath, `${JSON.stringify(initialCanvas, null, 2)}\n`);

  return {
    boardPath,
    boardVaultPath,
    tokensPath,
    initialArtboardId: INITIAL_ARTBOARD_ID,
  };
}

/**
 * Computes a clean, non-overlapping grid position for a new artboard on the canvas.
 * Groups nodes into horizontal rows up to MAX_ROW_WIDTH before wrapping to a new row.
 */
export function computeNextArtboardPosition(
  nodes: readonly CanvasNode[],
  width: number,
  height: number,
): { x: number; y: number } {
  const contentNodes = nodes.filter(node => node.type !== 'group');
  if (contentNodes.length === 0) return { x: 0, y: 0 };

  // Find the bottom-most row (nodes whose top y is within 200px of the max top y).
  const maxTop = Math.max(...contentNodes.map(node => node.y));
  const lastRow = contentNodes.filter(node => Math.abs(node.y - maxTop) <= 200);
  const rowLeft = Math.min(...lastRow.map(node => node.x));
  const rowRight = Math.max(...lastRow.map(node => node.x + node.width));
  const candidateX = rowRight + GRID_GAP_X;

  if (candidateX + width - rowLeft <= MAX_ROW_WIDTH) {
    return { x: candidateX, y: maxTop };
  }

  const maxBottom = Math.max(...contentNodes.map(node => node.y + node.height));
  return { x: 0, y: maxBottom + GRID_GAP_Y };
}

function uniqueId(base: string, existingIds: Set<string>): string {
  if (!existingIds.has(base)) return base;
  let n = 2;
  while (existingIds.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

function resolveArtboardDimensions(input: AddArtboardInput): { width: number; height: number } {
  const presetDims = ARTBOARD_PRESETS[input.preset ?? 'desktop'];
  const clamp = (value: number | undefined, fallback: number): number => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
    return Math.min(3840, Math.max(240, Math.round(value)));
  };
  return {
    width: clamp(input.width, presetDims.width),
    height: clamp(input.height, presetDims.height),
  };
}

function upsertGroupForNode(doc: CanvasDocument, groupLabel: string, node: CanvasFileNode): void {
  const existing = doc.nodes.find(
    (candidate): candidate is CanvasGroupNode => candidate.type === 'group' && candidate.label === groupLabel,
  );
  if (existing) {
    const left = Math.min(existing.x, node.x - GROUP_PADDING);
    const top = Math.min(existing.y, node.y - GROUP_PADDING);
    const right = Math.max(existing.x + existing.width, node.x + node.width + GROUP_PADDING);
    const bottom = Math.max(existing.y + existing.height, node.y + node.height + GROUP_PADDING);
    existing.x = left;
    existing.y = top;
    existing.width = right - left;
    existing.height = bottom - top;
    return;
  }
  const existingIds = new Set(doc.nodes.map(n => n.id));
  const groupSlug = slugifyFolderName(groupLabel) || 'group';
  const groupNode: CanvasGroupNode = {
    id: uniqueId(`group-${groupSlug}`, existingIds),
    type: 'group',
    label: groupLabel,
    x: node.x - GROUP_PADDING,
    y: node.y - GROUP_PADDING,
    width: node.width + GROUP_PADDING * 2,
    height: node.height + GROUP_PADDING * 2,
  };
  // Groups render behind content nodes in JSON Canvas.
  doc.nodes.unshift(groupNode);
}

/**
 * Adds a new screen artboard to `board.canvas` (creating `board.canvas` and `tokens.css`
 * if upgrading a single-screen artifact), places it in a tidy grid, and optionally
 * attaches a group and/or a flow arrow edge from an existing artboard.
 */
export async function addArtboardToBoard(
  root: string,
  input: AddArtboardInput,
  fileFs: DesignArtifactFs,
  theme: HostThemeSnapshot,
  vaultRoot?: string,
): Promise<AddedArtboardResult> {
  const title = input.name.trim();
  if (!title) throw new Error('Artboard name is required.');

  const boardPath = path.join(root, 'board.canvas');
  const boardVaultPath = toVaultRelativePath(boardPath, vaultRoot);
  const manifestVaultPath = toVaultRelativePath(path.join(root, 'artifact.json'), vaultRoot);

  let doc: CanvasDocument;
  try {
    const raw = fileFs.readFile ? await fileFs.readFile(boardPath) : undefined;
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<CanvasDocument>;
      doc = {
        ...parsed,
        nodes: Array.isArray(parsed.nodes) ? [...parsed.nodes] : [],
        edges: Array.isArray(parsed.edges) ? [...parsed.edges] : [],
      };
    } else {
      await scaffoldBoardFiles(root, fileFs, theme, vaultRoot);
      doc = {
        nodes: [
          {
            id: INITIAL_ARTBOARD_ID,
            type: 'file',
            file: manifestVaultPath,
            x: 0,
            y: 0,
            width: ARTBOARD_PRESETS.desktop.width,
            height: ARTBOARD_PRESETS.desktop.height,
          },
        ],
        edges: [],
      };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      await scaffoldBoardFiles(root, fileFs, theme, vaultRoot);
      doc = {
        nodes: [
          {
            id: INITIAL_ARTBOARD_ID,
            type: 'file',
            file: manifestVaultPath,
            x: 0,
            y: 0,
            width: ARTBOARD_PRESETS.desktop.width,
            height: ARTBOARD_PRESETS.desktop.height,
          },
        ],
        edges: [],
      };
    } else {
      throw new Error(`Could not read board.canvas: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const existingIds = new Set(doc.nodes.map(n => n.id));
  const baseSlug = slugifyFolderName(title) || 'screen';
  const nodeId = uniqueId(`artboard-${baseSlug}`, existingIds);
  const fileSlug = nodeId.replace(/^artboard-/, '');
  const screenRelativePath = `screens/${fileSlug}.html`;
  const screenPath = path.join(root, 'screens', `${fileSlug}.html`);

  await fileFs.mkdir(path.join(root, 'screens'), { recursive: true });
  await writeIfMissing(fileFs, path.join(root, 'tokens.css'), scaffoldTokensCss(theme));
  await writeIfMissing(fileFs, path.join(root, 'app.js'), BOARD_SHARED_SCRIPT);
  await writeIfMissing(fileFs, screenPath, screenScaffoldHtml(title));

  const { width, height } = resolveArtboardDimensions(input);
  const { x, y } = computeNextArtboardPosition(doc.nodes, width, height);

  const node: CanvasFileNode = {
    id: nodeId,
    type: 'file',
    file: manifestVaultPath,
    subpath: `#${screenRelativePath}`,
    label: title,
    x,
    y,
    width,
    height,
  };
  doc.nodes.push(node);

  if (input.group?.trim()) {
    upsertGroupForNode(doc, input.group.trim(), node);
  }

  let edge: CanvasEdge | undefined;
  if (input.fromArtboardId?.trim()) {
    const fromId = input.fromArtboardId.trim();
    const fromExists = doc.nodes.some(n => n.id === fromId);
    if (!fromExists) {
      throw new Error(`Source artboard "${fromId}" does not exist on board.canvas.`);
    }
    const existingEdgeIds = new Set(doc.edges.map(e => e.id));
    edge = {
      id: uniqueId(`edge-${fromId}-${node.id}`, existingEdgeIds),
      fromNode: fromId,
      fromSide: 'right',
      toNode: node.id,
      toSide: 'left',
      toEnd: 'arrow',
      ...(input.edgeLabel?.trim() ? { label: input.edgeLabel.trim() } : {}),
    };
    doc.edges.push(edge);
  }

  await fileFs.writeFile(boardPath, `${JSON.stringify(doc, null, 2)}\n`);

  return {
    node,
    screenPath,
    screenRelativePath,
    boardPath,
    boardVaultPath,
    edge,
  };
}
