import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { FactoryStateAdapter } from '../../server/src/adapters/factoryState.ts';
import { resolveFactoryRuntimePin } from '../../server/src/lib/factoryRuntimePins.ts';
import factoryModule from '../../server/src/modules/factory/index.ts';
import authPlugin from '../../server/src/plugins/auth.ts';
import { settingsFixture, sourceRoot } from './stageRunnerSettingsFixture.mjs';

const require = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = require('fastify');
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

/**
 * Соединяет Fastify с настоящим CLI закреплённого source-runtime A.
 * Wrapper A задаёт исключительно временные адаптеры, а B оставлен отличимым и не вызывается.
 */
export async function settingsServer(t) {
  const fx = await settingsFixture(t);
  const pinnedDir = path.join(fx.root, 'pinned A with spaces');
  const bin = path.join(pinnedDir, 'factory');
  const calls = path.join(fx.root, 'engine-calls.jsonl');
  const cacheDir = path.join(fx.root, 'cache');

  await mkdir(pinnedDir);
  await mkdir(cacheDir, { mode: 0o700 });
  await writeFile(bin, [
    '#!/usr/bin/env bash',
    `export FACTORY_RUNNERS_DIR=${quote(fx.env.FACTORY_RUNNERS_DIR)}`,
    `export TEST_ROOT=${quote(fx.root)}`,
    'export FACTORY_TESTING=1 FACTORY_FORBID_LIVE=1',
    `${quote(process.execPath)} -e 'require("node:fs").appendFileSync(process.argv[1],`,
    `  JSON.stringify(process.argv.slice(2))+"\\n")' ${quote(calls)} "$@"`,
    `exec ${quote(path.join(sourceRoot, 'engine/bin/factory'))} "$@"`,
  ].join('\n'), { mode: 0o700 });

  const pin = await resolveFactoryRuntimePin({
    controlRoot: fx.env.FACTORY_CONTROL_ROOT,
    stateRoot: fx.env.STATE_DIR,
    profileRoot: fx.env.FACTORY_PROFILES_DIR,
    cacheDir,
    ...fx.identity,
    current: {
      packageId: null,
      runtimeRoot: sourceRoot,
      engineHome: path.join(sourceRoot, 'engine'),
      engineBin: bin,
      node: process.execPath,
    },
  });

  assert.equal(pin.engineBin, bin, 'fixture закрепляет A каноническим API pin, а не подделкой authority');

  const config = {
    rootDir: sourceRoot,
    dataHome: path.join(fx.root, 'data'),
    factoryHome: path.join(sourceRoot, 'engine'),
    factoryBin: '/current-B-must-not-run/factory',
    factoryConfigRoot: fx.env.FACTORY_CONFIG_ROOT,
    factoryControlDir: fx.env.FACTORY_CONTROL_ROOT,
    routesDir: path.join(fx.root, 'routes'),
    ticketsDir: path.join(fx.root, 'tickets'),
    stateDir: fx.env.STATE_DIR,
    profilesDir: fx.env.FACTORY_PROFILES_DIR,
    factoryProfile: fx.identity.profile,
    sandboxDownCmd: '',
    runtime: { ...pin, cacheDir },
  };
  const adapter = new FactoryStateAdapter({
    stateDir: config.stateDir,
    routesDir: config.routesDir,
    profilesDir: config.profilesDir,
    controlDir: config.factoryControlDir,
  });
  const graph = {
    daemonAlive: false,
    nodes: { plan: ['agent', 'План', ''], ship: ['agent', 'Публикация', ''] },
    keys: { plan: 'PLAN', ship: 'SHIP' },
    runnerKeys: { plan: 'PLAN', ship: 'SHIP' },
    statuses: { plan: 'pending', ship: 'pending' },
    nodeMeta: { plan: { runner: {
      stage: 'PLAN',
      primary: 'alpha',
      actual: null,
      chain: ['alpha', 'beta'],
      attempts: [],
    } } },
  };

  adapter.getTaskGraph = async () => graph;
  await adapter.readTrustedAttempt('81');

  const app = Fastify({ logger: false });

  await app.register(authPlugin, { authStore: { isValidSession: (sid) => sid === 'fixture' } });
  await app.register(factoryModule, {
    factoryState: adapter,
    config,
    prefs: { read: () => ({}) },
    tracker: null,
    analyzer: { readClarifications: async () => null, readOpenQuestions: async () => null },
  });
  await app.ready();
  t.after(() => app.close());

  return {
    ...fx,
    app,
    graph,
    config,
    get(provider = 'alpha', identity = fx.identity, authenticated = true) {
      const query = new URLSearchParams({
        profile: identity.profile,
        attempt: identity.attempt,
        node: identity.node,
        stage: identity.stage,
        provider,
      });

      return app.inject({
        url: `/api/tasks/${identity.task}/runner/options?${query}`,
        headers: authenticated ? { cookie: 'grigdesk_sid=fixture' } : {},
      });
    },
    post(payload, authenticated = true) {
      return app.inject({
        method: 'POST',
        url: '/api/tasks/81/runner/settings',
        payload,
        headers: authenticated ? { cookie: 'grigdesk_sid=fixture' } : {},
      });
    },
    async engineCalls() {
      const content = await readFile(calls, 'utf8').catch(() => '');

      return content.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    },
  };
}

/**
 * Проверяет именно успешный HTTP-контракт, сохраняя тело отказа в коротком assert.
 * Наличие fixture и pinned runtime подтверждено до запроса; 404 означает отсутствующий API.
 */
export function httpJson(response, expectedStatus = 200) {
  assert.equal(response.statusCode, expectedStatus, response.body);

  return response.json();
}
