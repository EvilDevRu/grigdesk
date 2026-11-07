import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import {
  FactoryDebugSettings,
  FactoryDebugInputError,
  parseFactoryDebugView,
} from '../../server/src/lib/factoryDebug.ts';
import settingsModule from '../../server/src/modules/settings/index.ts';

const requireFromServer = createRequire(
  new URL('../../server/package.json', import.meta.url),
);
const Fastify = requireFromServer('fastify');

const SHOW = [
  'scope: global',
  'configured: decisions',
  'configured_expires_at: 0',
  'effective: decisions',
  'source: global',
  'expires_at: 0',
  '',
].join('\n');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('factory debug adapter parses the engine view and pins state/config roots', async () => {
  const calls = [];
  const adapter = new FactoryDebugSettings({
    factoryBin: '/factory/bin/factory',
    stateDir: '/factory/state',
    configRoot: '/factory/config',
    profilesDir: '/repo/profiles',
    run: async (file, args, options) => {
      calls.push({ file, args, options });
      return { stdout: SHOW, stderr: '' };
    },
  });

  const oldKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'provider-secret-canary';
  let view;
  try {
    view = await adapter.show({ scope: 'global' });
  } finally {
    if (oldKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = oldKey;
  }
  assert.deepEqual(view, {
    scope: 'global',
    configured: 'decisions',
    configuredExpiresAt: 0,
    effective: 'decisions',
    source: 'global',
    expiresAt: 0,
  });
  assert.deepEqual(calls[0].args, ['settings', 'debug', 'show']);
  assert.equal(calls[0].options.env.FACTORY_STATE, '/factory/state');
  assert.equal(calls[0].options.env.STATE_DIR, '/factory/state');
  assert.equal(calls[0].options.env.FACTORY_CONFIG_ROOT, '/factory/config');
  assert.equal(calls[0].options.env.FACTORY_PROFILES_DIR, '/repo/profiles');
  assert.equal(calls[0].options.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(calls[0].options.shell, false);
});

test('factory debug adapter builds only allowlisted argv', async () => {
  const calls = [];
  const adapter = new FactoryDebugSettings({
    factoryBin: '/factory/bin/factory',
    stateDir: '/factory/state',
    configRoot: '/factory/config',
    run: async (_file, args) => {
      calls.push(args);
      return { stdout: SHOW, stderr: '' };
    },
  });

  await adapter.set({ scope: 'profile', profile: 'project-alpha', level: 'errors' });
  await adapter.set({ scope: 'task', task: '8126', level: 'verbose', duration: '2h' });
  await adapter.clear({ scope: 'profile', profile: 'project-alpha' });

  assert.deepEqual(calls, [
    ['profile', 'project-alpha', 'debug', 'set', 'errors'],
    ['8126', 'debug', 'set', 'verbose', '--for', '2h'],
    ['profile', 'project-alpha', 'debug', 'clear'],
  ]);
});

test('factory debug adapter conforms to the real engine CLI without model calls', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-factory-debug.'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'state');
  const configRoot = path.join(root, 'config');
  await mkdir(stateDir, { recursive: true });
  const adapter = new FactoryDebugSettings({
    factoryBin: path.join(repoRoot, 'engine', 'bin', 'factory'),
    stateDir,
    configRoot,
  });

  assert.equal((await adapter.show({ scope: 'global' })).effective, 'off');
  const enabled = await adapter.set({ scope: 'global', level: 'decisions' });
  assert.equal(enabled.effective, 'decisions');
  assert.equal(enabled.source, 'global');
  const disabled = await adapter.set({ scope: 'global', level: 'off' });
  assert.equal(disabled.effective, 'off');
});

test('factory debug adapter rejects shell/path injection before spawn', async () => {
  let calls = 0;
  const adapter = new FactoryDebugSettings({
    factoryBin: '/factory/bin/factory',
    stateDir: '/factory/state',
    configRoot: '/factory/config',
    run: async () => { calls += 1; return { stdout: SHOW, stderr: '' }; },
  });

  await assert.rejects(
    adapter.set({ scope: 'profile', profile: '../escape', level: 'verbose' }),
    FactoryDebugInputError,
  );
  await assert.rejects(
    adapter.set({ scope: 'task', task: '7;touch-pwned', level: 'verbose' }),
    FactoryDebugInputError,
  );
  await assert.rejects(
    adapter.set({ scope: 'global', level: 'secret' }),
    FactoryDebugInputError,
  );
  await assert.rejects(
    adapter.set({ scope: 'global', level: 'verbose', duration: '2h;shutdown' }),
    FactoryDebugInputError,
  );
  await assert.rejects(
    adapter.set({ scope: 'global', level: 'verbose', duration: '999999999d' }),
    FactoryDebugInputError,
  );
  assert.equal(calls, 0);
});

test('factory debug parser fails closed on malformed CLI output', () => {
  assert.throws(() => parseFactoryDebugView('effective: verbose\n'), /Некорректный ответ/);
  assert.throws(() => parseFactoryDebugView(SHOW.replace('expires_at: 0', 'expires_at: 08')), /Некорректный ответ/);
  assert.throws(() => parseFactoryDebugView(SHOW.replace('effective: decisions', 'effective: inherit')), /Некорректный ответ/);
});

test('settings API exposes global debug level and maps invalid input to 400', async () => {
  const calls = [];
  const broadcasts = [];
  const factoryDebug = {
    show: async (input) => { calls.push(['show', input]); return parseFactoryDebugView(SHOW); },
    set: async (input) => { calls.push(['set', input]); return parseFactoryDebugView(SHOW); },
    clear: async (input) => { calls.push(['clear', input]); return parseFactoryDebugView(SHOW); },
  };
  const app = Fastify({ logger: false });
  app.decorate('sse', { broadcast: (name) => broadcasts.push(name) });
  await app.register(settingsModule, {
    prefs: { read: () => ({}), write: () => ({}) },
    factoryDebug,
  });

  const get = await app.inject({ method: 'GET', url: '/api/settings/factory-debug?scope=global' });
  assert.equal(get.statusCode, 200);
  assert.equal(get.json().effective, 'decisions');

  const post = await app.inject({
    method: 'POST',
    url: '/api/settings/factory-debug',
    payload: { scope: 'global', level: 'off' },
  });
  assert.equal(post.statusCode, 200);
  assert.deepEqual(calls.at(-1), ['set', {
    scope: 'global', profile: undefined, task: undefined, level: 'off', duration: undefined,
  }]);
  assert.deepEqual(broadcasts, ['diagnostic-logging']);

  factoryDebug.set = async () => { throw new FactoryDebugInputError('bad level'); };
  const bad = await app.inject({
    method: 'POST',
    url: '/api/settings/factory-debug',
    payload: { scope: 'global', level: 'invalid' },
  });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error, 'bad_debug_setting');
  assert.deepEqual(broadcasts, ['diagnostic-logging']);
  await app.close();
});
