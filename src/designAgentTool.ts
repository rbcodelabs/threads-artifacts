import type { AgentToolContribution } from './contracts';
import type { DesignService } from './DesignService';
import { DESIGN_RUNTIMES, isDesignRuntime, type DesignRuntime } from './designArtifact';
import { ARTBOARD_PRESETS, isArtboardPreset, type ArtboardPreset } from './designBoard';
import { DESIGN_MODES, DESIGN_MODE_DESCRIPTIONS, PICK_LETTER_ERROR, PICK_WITHOUT_DESIGN_ERROR, SPEC_WITHOUT_DESIGN_ERROR, isDesignMode, pickLetter } from './designModes';

const failure = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });

// Built from the shared per-mode descriptions so the tool schema and the
// slash command's autocomplete can never say different things about a mode.
const MODE_ENUM_DESCRIPTION = `Optional prompt mode for this turn. ${DESIGN_MODES.map(mode => `"${mode}": ${DESIGN_MODE_DESCRIPTIONS[mode]}`).join(' ')} Omit for a full visual design.`;

export const DESIGN_TOOL_DESCRIPTION = [
  'Use mode "report" whenever the user asks for a report, analysis, summary document or charts, instead of any cloud doc connector (Claude Docs, Google Docs). The output is a local HTML file in the vault and nothing is uploaded, so it is also the right place for personal or financial data. For report mode, begin the brief with a short plain title phrase (under 60 characters, no "Title:" prefix, no file paths) because it names the folder and artifact, with details after it.',
  'Create or reopen a design artifact for this thread and open its preview.',
  'Set runtime "static" (default) for a single-screen or simple page built from plain HTML/CSS/JS.',
  'Set runtime "nextjs" when the brief asks for a sophisticated prototype or complete app design: multi-page flows, client-side state, realistic navigation, or several connected screens.',
  'A Next.js artifact uses mock data and client state only, previews on a local dev server, and can be exported to static HTML. Modes variations, pick, spec, storyboard and report are static-only.',
  'An existing artifact keeps its runtime; it cannot be changed.',
].join(' ');

export function createDesignAgentTool(service: DesignService): AgentToolContribution {
  return {
    name: 'EnterDesignMode',
    description: DESIGN_TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        brief: { type: 'string', minLength: 1, description: 'The visual design brief or requested revision.' },
        mode: {
          type: 'string',
          enum: [...DESIGN_MODES],
          description: MODE_ENUM_DESCRIPTION,
        },
        runtime: {
          type: 'string',
          enum: [...DESIGN_RUNTIMES],
          default: 'static',
          description: 'Artifact runtime: "static" HTML/CSS/JS (default) or "nextjs" for a full multi-page app prototype.',
        },
        board: {
          type: 'boolean',
          description: 'Set true to scaffold a multi-screen Design Board (board.canvas + shared tokens.css + screens/). Omit to auto-detect from the brief; single-screen designs remain single-page.',
        },
      },
      required: ['brief'],
      additionalProperties: false,
    },
    alwaysLoad: true,
    requiresApproval: true,
    async invoke(threadId, args) {
      const brief = typeof args.brief === 'string' ? args.brief.trim() : '';
      if (!brief) return failure('A non-empty design brief is required.');
      const mode = args.mode;
      if (mode !== undefined && !isDesignMode(mode)) {
        return failure(`Unknown design mode: ${String(mode)}. Use one of: ${DESIGN_MODES.join(', ')}.`);
      }
      let runtime: DesignRuntime | undefined;
      if (args.runtime !== undefined) {
        if (!isDesignRuntime(args.runtime)) return failure(`Unsupported runtime ${JSON.stringify(args.runtime)}. Use "static" or "nextjs".`);
        runtime = args.runtime;
      }
      let board: boolean | undefined;
      if (args.board !== undefined) {
        if (typeof args.board !== 'boolean') return failure('board must be a boolean.');
        board = args.board;
      }
      if (mode === 'pick' && !pickLetter(brief)) return failure(PICK_LETTER_ERROR);
      try {
        if (mode === 'pick' && !(await service.state(threadId))?.hasArtifacts) return failure(PICK_WITHOUT_DESIGN_ERROR);
        if (mode === 'spec' && !(await service.state(threadId))?.hasArtifacts) return failure(SPEC_WITHOUT_DESIGN_ERROR);
        const result = await service.prepare(threadId, brief, { mode, runtime, board });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

const PRESET_LIST = Object.keys(ARTBOARD_PRESETS) as ArtboardPreset[];

export function createAddArtboardAgentTool(service: DesignService): AgentToolContribution {
  return {
    name: 'AddDesignArtboard',
    description: 'Append a new screen or variant artboard (screens/<slug>.html) to the thread\'s Design Board (board.canvas) with tidy non-overlapping grid placement, device presets (desktop, tablet, mobile), optional group, and optional flow arrow edge. The scaffolded screen links ../tokens.css, ../styles.css and the shared external script ../app.js; put interactivity in external script files loaded via <script src> (no inline handlers or inline <script>, which the artifact CSP blocks).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, description: 'Human-readable screen or variant name, e.g. "Mobile Checkout" or "Hero Variant B".' },
        preset: {
          type: 'string',
          enum: PRESET_LIST,
          default: 'desktop',
          description: 'Device viewport preset: "desktop" (1440×900), "tablet" (820×1180), or "mobile" (390×844).',
        },
        width: { type: 'integer', minimum: 240, maximum: 3840, description: 'Optional custom width in px (overrides preset).' },
        height: { type: 'integer', minimum: 240, maximum: 3840, description: 'Optional custom height in px (overrides preset).' },
        group: { type: 'string', description: 'Optional canvas group label to place this artboard inside.' },
        fromArtboardId: { type: 'string', description: 'Optional existing artboard node id (e.g. "artboard-home") to draw a flow arrow from.' },
        edgeLabel: { type: 'string', description: 'Optional label for the flow arrow edge (used when fromArtboardId is set).' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    alwaysLoad: true,
    requiresApproval: false,
    async invoke(threadId, args) {
      const name = typeof args.name === 'string' ? args.name.trim() : '';
      if (!name) return failure('A non-empty artboard name is required.');
      let preset: ArtboardPreset | undefined;
      if (args.preset !== undefined) {
        if (!isArtboardPreset(args.preset)) {
          return failure(`Unsupported preset ${JSON.stringify(args.preset)}. Use one of: ${PRESET_LIST.join(', ')}.`);
        }
        preset = args.preset;
      }
      const width = typeof args.width === 'number' ? args.width : undefined;
      const height = typeof args.height === 'number' ? args.height : undefined;
      const group = typeof args.group === 'string' ? args.group : undefined;
      const fromArtboardId = typeof args.fromArtboardId === 'string' ? args.fromArtboardId : undefined;
      const edgeLabel = typeof args.edgeLabel === 'string' ? args.edgeLabel : undefined;
      try {
        const result = await service.addArtboard(threadId, { name, preset, width, height, group, fromArtboardId, edgeLabel });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }
    },
  };
}
