// Модалка запуска получает профили с опубликованным каталогом и может перечитать опции
// выбранного профиля. Выбранный fail-closed профиль остаётся видимым для объяснения
// ошибки; имя из query нельзя использовать как произвольный путь.
import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import factoryModule from '../../server/src/modules/factory/index.js';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-launch-profiles-'));
  const profilesDir = path.join(root, 'profiles');
  await Promise.all([
    mkdir(path.join(profilesDir, 'arsenkin'), { recursive: true }),
    mkdir(path.join(profilesDir, 'rdesigner'), { recursive: true }),
  ]);
  await writeFile(path.join(profilesDir, 'arsenkin', 'graph.json'), JSON.stringify({
    capabilities: [],
    default_route: 'feature',
    routes: { feature: { pos: { build: [0, 0] }, edges: [] } },
  }));
  await writeFile(path.join(profilesDir, 'rdesigner', 'graph.json'), JSON.stringify({
    capabilities: [],
    default_route: 'feature',
    routes: { feature: { pos: { build: [0, 0] }, edges: [] } },
  }));
  await writeFile(path.join(profilesDir, 'rdesigner', 'profile.sh'), `
PROFILE_TRIAGE_REPOS="app:/srv/rdesigner"
profile_repositories() { printf 'rdesigner\\t/srv/rdesigner\\t/srv/rdesigner\\n'; }
profile_delivery_targets() { printf 'rdesigner\\tmaster\\n'; }
`);
  const factoryBin = path.join(root, 'factory');
  await writeFile(factoryBin, `#!/bin/sh
if [ "$1" = check ]; then
  echo "OK profile=rdesigner catalog=${'b'.repeat(64)} route=feature delivery=publish"
  exit 0
fi
exit 99
`);
  await chmod(factoryBin, 0o700);

  const app = Fastify({ logger: false });
  await app.register(factoryModule, {
    factoryState: {
      discoverProfiles() { return ['arsenkin', 'rdesigner']; },
      async primaryProfile() { return 'arsenkin'; },
      async readRegistry() { throw new Error('задача ещё не запускалась'); },
      isDaemonAlive() { return false; },
      async catalog(profile) {
        return profile === 'rdesigner'
          ? {
            routes: ['debug', 'feature'],
            catalogHash: 'b'.repeat(64),
            routeOptions: {
              debug: { deliveryMode: 'publish', instrumentationRequired: true },
              feature: { deliveryMode: 'publish', instrumentationRequired: false },
            },
          }
          : null;
      },
    },
    config: {
      factoryHome: root,
      factoryBin,
      factoryConfigRoot: path.join(root, 'config'),
      factoryControlDir: path.join(root, 'control'),
      routesDir: path.join(root, 'routes'),
      ticketsDir: path.join(root, 'tickets'),
      stateDir: path.join(root, 'state'),
      profilesDir,
      factoryProfile: '',
    },
    prefs: { read: () => ({}) },
    b24: null,
    analyzer: {
      readClarifications: async () => null,
      readOpenQuestions: async () => null,
      async get() {
        return {
          analysis: {
            route_guess: 'debug',
            areas: ['data-migration'],
            files: ['app:webapp/pipeline.py'],
            title: 'Экспорт удваивает сущности',
          },
        };
      },
    },
  });
  await app.ready();
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  return app;
}

test('launch-options отдаёт профили и fail-closed каталог выбранного', async (t) => {
  const app = await fixture(t);

  const defaults = await app.inject({
    method: 'GET',
    url: '/api/tasks/9123/launch-options',
  });
  assert.equal(defaults.statusCode, 200);
  assert.equal(defaults.json().profile, 'arsenkin');
  assert.equal(defaults.json().error, 'no_catalog');
  assert.equal('generation' in defaults.json(), false);
  assert.deepEqual(defaults.json().profiles, ['arsenkin', 'rdesigner']);

  const selected = await app.inject({
    method: 'GET',
    url: '/api/tasks/9123/launch-options?profile=rdesigner',
  });
  assert.equal(selected.statusCode, 200);
  assert.equal(selected.json().profile, 'rdesigner');
  assert.deepEqual(selected.json().profiles, ['rdesigner']);
  assert.equal('generation' in selected.json(), false);
  assert.deepEqual(selected.json().routes, ['debug', 'feature']);
  assert.equal(selected.json().defaultRoute, 'debug');
  assert.deepEqual(selected.json().repositories, [{ name: 'rdesigner', targetBranch: 'master' }]);
  assert.deepEqual(selected.json().instrumentationSuggestions, ['rdesigner:webapp/pipeline.py']);
  assert.deepEqual(selected.json().diagnosisSuggestion, {
    kind: 'data', signal: 'Экспорт удваивает сущности',
  });
  assert.deepEqual(selected.json().routeOptions.debug, {
    deliveryMode: 'publish', instrumentationRequired: true,
  });
});

test('launch профиля без каталога отказывает до запуска factoryBin', async (t) => {
  const app = await fixture(t);
  const response = await app.inject({
    method: 'POST',
    url: '/api/tasks/9123/launch',
    payload: {
      profile: 'arsenkin',
      route: 'feature',
      title: 'Проверка fail closed',
      description: 'Движок не должен запускаться без опубликованного каталога.',
      sourceUrl: 'https://example.test/tasks/9123',
      acceptanceCriteria: [],
    },
  });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error, 'no_catalog');
});

test('launch не принимает старую строковую форму ticket', async (t) => {
  const app = await fixture(t);
  const response = await app.inject({
    method: 'POST',
    url: '/api/tasks/9123/launch',
    payload: { profile: 'rdesigner', route: 'feature', ticket: 'старый payload' },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, 'bad_ticket_shape');
});

test('launch отклоняет подмену настроенной ветки до ticket и provisioning', async (t) => {
  const app = await fixture(t);
  const response = await app.inject({
    method: 'POST',
    url: '/api/tasks/9123/launch',
    payload: {
      profile: 'rdesigner',
      route: 'feature',
      title: 'Проверка ветки',
      description: 'Браузер не должен менять целевую ветку профиля.',
      sourceUrl: 'https://example.test/tasks/9123',
      acceptanceCriteria: [],
      deliveryTargets: ['rdesigner=release'],
      instrumentationFiles: [],
    },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, 'bad_launch_contract');
  assert.match(response.json().message, /точно совпадать с конфигурацией профиля/);
});

test('launch-options отклоняет неизвестный и синтаксически опасный profile query', async (t) => {
  const app = await fixture(t);
  for (const profile of ['unknown', '../rdesigner', 'RDESIGNER']) {
    const response = await app.inject({
      method: 'GET',
      url: '/api/tasks/9123/launch-options?profile=' + encodeURIComponent(profile),
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, 'bad_profile');
    assert.deepEqual(response.json().profiles, ['arsenkin', 'rdesigner']);
  }
});

test('launch не принимает profile в обход опубликованного списка', async (t) => {
  const app = await fixture(t);
  for (const profile of ['unknown', '../rdesigner', 'RDESIGNER']) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks/9123/launch',
      payload: { profile, ticket: 'проверка' },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, 'bad_profile');
    assert.deepEqual(response.json().profiles, ['arsenkin', 'rdesigner']);
  }
});
