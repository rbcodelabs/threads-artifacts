import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDesignManifest } from '../src/designArtifact';
import { createPluginDataGuard } from '../src/commentKey';
import { negotiateContractVersion, registerElementFeedback, supportsArtifactFeedback } from '../src/elementFeedbackRegistration';
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

// ---------------------------------------------------------------------------------------------
// Contract v2 negotiation (design 1.1, threat T12)
// ---------------------------------------------------------------------------------------------

function negotiatingGeode(versions: readonly number[], statuses: readonly string[] = ['registered']) {
  const calls: { handler: any; status: string; disposed: number }[] = [];
  const plugin = {
    registerArtifactFeedbackHandler(handler: any) {
      const status = statuses[Math.min(calls.length, statuses.length - 1)];
      const call = { handler, status, disposed: 0 };
      calls.push(call);
      return { status, message: `status ${status}`, dispose: () => { call.disposed++; } };
    },
  };
  return { plugin, app: { artifactFeedback: { contractVersions: versions } }, calls };
}

function guardFor(initial: Record<string, unknown> = {}) {
  const data: { value: unknown; loads: number; saves: number } = { value: initial, loads: 0, saves: 0 };
  const guard = createPluginDataGuard({
    loadData: async () => { data.loads++; return structuredClone(data.value); },
    saveData: async (next: unknown) => { data.saves++; data.value = structuredClone(next); },
  });
  return { guard, data };
}

describe('negotiateContractVersion', () => {
  it('picks 2 only when the registry lists 2 and the method exists, else 1, else null', () => {
    const g = negotiatingGeode([1, 2]);
    expect(negotiateContractVersion(g.plugin, g.app)).toBe(2);
    expect(negotiateContractVersion(g.plugin, { artifactFeedback: { contractVersions: [1] } })).toBe(1);
    expect(negotiateContractVersion(g.plugin, { artifactFeedback: { contractVersions: [2] } })).toBe(2);
    expect(negotiateContractVersion({}, g.app)).toBeNull();
    expect(negotiateContractVersion(g.plugin, {})).toBeNull();
    expect(negotiateContractVersion(g.plugin, { artifactFeedback: { contractVersions: [3] } })).toBeNull();
    expect(negotiateContractVersion(g.plugin, { artifactFeedback: { contractVersions: 'x' } })).toBeNull();
    expect(negotiateContractVersion(null, undefined)).toBeNull();
  });
});

describe('registerElementFeedback negotiation matrix', () => {
  let base: string;
  beforeEach(async () => { base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'td-neg-'))); });
  afterEach(async () => { await fs.rm(base, { recursive: true, force: true }); });

  const makeRoot = async () => {
    const root = path.join(base, '.geode', 'artifacts', 'design-t1');
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, 'artifact.json'), JSON.stringify(buildDesignManifest('t1', 'Landing')));
    return root;
  };
  const opts = (geode: { plugin: unknown; app: unknown }, extra: Record<string, unknown> = {}): any => ({
    plugin: geode.plugin, app: geode.app, api: createFakeApi().api, basePath: base, notify: vi.fn(), log: log(), secret: 's', clock: createFakeClock(), ...extra,
  });

  it('Geode [1,2] with install keys registers one v2 handler that still implements v1 submit and canHandle', () => {
    const geode = negotiatingGeode([1, 2]);
    const { guard } = guardFor();
    const disposable = registerElementFeedback(opts(geode, { installKeys: guard }))!;
    expect(disposable).not.toBeNull();
    expect(geode.calls).toHaveLength(1);
    const handler = geode.calls[0].handler;
    expect(handler.contractVersion).toBe(2);
    expect(typeof handler.submit).toBe('function');
    expect(typeof handler.canHandle).toBe('function');
    for (const method of ['list', 'get', 'save', 'update', 'remove', 'adopt', 'subscribe', 'sendBatch']) expect(typeof handler.comments[method]).toBe('function');
    expect(handler.comments.capabilities).toEqual({ pins: true, batchSend: true, textEdit: false });
    disposable.dispose();
    expect(geode.calls[0].disposed).toBe(1);
  });

  it('Geode [1] registers the v1 shape: no comments provider, never touches plugin data or comments.json', async () => {
    const root = await makeRoot();
    const geode = negotiatingGeode([1]);
    const { guard, data } = guardFor();
    const disposable = registerElementFeedback(opts(geode, { installKeys: guard }))!;
    expect(geode.calls[0].handler.contractVersion).toBe(1);
    expect(geode.calls[0].handler.comments).toBeUndefined();
    disposable.dispose();
    expect(data.loads + data.saves).toBe(0);
    expect(fsSync.existsSync(path.join(root, '.threads-design', 'comments.json'))).toBe(false);
  });

  it('Geode [1,2] but no install keys available falls back to v1 (cannot sign pins)', () => {
    const geode = negotiatingGeode([1, 2]);
    registerElementFeedback(opts(geode));
    expect(geode.calls[0].handler.contractVersion).toBe(1);
  });

  it('unsupported-version race: the v2 registration is disposed and v1 is registered once; comments.json untouched (T12)', async () => {
    const root = await makeRoot();
    const geode = negotiatingGeode([1, 2], ['unsupported-version', 'registered']);
    const { guard, data } = guardFor();
    const o = opts(geode, { installKeys: guard });
    const disposable = registerElementFeedback(o)!;
    expect(disposable).not.toBeNull();
    expect(geode.calls.map(c => c.handler.contractVersion)).toEqual([2, 1]);
    expect(geode.calls[0].disposed).toBe(1);
    // The rejected v2 handler must be inert even if something calls it after the failed registration.
    const dead = geode.calls[0].handler;
    const target = { root, artifactId: 'design-t1', title: 'x', runtime: 'static', vaultRead: false };
    expect(await dead.comments.list(target, { signal: new AbortController().signal })).toMatchObject({ status: 'rejected', reason: 'unavailable' });
    expect(await dead.comments.save(target, { request: validRequest() }, { signal: new AbortController().signal })).toMatchObject({ status: 'rejected', reason: 'unavailable' });
    expect(o.log.warn).toHaveBeenCalled();
    expect(data.loads + data.saves).toBe(0);
    expect(fsSync.existsSync(path.join(root, '.threads-design'))).toBe(false);
    disposable.dispose();
    expect(geode.calls[1].disposed).toBe(1);
  });

  it('retries v1 only once, and only for unsupported-version', () => {
    const both = negotiatingGeode([1, 2], ['unsupported-version', 'unsupported-version']);
    const { guard } = guardFor();
    expect(registerElementFeedback(opts(both, { installKeys: guard }))).toBeNull();
    expect(both.calls).toHaveLength(2);
    const conflict = negotiatingGeode([1, 2], ['conflict', 'registered']);
    expect(registerElementFeedback(opts(conflict, { installKeys: guard }))).toBeNull();
    expect(conflict.calls).toHaveLength(1);
  });

  it('a throwing v2 registration is not retried (the host is broken, not old)', () => {
    const geode = negotiatingGeode([1, 2]);
    let attempts = 0;
    geode.plugin.registerArtifactFeedbackHandler = () => { attempts++; throw new Error('inactive generation'); };
    const { guard } = guardFor();
    expect(registerElementFeedback(opts(geode, { installKeys: guard }))).toBeNull();
    expect(attempts).toBe(1);
  });

  it('registering v2 does not read or write plugin data or comments.json until a provider call happens', async () => {
    const root = await makeRoot();
    const geode = negotiatingGeode([1, 2]);
    const { guard, data } = guardFor();
    const disposable = registerElementFeedback(opts(geode, { installKeys: guard }))!;
    await new Promise(resolve => setImmediate(resolve));
    expect(data.loads + data.saves).toBe(0);
    expect(fsSync.existsSync(path.join(root, '.threads-design'))).toBe(false);
    disposable.dispose();
  });

  it('end to end: a registered v2 handler saves and lists a pin through the provider', async () => {
    const root = await makeRoot();
    const fake = createFakeApi();
    fake.addThread('t1', { artifacts: [{ providerId: 'agent-threads.design', kind: 'design-static', schemaVersion: 2, id: 'design-t1', title: 'Landing', data: {}, storageRoot: root }] });
    const geode = negotiatingGeode([1, 2]);
    const { guard, data } = guardFor({ someSetting: 1 });
    const disposable = registerElementFeedback(opts(geode, { api: fake.api, installKeys: guard, now: () => Date.parse('2026-11-08T20:01:00.000Z') }))!;
    const handler = geode.calls[0].handler;
    const target = { root, artifactId: 'design-t1', title: 'Landing', runtime: 'static', vaultRead: false };
    const req = validRequest() as any;
    req.artifact.root = root;
    const saved = await handler.comments.save(target, { request: req }, { signal: new AbortController().signal });
    expect(saved).toMatchObject({ status: 'ok', value: { created: true, comment: { status: 'open' } } });
    const listed = await handler.comments.list(target, { signal: new AbortController().signal });
    expect(listed.value.comments).toHaveLength(1);
    // The install key was created through the guard and the user's other plugin data survived.
    expect((data.value as any).someSetting).toBe(1);
    expect((data.value as any).commentsInstallKey).toBeDefined();
    disposable.dispose();
    // After dispose the provider is inert.
    expect(await handler.comments.list(target, { signal: new AbortController().signal })).toMatchObject({ status: 'rejected', reason: 'unavailable' });
  });
});
