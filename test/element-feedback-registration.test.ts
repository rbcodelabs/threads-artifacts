import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDesignManifest } from '../src/designArtifact';
import { registerElementFeedback, supportsArtifactFeedback } from '../src/elementFeedbackRegistration';
import type { ArtifactFeedbackHandler } from '../src/geodeArtifactFeedback';
import { createFakeApi } from './helpers/fakeApi';
import { createFakeClock } from './helpers/fakeClock';
import { validRequest } from './helpers/feedbackFixtures';

const log = () => ({ info: vi.fn(), warn: vi.fn() });

function fakeGeode(status: string = 'registered', versions: readonly number[] | undefined = [1]) {
  const state = { handler: null as ArtifactFeedbackHandler | null, disposed: 0, boundThis: null as unknown };
  const plugin = {
    registerArtifactFeedbackHandler(this: unknown, handler: ArtifactFeedbackHandler) {
      state.boundThis = this;
      state.handler = handler;
      return { status, message: `status ${status}`, dispose: () => { state.disposed++; } };
    },
  };
  const app = versions === undefined ? {} : { artifactFeedback: { contractVersions: versions } };
  return { state, plugin, app };
}

describe('supportsArtifactFeedback', () => {
  it('requires both the plugin method and contract version 1 in the registry', () => {
    const geode = fakeGeode();
    expect(supportsArtifactFeedback(geode.plugin, geode.app)).toBe(true);
    expect(supportsArtifactFeedback({}, geode.app)).toBe(false);
    expect(supportsArtifactFeedback(geode.plugin, {})).toBe(false);
    expect(supportsArtifactFeedback(geode.plugin, { artifactFeedback: { contractVersions: [] } })).toBe(false);
    expect(supportsArtifactFeedback(geode.plugin, { artifactFeedback: { contractVersions: [2] } })).toBe(false);
    expect(supportsArtifactFeedback(geode.plugin, { artifactFeedback: { contractVersions: 'x' } })).toBe(false);
    expect(supportsArtifactFeedback(null, undefined)).toBe(false);
  });
});

describe('registerElementFeedback', () => {
  let base: string;
  beforeEach(async () => { base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'td-reg-'))); });
  afterEach(async () => { await fs.rm(base, { recursive: true, force: true }); });

  const options = (geode: ReturnType<typeof fakeGeode>, fake = createFakeApi(), extra: Record<string, unknown> = {}): any => ({
    plugin: geode.plugin, app: geode.app, api: fake.api, basePath: base, notify: vi.fn(), log: log(), secret: 's', clock: createFakeClock(), ...extra,
  });

  it('is a silent no-op on Geode builds without the feature (method absent, registry absent, old versions)', () => {
    for (const geode of [{ plugin: {}, app: {} }, { plugin: fakeGeode().plugin, app: {} }, { plugin: fakeGeode().plugin, app: { artifactFeedback: { contractVersions: [] } } }]) {
      const opts = { plugin: geode.plugin, app: geode.app, api: createFakeApi().api, basePath: base, notify: vi.fn(), log: log() };
      expect(registerElementFeedback(opts)).toBeNull();
      expect(opts.log.warn).not.toHaveBeenCalled();
      expect(opts.notify).not.toHaveBeenCalled();
    }
  });

  it('registers one handler with the plugin as `this` and disposes the registration', () => {
    const geode = fakeGeode();
    const opts = options(geode);
    const disposable = registerElementFeedback(opts)!;
    expect(disposable).not.toBeNull();
    expect(geode.state.handler?.contractVersion).toBe(1);
    expect(geode.state.boundThis).toBe(geode.plugin);
    disposable.dispose();
    expect(geode.state.disposed).toBe(1);
  });

  it.each(['conflict', 'unsupported-version', 'invalid', 'unavailable'])('stays quiet-but-logged when registration returns %s', status => {
    const geode = fakeGeode(status);
    const opts = options(geode);
    expect(registerElementFeedback(opts)).toBeNull();
    expect(opts.log.warn).toHaveBeenCalledOnce();
    expect(opts.notify).not.toHaveBeenCalled();
  });

  it('survives a throwing registration', () => {
    const geode = fakeGeode();
    geode.plugin.registerArtifactFeedbackHandler = () => { throw new Error('inactive generation'); };
    const opts = options(geode);
    expect(registerElementFeedback(opts)).toBeNull();
    expect(opts.log.warn).toHaveBeenCalledOnce();
  });

  it('does not register without a vault base path (no host storage to map)', () => {
    const geode = fakeGeode();
    expect(registerElementFeedback(options(geode, createFakeApi(), { basePath: undefined }))).toBeNull();
    expect(geode.state.handler).toBeNull();
  });

  it('end to end: the registered handler delivers a comment and queued sends are cancelled on dispose', async () => {
    const root = path.join(base, '.geode', 'artifacts', 'design-t1');
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, 'artifact.json'), JSON.stringify(buildDesignManifest('t1', 'Landing')));
    const fake = createFakeApi();
    fake.addThread('t1', { artifacts: [{ providerId: 'agent-threads.design', kind: 'design-static', schemaVersion: 2, id: 'design-t1', title: 'Landing', data: {}, storageRoot: root }] });
    const geode = fakeGeode();
    const opts = options(geode, fake);
    const disposable = registerElementFeedback(opts)!;
    const req = validRequest() as any;
    req.artifact.root = root;
    expect(await geode.state.handler!.submit(req, { signal: new AbortController().signal })).toMatchObject({ status: 'accepted' });
    expect(fake.sends).toHaveLength(1);

    fake.threads.get('t1')!.isRunning = true;
    const second = validRequest() as any;
    second.artifact.root = root;
    second.selection.selectionId = 'sel_fedcba9876543210fedcba9876543210';
    expect(await geode.state.handler!.submit(second, { signal: new AbortController().signal })).toMatchObject({ status: 'accepted', message: expect.stringContaining('Queued') });
    expect(fake.listenerCount).toBe(1);
    disposable.dispose();
    expect(fake.listenerCount).toBe(0);
    expect(opts.notify).toHaveBeenCalledWith(expect.stringMatching(/queued comment.*reloaded/i), true);
  });

  it('still disposes the coordinator when the registration throws on dispose (A12)', async () => {
    const root = path.join(base, '.geode', 'artifacts', 'design-t1');
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, 'artifact.json'), JSON.stringify(buildDesignManifest('t1', 'Landing')));
    const fake = createFakeApi();
    fake.addThread('t1', { isRunning: true, artifacts: [{ providerId: 'agent-threads.design', kind: 'design-static', schemaVersion: 2, id: 'design-t1', title: 'Landing', data: {}, storageRoot: root }] });
    const geode = fakeGeode();
    const original = geode.plugin.registerArtifactFeedbackHandler;
    geode.plugin.registerArtifactFeedbackHandler = function (this: unknown, handler: ArtifactFeedbackHandler) {
      const registration = original.call(this, handler);
      return { ...registration, dispose: () => { throw new Error('boom'); } } as never;
    };
    const disposable = registerElementFeedback(options(geode, fake))!;
    const req = validRequest() as any;
    req.artifact.root = root;
    await geode.state.handler!.submit(req, { signal: new AbortController().signal });
    expect(fake.listenerCount).toBe(1);
    expect(() => disposable.dispose()).not.toThrow();
    expect(fake.listenerCount).toBe(0);
  });

  it('reads the configured escalation keyword defensively', () => {
    const geode = fakeGeode();
    const opts = options(geode, createFakeApi(), { readEscalationKeyword: () => { throw new Error('no settings'); } });
    expect(registerElementFeedback(opts)).not.toBeNull();
  });
});
