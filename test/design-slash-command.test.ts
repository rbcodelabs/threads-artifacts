import { describe, expect, it, vi } from 'vitest';
import { createDesignSlashCommand, parseDesignArgs, type DesignSlashCommandDependencies } from '../src/designSlashCommand';
import type { SlashCommandContext, SlashCommandHost } from '../src/contracts';
import { DESIGN_MODE_DESCRIPTIONS } from '../src/designModes';

function fixture() {
  const deps: DesignSlashCommandDependencies = {
    getState: vi.fn(() => ({ hasArtifacts: false })),
    isDesktopFilesystem: vi.fn(() => true),
    prepare: vi.fn(async () => ({ artifact: { title: 'Pricing' }, instructions: 'kickoff instructions' })),
    send: vi.fn(async () => {}),
    dispatch: vi.fn(async () => 'new-thread'),
  };
  const controller = new AbortController();
  const host: SlashCommandHost = { signal: controller.signal, report: vi.fn() };
  const context: SlashCommandContext = { surface: 'thread', text: '/design pricing', args: 'pricing', threadId: 'original-thread', hasImages: false, hasAttachment: false };
  const command = createDesignSlashCommand(deps);
  return { deps, host, context, command, controller };
}

describe('Design slash command contribution', () => {
  it('describes both surfaces including modes', () => {
    const { command } = fixture();
    expect(command.name).toBe('design');
    expect(command.thread?.description).toBe('Create or revise a live UI artifact (static HTML by default, --nextjs for a full app prototype). For a report, analysis or charts use /design report: <brief> (local HTML in the vault, nothing uploaded). /design [--nextjs] <brief> or /design [--nextjs] <mode>: <brief> (wireframe, states, variations, pick, spec, storyboard, report)');
    expect(command.thread?.description).toContain('/design report:');
    expect(command.dispatch?.description).toBe('Dispatch a thread with a live UI artifact (static HTML by default, --nextjs for a full app prototype). For a report, analysis or charts use /design report: <brief> (local HTML in the vault, nothing uploaded). /design [--nextjs] <brief> or /design [--nextjs] <mode>: <brief> (wireframe, states, variations, pick, spec, storyboard, report)');
  });

  it('offers all 7 mode keywords with their colons as thread argument completions', () => {
    const { command } = fixture();
    expect(command.thread?.argCompletions).toEqual([
      { name: 'wireframe:', description: DESIGN_MODE_DESCRIPTIONS.wireframe },
      { name: 'states:', description: DESIGN_MODE_DESCRIPTIONS.states },
      { name: 'variations:', description: DESIGN_MODE_DESCRIPTIONS.variations },
      { name: 'pick:', description: DESIGN_MODE_DESCRIPTIONS.pick },
      { name: 'spec:', description: DESIGN_MODE_DESCRIPTIONS.spec },
      { name: 'storyboard:', description: DESIGN_MODE_DESCRIPTIONS.storyboard },
      { name: 'report:', description: DESIGN_MODE_DESCRIPTIONS.report },
    ]);
  });

  it('offers only the modes valid on dispatch as dispatch argument completions, excluding pick and spec', () => {
    const { command } = fixture();
    expect(command.dispatch?.argCompletions).toEqual([
      { name: 'wireframe:', description: DESIGN_MODE_DESCRIPTIONS.wireframe },
      { name: 'states:', description: DESIGN_MODE_DESCRIPTIONS.states },
      { name: 'variations:', description: DESIGN_MODE_DESCRIPTIONS.variations },
      { name: 'storyboard:', description: DESIGN_MODE_DESCRIPTIONS.storyboard },
      { name: 'report:', description: DESIGN_MODE_DESCRIPTIONS.report },
    ]);
    const names = command.dispatch?.argCompletions?.map(c => c.name) ?? [];
    expect(names).not.toContain('pick:');
    expect(names).not.toContain('spec:');
    expect(command.dispatch?.argCompletions).toHaveLength(5);
  });

  it('requires a brief for an empty thread', async () => {
    const { command, deps, context, host } = fixture();
    const result = await command.thread!.invoke({ ...context, args: '' }, host);
    expect(result).toMatchObject({ status: 'error', message: expect.stringContaining('Include a brief') });
    expect(deps.prepare).not.toHaveBeenCalled();
  });

  it('requires desktop filesystem before preparing', async () => {
    const { command, deps, context, host } = fixture();
    vi.mocked(deps.isDesktopFilesystem).mockReturnValue(false);
    expect(await command.thread!.invoke(context, host)).toEqual({ status: 'error', message: 'Design artifacts require a desktop vault with local filesystem access.' });
    expect(deps.prepare).not.toHaveBeenCalled();
  });

  it.each([undefined, 'Existing title'])('reopens a bare command using existing title %s without sending', async existingTitle => {
    const { command, deps, context, host } = fixture();
    vi.mocked(deps.getState).mockReturnValue({ hasArtifacts: true, existingTitle });
    expect(await command.thread!.invoke({ ...context, args: '' }, host)).toEqual({ status: 'ok' });
    expect(deps.prepare).toHaveBeenCalledWith('original-thread', existingTitle ?? 'Design artifact');
    expect(host.report).toHaveBeenCalledWith('Opened design artifact: Pricing');
    expect(deps.send).not.toHaveBeenCalled();
  });

  it.each([undefined, 'Existing title'])('starts create/revise for existing title %s using prepared instructions', async existingTitle => {
    const { command, deps, context, host } = fixture();
    vi.mocked(deps.getState).mockReturnValue({ hasArtifacts: !!existingTitle, existingTitle });
    expect(await command.thread!.invoke(context, host)).toEqual({ status: 'ok' });
    expect(deps.prepare).toHaveBeenCalledWith('original-thread', 'pricing');
    expect(deps.send).toHaveBeenCalledWith('original-thread', 'kickoff instructions');
    expect(host.report).toHaveBeenCalledWith(existingTitle ? 'Revising design artifact…' : 'Design artifact created. Starting design turn…');
  });

  it('returns preparation error without attempting send', async () => {
    const { command, deps, context, host } = fixture();
    vi.mocked(deps.prepare).mockRejectedValue(new Error('storage failed'));
    expect(await command.thread!.invoke(context, host)).toEqual({ status: 'error', message: 'Could not prepare the design artifact: storage failed' });
    expect(deps.send).not.toHaveBeenCalled();
  });

  it('reports asynchronous send failure after successful preparation', async () => {
    const { command, deps, context, host } = fixture();
    vi.mocked(deps.send).mockRejectedValue(new Error('session failed'));
    expect(await command.thread!.invoke(context, host)).toEqual({ status: 'ok' });
    await vi.waitFor(() => expect(host.report).toHaveBeenCalledWith('Failed to start design turn: session failed', true));
  });

  it('does not await completion of the design turn', async () => {
    const { command, deps, context, host } = fixture();
    vi.mocked(deps.send).mockReturnValue(new Promise(() => {}));
    expect(await command.thread!.invoke(context, host)).toEqual({ status: 'ok' });
    expect(deps.send).toHaveBeenCalledOnce();
  });

  it('does nothing for a missing originating thread', async () => {
    const { command, deps, context, host } = fixture();
    vi.mocked(deps.getState).mockReturnValue(null);
    expect(await command.thread!.invoke(context, host)).toEqual({ status: 'ok' });
    expect(deps.prepare).not.toHaveBeenCalled();
  });

  it('does not prepare a command already cancelled', async () => {
    const { command, deps, context, host, controller } = fixture();
    controller.abort();
    expect(await command.thread!.invoke(context, host)).toMatchObject({ status: 'error' });
    expect(deps.prepare).not.toHaveBeenCalled();
  });

  it('does not send or report when cancelled during preparation', async () => {
    const { command, deps, context, host, controller } = fixture();
    vi.mocked(deps.prepare).mockImplementation(async () => {
      controller.abort();
      return { artifact: { title: 'Pricing' }, instructions: 'kickoff' };
    });
    expect(await command.thread!.invoke(context, host)).toMatchObject({ status: 'error' });
    expect(deps.send).not.toHaveBeenCalled();
    expect(host.report).not.toHaveBeenCalled();
  });

  it('requires a dispatch brief before checking attachments', async () => {
    const { command, deps, context, host } = fixture();
    expect(await command.dispatch!.invoke({ ...context, surface: 'dispatch', args: '', hasImages: true }, host)).toEqual({ status: 'error', message: 'Include a brief — e.g. "/design a responsive pricing page for a developer tool"' });
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it.each(['hasImages', 'hasAttachment'] as const)('rejects dispatch with %s', async attachment => {
    const { command, deps, context, host } = fixture();
    expect(await command.dispatch!.invoke({ ...context, surface: 'dispatch', [attachment]: true }, host)).toEqual({ status: 'error', message: 'Design dispatch does not support attachments yet. Remove them and try again.' });
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it.each(['claude', 'codex', undefined] as const)('dispatches preserving harness %s', async agentHarness => {
    const { command, deps, context, host } = fixture();
    expect(await command.dispatch!.invoke({ ...context, surface: 'dispatch', agentHarness }, host)).toEqual({ status: 'ok' });
    expect(deps.dispatch).toHaveBeenCalledWith('pricing', agentHarness);
  });

  it('returns dispatch failure with the existing error prefix', async () => {
    const { command, deps, context, host } = fixture();
    vi.mocked(deps.dispatch).mockRejectedValue('navigation failed');
    expect(await command.dispatch!.invoke({ ...context, surface: 'dispatch' }, host)).toEqual({ status: 'error', message: 'Could not create design artifact: navigation failed' });
  });

  it('does not dispatch when cancelled', async () => {
    const { command, deps, context, host, controller } = fixture();
    controller.abort();
    expect(await command.dispatch!.invoke({ ...context, surface: 'dispatch' }, host)).toMatchObject({ status: 'error' });
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  describe('modes', () => {
    it.each([
      ['wireframe: a billing settings page', 'wireframe', 'a billing settings page'],
      ['States:   the plan-picker card', 'states', 'the plan-picker card'],
    ] as const)('prepares %j with the mode stripped from the brief', async (args, mode, brief) => {
      const { command, deps, context, host } = fixture();
      expect(await command.thread!.invoke({ ...context, args }, host)).toEqual({ status: 'ok' });
      expect(deps.prepare).toHaveBeenCalledWith('original-thread', brief, mode);
      expect(host.report).toHaveBeenCalledWith(`Design artifact created. Starting ${mode} design turn…`);
      await vi.waitFor(() => expect(deps.send).toHaveBeenCalledWith('original-thread', 'kickoff instructions'));
    });

    it('treats a keyword without a colon as a normal brief', async () => {
      const { command, deps, context, host } = fixture();
      await command.thread!.invoke({ ...context, args: 'states of the union dashboard' }, host);
      expect(deps.prepare).toHaveBeenCalledWith('original-thread', 'states of the union dashboard');
    });

    it('runs a bare mode against the existing design using its title', async () => {
      const { command, deps, context, host } = fixture();
      vi.mocked(deps.getState).mockReturnValue({ hasArtifacts: true, existingTitle: 'Billing settings' });
      expect(await command.thread!.invoke({ ...context, args: 'Wireframe:' }, host)).toEqual({ status: 'ok' });
      expect(deps.prepare).toHaveBeenCalledWith('original-thread', 'Billing settings', 'wireframe');
      expect(host.report).toHaveBeenCalledWith('Revising design artifact in wireframe mode…');
      await vi.waitFor(() => expect(deps.send).toHaveBeenCalledWith('original-thread', 'kickoff instructions'));
    });

    it('requires a brief for a bare mode on an empty thread', async () => {
      const { command, deps, context, host } = fixture();
      const result = await command.thread!.invoke({ ...context, args: 'states:' }, host);
      expect(result).toEqual({ status: 'error', message: 'Include a brief after the mode — e.g. /design wireframe: a billing settings page' });
      expect(deps.prepare).not.toHaveBeenCalled();
    });

    it('dispatches with the parsed mode and stripped brief', async () => {
      const { command, deps, context, host } = fixture();
      const result = await command.dispatch!.invoke({ ...context, surface: 'dispatch', args: 'STATES: the plan-picker card', agentHarness: 'codex' }, host);
      expect(result).toEqual({ status: 'ok' });
      expect(deps.dispatch).toHaveBeenCalledWith('the plan-picker card', 'codex', 'states');
    });

    it('dispatches an unknown prefix as part of the brief', async () => {
      const { command, deps, context, host } = fixture();
      await command.dispatch!.invoke({ ...context, surface: 'dispatch', args: 'foo: a billing page' }, host);
      expect(deps.dispatch).toHaveBeenCalledWith('foo: a billing page', undefined);
    });

    it('rejects dispatch of a bare mode', async () => {
      const { command, deps, context, host } = fixture();
      const result = await command.dispatch!.invoke({ ...context, surface: 'dispatch', args: 'wireframe:  ' }, host);
      expect(result).toEqual({ status: 'error', message: 'Include a brief after the mode — e.g. "/design wireframe: a billing settings page"' });
      expect(deps.dispatch).not.toHaveBeenCalled();
    });

    describe('storyboard', () => {
      it('dispatches storyboard with a brief and rejects a bare one', async () => {
        const { command, deps, context, host } = fixture();
        expect(await command.dispatch!.invoke({ ...context, surface: 'dispatch', args: 'storyboard: onboarding flow' }, host)).toEqual({ status: 'ok' });
        expect(deps.dispatch).toHaveBeenCalledWith('onboarding flow', undefined, 'storyboard');
        expect(await command.dispatch!.invoke({ ...context, surface: 'dispatch', args: 'storyboard:' }, host)).toMatchObject({ status: 'error' });
        expect(deps.dispatch).toHaveBeenCalledOnce();
      });

      it('creates a new artifact from a storyboard brief in a thread', async () => {
        const { command, deps, context, host } = fixture();
        await command.thread!.invoke({ ...context, args: 'storyboard: onboarding flow' }, host);
        expect(deps.prepare).toHaveBeenCalledWith('original-thread', 'onboarding flow', 'storyboard');
      });
    });

    describe('variations', () => {
      it('explores directions for the existing design on a bare variations command', async () => {
        const { command, deps, context, host } = fixture();
        vi.mocked(deps.getState).mockReturnValue({ hasArtifacts: true, existingTitle: 'Billing settings' });
        expect(await command.thread!.invoke({ ...context, args: 'variations:' }, host)).toEqual({ status: 'ok' });
        expect(deps.prepare).toHaveBeenCalledWith('original-thread', 'Billing settings', 'variations');
        await vi.waitFor(() => expect(deps.send).toHaveBeenCalledWith('original-thread', 'kickoff instructions'));
      });

      it('requires a brief for bare variations on an empty thread', async () => {
        const { command, deps, context, host } = fixture();
        expect(await command.thread!.invoke({ ...context, args: 'Variations:' }, host)).toMatchObject({ status: 'error', message: expect.stringContaining('Include a brief after the mode') });
        expect(deps.prepare).not.toHaveBeenCalled();
      });

      it('creates a new artifact from a variations brief', async () => {
        const { command, deps, context, host } = fixture();
        await command.thread!.invoke({ ...context, args: 'variations: a pricing page' }, host);
        expect(deps.prepare).toHaveBeenCalledWith('original-thread', 'a pricing page', 'variations');
      });

      it('dispatches variations with a brief and rejects a bare one', async () => {
        const { command, deps, context, host } = fixture();
        expect(await command.dispatch!.invoke({ ...context, surface: 'dispatch', args: 'variations: a pricing page' }, host)).toEqual({ status: 'ok' });
        expect(deps.dispatch).toHaveBeenCalledWith('a pricing page', undefined, 'variations');
        expect(await command.dispatch!.invoke({ ...context, surface: 'dispatch', args: 'variations:' }, host)).toMatchObject({ status: 'error' });
        expect(deps.dispatch).toHaveBeenCalledOnce();
      });
    });

    describe('pick', () => {
      const withDesign = () => {
        const fx = fixture();
        vi.mocked(fx.deps.getState).mockReturnValue({ hasArtifacts: true, existingTitle: 'Billing settings' });
        return fx;
      };

      it.each(['B', 'b', 'B, but use A\'s navigation', 'd: denser', 'A. tighter', 'C - darker'])('prepares pick %j with the letter brief', async brief => {
        const { command, deps, context, host } = withDesign();
        expect(await command.thread!.invoke({ ...context, args: `pick: ${brief}` }, host)).toEqual({ status: 'ok' });
        expect(deps.prepare).toHaveBeenCalledWith('original-thread', brief, 'pick');
        expect(host.report).toHaveBeenCalledWith('Revising design artifact in pick mode…');
        await vi.waitFor(() => expect(deps.send).toHaveBeenCalledWith('original-thread', 'kickoff instructions'));
      });

      it.each(['Bold', 'E', 'the second one', 'AB'])('rejects pick %j without a variation letter', async brief => {
        const { command, deps, context, host } = withDesign();
        expect(await command.thread!.invoke({ ...context, args: `pick: ${brief}` }, host)).toEqual({ status: 'error', message: 'Start with the variation letter — e.g. /design pick: B' });
        expect(deps.prepare).not.toHaveBeenCalled();
      });

      it('requires a letter even when the thread has a design', async () => {
        const { command, deps, context, host } = withDesign();
        expect(await command.thread!.invoke({ ...context, args: 'Pick:  ' }, host)).toEqual({ status: 'error', message: 'Include the variation letter — e.g. /design pick: B' });
        expect(deps.prepare).not.toHaveBeenCalled();
      });

      it('rejects pick before preparing when the thread has no design', async () => {
        const { command, deps, context, host } = fixture();
        const result = await command.thread!.invoke({ ...context, args: 'pick: B' }, host);
        expect(result).toMatchObject({ status: 'error', message: expect.stringContaining('/design variations:') });
        expect(deps.prepare).not.toHaveBeenCalled();
      });

      it('rejects dispatch pick, pointing to variations in an existing thread', async () => {
        const { command, deps, context, host } = fixture();
        const result = await command.dispatch!.invoke({ ...context, surface: 'dispatch', args: 'pick: B' }, host);
        expect(result).toMatchObject({ status: 'error', message: expect.stringContaining('Run /design variations: in an existing design thread first') });
        expect(deps.dispatch).not.toHaveBeenCalled();
      });

      it('rejects an empty dispatch pick with the letter example', async () => {
        const { command, deps, context, host } = fixture();
        expect(await command.dispatch!.invoke({ ...context, surface: 'dispatch', args: 'pick:' }, host)).toEqual({ status: 'error', message: 'Include the variation letter — e.g. /design pick: B' });
        expect(deps.dispatch).not.toHaveBeenCalled();
      });
    });

    describe('spec', () => {
      const withDesign = () => {
        const fx = fixture();
        vi.mocked(fx.deps.getState).mockReturnValue({ hasArtifacts: true, existingTitle: 'Billing settings' });
        return fx;
      };

      it('runs spec against the existing design on a bare spec command', async () => {
        const { command, deps, context, host } = withDesign();
        expect(await command.thread!.invoke({ ...context, args: 'spec:' }, host)).toEqual({ status: 'ok' });
        expect(deps.prepare).toHaveBeenCalledWith('original-thread', 'Billing settings', 'spec');
        expect(host.report).toHaveBeenCalledWith('Revising design artifact in spec mode…');
        await vi.waitFor(() => expect(deps.send).toHaveBeenCalledWith('original-thread', 'kickoff instructions'));
      });

      it('runs spec with a brief against the existing design', async () => {
        const { command, deps, context, host } = withDesign();
        expect(await command.thread!.invoke({ ...context, args: 'spec: the pricing page' }, host)).toEqual({ status: 'ok' });
        expect(deps.prepare).toHaveBeenCalledWith('original-thread', 'the pricing page', 'spec');
      });

      it('rejects bare spec before preparing when the thread has no design', async () => {
        const { command, deps, context, host } = fixture();
        const result = await command.thread!.invoke({ ...context, args: 'spec:' }, host);
        expect(result).toEqual({ status: 'error', message: 'This thread has no design to annotate. Build a design first, then run /design spec: on it.' });
        expect(deps.prepare).not.toHaveBeenCalled();
      });

      it('rejects spec with a brief when the thread has no design', async () => {
        const { command, deps, context, host } = fixture();
        const result = await command.thread!.invoke({ ...context, args: 'spec: the pricing page' }, host);
        expect(result).toEqual({ status: 'error', message: 'This thread has no design to annotate. Build a design first, then run /design spec: on it.' });
        expect(deps.prepare).not.toHaveBeenCalled();
      });

      it('rejects dispatch spec, pointing to building a design first', async () => {
        const { command, deps, context, host } = fixture();
        const result = await command.dispatch!.invoke({ ...context, surface: 'dispatch', args: 'spec: the pricing page' }, host);
        expect(result).toEqual({ status: 'error', message: 'There is nothing to annotate in a new thread. Build a design first, then run /design spec: in that thread.' });
        expect(deps.dispatch).not.toHaveBeenCalled();
      });

      it('rejects a bare dispatch spec the same way', async () => {
        const { command, deps, context, host } = fixture();
        const result = await command.dispatch!.invoke({ ...context, surface: 'dispatch', args: 'spec:' }, host);
        expect(result).toEqual({ status: 'error', message: 'There is nothing to annotate in a new thread. Build a design first, then run /design spec: in that thread.' });
        expect(deps.dispatch).not.toHaveBeenCalled();
      });
    });
  });
});

describe('runtime flag', () => {
  it.each([
    ['pricing page', undefined, 'pricing page'],
    ['--nextjs pricing page', 'nextjs', 'pricing page'],
    ['--static a landing page', 'static', 'a landing page'],
    ['--runtime nextjs a CRM', 'nextjs', 'a CRM'],
    ['--runtime=static a CRM', 'static', 'a CRM'],
    ['--static --nextjs last wins', 'nextjs', 'last wins'],
    ['--nextjs', 'nextjs', ''],
    ['build a page with --nextjs inside', undefined, 'build a page with --nextjs inside'],
    ['--nextjsfoo bar', undefined, '--nextjsfoo bar'],
  ])('parses %j', (args, runtime, brief) => {
    expect(parseDesignArgs(args)).toMatchObject({ runtime, brief });
  });

  it('composes the runtime flag with a mode prefix', () => {
    expect(parseDesignArgs('--nextjs wireframe: a CRM')).toEqual({ runtime: 'nextjs', mode: 'wireframe', brief: 'a CRM' });
    expect(parseDesignArgs('--static storyboard: onboarding')).toEqual({ runtime: 'static', mode: 'storyboard', brief: 'onboarding' });
    expect(parseDesignArgs('wireframe: a CRM')).toEqual({ runtime: undefined, mode: 'wireframe', brief: 'a CRM' });
  });

  it('forwards both mode and runtime to prepare and dispatch', async () => {
    const { command, deps, context, host } = fixture();
    await command.thread!.invoke({ ...context, args: '--nextjs states: a table' }, host);
    expect(deps.prepare).toHaveBeenCalledWith('original-thread', 'a table', 'states', 'nextjs');
    await command.dispatch!.invoke({ ...context, surface: 'dispatch', args: '--nextjs wireframe: a CRM' }, host);
    expect(deps.dispatch).toHaveBeenCalledWith('a CRM', undefined, 'wireframe', 'nextjs');
  });

  it('rejects an unknown runtime', () => {
    expect(parseDesignArgs('--runtime=php x')).toEqual({ error: 'Unknown runtime "php". Use --nextjs or --static.' });
  });

  it('prepares a thread design with the chosen runtime', async () => {
    const { command, deps, context, host } = fixture();
    expect(await command.thread!.invoke({ ...context, args: '--nextjs a CRM' }, host)).toEqual({ status: 'ok' });
    expect(deps.prepare).toHaveBeenCalledWith('original-thread', 'a CRM', undefined, 'nextjs');
  });

  it('requires a brief even when only the flag is given and no artifact exists', async () => {
    const { command, deps, context, host } = fixture();
    expect(await command.thread!.invoke({ ...context, args: '--nextjs' }, host)).toMatchObject({ status: 'error', message: expect.stringContaining('Include a brief') });
    expect(deps.prepare).not.toHaveBeenCalled();
  });

  it('reports an unknown runtime as an error without preparing', async () => {
    const { command, deps, context, host } = fixture();
    expect(await command.thread!.invoke({ ...context, args: '--runtime=php x' }, host)).toMatchObject({ status: 'error', message: expect.stringContaining('Unknown runtime') });
    expect(deps.prepare).not.toHaveBeenCalled();
  });

  it('dispatches with the chosen runtime and harness', async () => {
    const { command, deps, context, host } = fixture();
    expect(await command.dispatch!.invoke({ ...context, surface: 'dispatch', args: '--nextjs a CRM', agentHarness: 'codex' }, host)).toEqual({ status: 'ok' });
    expect(deps.dispatch).toHaveBeenCalledWith('a CRM', 'codex', undefined, 'nextjs');
  });

  it('requires a dispatch brief after stripping flags', async () => {
    const { command, deps, context, host } = fixture();
    expect(await command.dispatch!.invoke({ ...context, surface: 'dispatch', args: '--nextjs' }, host)).toMatchObject({ status: 'error' });
    expect(deps.dispatch).not.toHaveBeenCalled();
  });
});
