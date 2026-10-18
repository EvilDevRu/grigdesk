import assert from 'node:assert/strict';
import {
  access,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import routesApi from '../../server/src/modules/routes/api.ts';
import routesModule from '../../server/src/modules/routes/index.ts';
import { RoutesError } from '../../server/src/modules/routes/schema.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

const PROFILE = 'sample';
const ROUTE = 'quick';

function stop(target = 'human') {
  return { stop: target };
}

function agentNode({
  id,
  phase,
  runKey,
  promptFile,
  requiredContext,
  on,
}) {
  return {
    id,
    executor: 'agent',
    phase,
    runKey,
    emits: [],
    prompt: {
      blocks: [{ file: promptFile }],
      requiredContext,
    },
    policy: {
      filesystem: 'state-only',
      timeoutClass: 'standard',
      budgetClass: 'standard',
    },
    fanout: {
      mode: 'single',
      maxExecutors: 1,
      degrade: 'forbid',
    },
    retry: {
      noResult: 1,
      providerFailure: {
        attempts: 1,
        strategy: 'runner-failover',
      },
      productFailure: 0,
    },
    on,
  };
}

function routeDocument(title = 'Быстрый маршрут') {
  return {
    schema: 2,
    kind: 'route',
    profile: PROFILE,
    id: ROUTE,
    title,
    entry: 'build',
    sequence: {
      main: ['build'],
      tail: [],
    },
    nodes: [
      agentNode({
        id: 'build',
        phase: 'main',
        runKey: 'BUILD',
        promptFile: 'prompts/build.base.md',
        requiredContext: ['task'],
        on: {
          done: stop('done'),
          skipped: stop(),
          failed: stop('failed'),
          exhausted: stop(),
        },
      }),
    ],
    escalation: [],
  };
}

function routePayload(title) {
  return {
    route: routeDocument(title),
    prompts: {
      'prompts/build.base.md': 'Выполни изменение и проверь результат.',
    },
  };
}

function bootstrapDocument() {
  return {
    schema: 2,
    kind: 'bootstrap',
    profile: PROFILE,
    id: 'scout',
    entry: 'scout',
    sequence: {
      bootstrap: ['scout'],
    },
    nodes: [
      agentNode({
        id: 'scout',
        phase: 'bootstrap',
        runKey: 'SCOUT',
        promptFile: 'bootstrap/prompts/scout.base.md',
        requiredContext: ['task', 'routeCatalog'],
        on: {
          done: { escalate: { routes: [ROUTE] } },
          skipped: stop(),
          failed: stop(),
          exhausted: stop(),
        },
      }),
    ],
    escalation: [
      {
        from: 'scout',
        allowedRoutes: [ROUTE],
        requiresHumanWhenPinned: true,
      },
    ],
  };
}

function catalogPayload(routeHash, expectedCatalogHash) {
  return {
    catalog: {
      schema: 2,
      profile: PROFILE,
      routes: {
        [ROUTE]: routeHash,
      },
      bootstrap: {
        file: 'bootstrap/scout.json',
      },
    },
    bootstrap: bootstrapDocument(),
    prompts: {
      'bootstrap/prompts/scout.base.md': 'Выбери маршрут из закреплённого каталога.',
    },
    expectedCatalogHash,
  };
}

async function fixture(t, { store, viaRoutesModule = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-routes-api-'));
  const baseDir = path.join(root, 'routes');
  const app = Fastify({ logger: false });
  if (viaRoutesModule) {
    app.register(routesModule, {
      config: {
        routesDir: baseDir,
        profilesDir: path.join(root, 'profiles'),
        agentsDir: path.join(root, 'agents'),
      },
      prefs: { read: () => ({}), write: () => {} },
    });
  } else {
    app.register(routesApi, {
      baseDir,
      store,
      profilesDir: path.join(root, 'profiles'),
    });
  }
  await app.ready();
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  return { app, baseDir, root };
}

async function publishRoute(app, title) {
  return app.inject({
    method: 'POST',
    url: `/api/routes/${PROFILE}/routes/${ROUTE}`,
    payload: routePayload(title),
  });
}

async function publishCatalog(app, routeHash, expectedCatalogHash) {
  return app.inject({
    method: 'POST',
    url: `/api/routes/${PROFILE}/catalog`,
    payload: catalogPayload(routeHash, expectedCatalogHash),
  });
}

test('ROUTES-API-01: publish/read route и идемпотентный HTTP status', async (t) => {
  const { app, baseDir } = await fixture(t);
  await assert.rejects(access(baseDir), (error) => error?.code === 'ENOENT');

  const created = await publishRoute(app);
  const repeated = await publishRoute(app);

  assert.equal(created.statusCode, 201);
  assert.equal(repeated.statusCode, 200);
  assert.equal(repeated.json().routeHash, created.json().routeHash);
  assert.equal(repeated.json().created, false);
  assert.equal(
    created.headers.location,
    `/api/routes/${PROFILE}/routes/${ROUTE}/${created.json().routeHash}`,
  );

  const read = await app.inject({
    method: 'GET',
    url: created.headers.location,
  });
  assert.equal(read.statusCode, 200);
  assert.deepEqual(read.json().route, routeDocument());
  assert.match(read.headers['cache-control'], /immutable/);
});

test('ROUTES-API-02: publish catalog требует expected hash и отдаёт current', async (t) => {
  const { app } = await fixture(t);
  const route = await publishRoute(app);
  const missingExpected = catalogPayload(route.json().routeHash, null);
  delete missingExpected.expectedCatalogHash;

  const bad = await app.inject({
    method: 'POST',
    url: `/api/routes/${PROFILE}/catalog`,
    payload: missingExpected,
  });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().code, 'ROUTES_V2_INVALID_SCHEMA');

  const created = await publishCatalog(app, route.json().routeHash, null);
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().currentChanged, true);
  assert.equal(
    created.headers.location,
    `/api/routes/${PROFILE}/catalog/${created.json().catalogHash}`,
  );

  const current = await app.inject({
    method: 'GET',
    url: `/api/routes/${PROFILE}/current`,
  });
  const exact = await app.inject({
    method: 'GET',
    url: created.headers.location,
  });
  assert.equal(current.statusCode, 200);
  assert.equal(current.json().catalogHash, created.json().catalogHash);
  assert.equal(current.headers['cache-control'], 'no-store');
  assert.equal(exact.statusCode, 200);
  assert.match(exact.headers['cache-control'], /immutable/);
});

test('ROUTES-API-03: stale publish получает 409, rollback использует отдельный CAS', async (t) => {
  const { app } = await fixture(t);
  const route1 = await publishRoute(app, 'Версия 1');
  const catalog1 = await publishCatalog(app, route1.json().routeHash, null);
  const route2 = await publishRoute(app, 'Версия 2');
  const catalog2 = await publishCatalog(
    app,
    route2.json().routeHash,
    catalog1.json().catalogHash,
  );
  const route3 = await publishRoute(app, 'Версия 3');

  const stale = await publishCatalog(
    app,
    route3.json().routeHash,
    catalog1.json().catalogHash,
  );
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().code, 'ROUTES_V2_STALE_REVISION');
  assert.equal(stale.json().currentCatalogHash, catalog2.json().catalogHash);

  const rollback = await app.inject({
    method: 'PUT',
    url: `/api/routes/${PROFILE}/current`,
    payload: {
      desiredCatalogHash: catalog1.json().catalogHash,
      expectedCatalogHash: catalog2.json().catalogHash,
    },
  });
  assert.equal(rollback.statusCode, 200);
  assert.deepEqual(rollback.json(), {
    changed: true,
    catalogHash: catalog1.json().catalogHash,
  });
  assert.equal(
    (await app.inject({
      method: 'GET',
      url: `/api/routes/${PROFILE}/current`,
    })).json().catalogHash,
    catalog1.json().catalogHash,
  );
});

test('ROUTES-API-04: schema/path получают 400, отсутствие — 404', async (t) => {
  const { app } = await fixture(t);
  const invalidId = await app.inject({
    method: 'POST',
    url: `/api/routes/${PROFILE}/routes/Bad`,
    payload: routePayload(),
  });
  assert.equal(invalidId.statusCode, 400);
  assert.equal(invalidId.json().code, 'ROUTES_V2_INVALID_ID');

  const reservedId = await app.inject({
    method: 'POST',
    url: `/api/routes/${PROFILE}/routes/catalog`,
    payload: routePayload(),
  });
  assert.equal(reservedId.statusCode, 400);
  assert.equal(reservedId.json().code, 'ROUTES_V2_INVALID_ID');

  const traversalPrompt = routePayload();
  traversalPrompt.prompts['prompts/../secret.md'] = 'Нельзя';
  const traversal = await app.inject({
    method: 'POST',
    url: `/api/routes/${PROFILE}/routes/${ROUTE}`,
    payload: traversalPrompt,
  });
  assert.equal(traversal.statusCode, 400);
  assert.equal(traversal.json().code, 'ROUTES_V2_PATH_TRAVERSAL');

  const missing = await app.inject({
    method: 'GET',
    url: `/api/routes/${PROFILE}/routes/${ROUTE}/${'a'.repeat(64)}`,
  });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().code, 'ROUTES_V2_NOT_FOUND');

  const noCurrent = await app.inject({
    method: 'GET',
    url: `/api/routes/${PROFILE}/current`,
  });
  assert.equal(noCurrent.statusCode, 404);
});

test('ROUTES-API-05: tampering получает 422 без раскрытия host path', async (t) => {
  const { app, baseDir, root } = await fixture(t);
  const route = await publishRoute(app);
  const promptPath = path.join(
    baseDir,
    PROFILE,
    ROUTE,
    'revisions',
    route.json().routeHash,
    'prompts',
    'build.base.md',
  );
  await writeFile(promptPath, 'Подмена\n');

  const response = await app.inject({
    method: 'GET',
    url: route.headers.location,
  });
  assert.equal(response.statusCode, 422);
  assert.equal(response.json().code, 'ROUTES_V2_TAMPERED');
  assert.doesNotMatch(response.body, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('ROUTES-API-06: lock конфликт строго отображается в 409', async (t) => {
  const fakeStore = {
    async readCurrent() {
      throw new RoutesError('ROUTES_V2_LOCKED', 'internal lock path');
    },
  };
  const { app } = await fixture(t, { store: fakeStore });

  const response = await app.inject({
    method: 'GET',
    url: `/api/routes/${PROFILE}/current`,
  });
  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.json(), {
    error: 'routes_v2_locked',
    code: 'ROUTES_V2_LOCKED',
    message: 'Указатель каталога сейчас изменяется другим запросом.',
  });
  assert.doesNotMatch(response.body, /internal lock path/);
});

test('ROUTES-API-07: publish не принимает лишние wrapper-поля', async (t) => {
  const { app } = await fixture(t);
  const payload = {
    ...routePayload(),
    provider: 'codex',
  };
  const response = await app.inject({
    method: 'POST',
    url: `/api/routes/${PROFILE}/routes/${ROUTE}`,
    payload,
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().code, 'ROUTES_V2_INVALID_SCHEMA');
});

test('ROUTES-API-08: общий routes module монтирует единый API без старого namespace', async (t) => {
  const { app, baseDir } = await fixture(t, { viaRoutesModule: true });
  await assert.rejects(access(baseDir), (error) => error?.code === 'ENOENT');

  const noCurrent = await app.inject({
    method: 'GET',
    url: `/api/routes/${PROFILE}/current`,
  });
  assert.equal(noCurrent.statusCode, 404);
  assert.equal(noCurrent.json().error, 'routes_v2_not_found');
  const removedNamespace = await app.inject({
    method: 'GET',
    url: `/api/${['routes', 'v2'].join('-')}/${PROFILE}/current`,
  });
  assert.equal(removedNamespace.statusCode, 404);
  assert.equal(await publishRoute(app).then((response) => response.statusCode), 201);
});

test('ROUTES-API-09: список ревизий отдаёт состав каталога и отмечает текущую', async (t) => {
  const { app } = await fixture(t);

  // Пустое хранилище — не ошибка: проект просто ещё не публиковался.
  const empty = await app.inject({
    method: 'GET',
    url: `/api/routes/${PROFILE}/revisions`,
  });
  assert.equal(empty.statusCode, 200);
  assert.deepEqual(empty.json(), {
    profile: PROFILE,
    publishSupported: false,
    currentCatalogHash: null,
    revisions: [],
  });

  const route1 = await publishRoute(app, 'Версия 1');
  const catalog1 = await publishCatalog(app, route1.json().routeHash, null);
  const route2 = await publishRoute(app, 'Версия 2');
  const catalog2 = await publishCatalog(
    app,
    route2.json().routeHash,
    catalog1.json().catalogHash,
  );

  const listed = (await app.inject({
    method: 'GET',
    url: `/api/routes/${PROFILE}/revisions`,
  })).json();
  assert.equal(listed.currentCatalogHash, catalog2.json().catalogHash);
  assert.deepEqual(
    [...listed.revisions.map((revision) => revision.catalogHash)].sort(),
    [catalog1.json().catalogHash, catalog2.json().catalogHash].sort(),
  );
  const current = listed.revisions.find((revision) => revision.isCurrent);
  assert.equal(current.catalogHash, catalog2.json().catalogHash);
  assert.equal(current.integrity, 'ok');
  assert.deepEqual(current.routes, { [ROUTE]: route2.json().routeHash });
  assert.equal(
    listed.revisions.filter((revision) => revision.isCurrent).length,
    1,
    'текущая ревизия ровно одна',
  );
});

/** Подставной публикатор профиля: печатает свои аргументы, падает по --fail. */
async function writePublishScript(root, { failing = false } = {}) {
  const dir = path.join(root, 'profiles', PROFILE, 'routes');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'publish.mjs'), failing
    ? 'process.stderr.write("sample routes v2: определение сломано\\n");\nprocess.exit(3);\n'
    : 'process.stdout.write(JSON.stringify({ valid: true, argv: process.argv.slice(2) }));\n');
}

test('ROUTES-API-10: публикация идёт скриптом профиля, без скрипта — 404', async (t) => {
  const { app, baseDir, root } = await fixture(t);

  const unavailable = await app.inject({
    method: 'POST',
    url: `/api/routes/${PROFILE}/publish`,
    payload: { mode: 'validate' },
  });
  assert.equal(unavailable.statusCode, 404);
  assert.equal(unavailable.json().error, 'routes_v2_publish_unavailable');

  // Старое operational имя не является fallback: после cutover публикатор
  // ищется только по profiles/<profile>/routes/publish.mjs.
  const removedDir = path.join(root, 'profiles', PROFILE, ['routes', 'v2'].join('-'));
  await mkdir(removedDir, { recursive: true });
  await writeFile(
    path.join(removedDir, 'publish.mjs'),
    'process.stdout.write(JSON.stringify({ legacy: true }));\n',
  );
  const removedPath = await app.inject({
    method: 'POST',
    url: `/api/routes/${PROFILE}/publish`,
    payload: { mode: 'validate' },
  });
  assert.equal(removedPath.statusCode, 404);

  await writePublishScript(root);

  const validated = await app.inject({
    method: 'POST',
    url: `/api/routes/${PROFILE}/publish`,
    payload: { mode: 'validate' },
  });
  assert.equal(validated.statusCode, 200);
  assert.deepEqual(validated.json().result.argv, ['--validate']);

  // Публикация получает ровно два аргумента GrigDesk: куда писать и поверх чего.
  const publishedEmpty = await app.inject({
    method: 'POST',
    url: `/api/routes/${PROFILE}/publish`,
    payload: { mode: 'publish', expectedCatalogHash: null },
  });
  assert.equal(publishedEmpty.statusCode, 200);
  assert.deepEqual(publishedEmpty.json().result.argv, [
    '--publish',
    '--base-dir',
    baseDir,
    '--expected-catalog-hash',
    'null',
  ]);
  assert.equal(publishedEmpty.json().currentCatalogHash, null);

  const badMode = await app.inject({
    method: 'POST',
    url: `/api/routes/${PROFILE}/publish`,
    payload: { mode: 'seed' },
  });
  assert.equal(badMode.statusCode, 400);
  assert.equal(badMode.json().code, 'ROUTES_V2_INVALID_SCHEMA');

  const badHash = await app.inject({
    method: 'POST',
    url: `/api/routes/${PROFILE}/publish`,
    payload: { mode: 'publish', expectedCatalogHash: 'не-хеш' },
  });
  assert.equal(badHash.statusCode, 400);
  assert.equal(badHash.json().code, 'ROUTES_V2_INVALID_HASH');
});

test('ROUTES-API-11: провал публикатора — 422 с его же последней строкой', async (t) => {
  const { app, root } = await fixture(t);
  await writePublishScript(root, { failing: true });

  const failed = await app.inject({
    method: 'POST',
    url: `/api/routes/${PROFILE}/publish`,
    payload: { mode: 'validate' },
  });
  assert.equal(failed.statusCode, 422);
  assert.equal(failed.json().error, 'routes_v2_publish_failed');
  assert.equal(failed.json().reason, 'exit');
  assert.equal(failed.json().message, 'sample routes v2: определение сломано');
});

test('ROUTES-API-12: схема маршрута строится из машины бандла', async (t) => {
  const { app } = await fixture(t);
  const { routeHash } = (await publishRoute(app)).json();
  const { catalogHash } = (await publishCatalog(app, routeHash, null)).json();

  const response = await app.inject({
    method: 'GET',
    url: `/api/routes/${PROFILE}/catalog/${catalogHash}/graph?route=${ROUTE}`,
  });
  assert.equal(response.statusCode, 200);
  // Схема — производная от бандла: после обновления рендера тот же hash обязан отдать
  // новую картинку, поэтому immutable-кеш здесь запрещён.
  assert.equal(response.headers['cache-control'], 'private, no-store');

  const { graph } = response.json();
  assert.equal(graph.route, ROUTE);
  assert.equal(graph.keys.build, 'BUILD');
  // Узлы схемы — из машины (плюс scout каталога и ромб стенда), чужих этапов нет.
  // Остановка — исход, а не этап: она описана в данных проекции, но не нарисована.
  assert.deepEqual(Object.keys(graph.pos).sort(), ['build', 'sandbox', 'scout']);
  assert.equal(graph.nodeOrigins['r:quick:stop:done']?.executable, false);
  assert.ok(graph.edges.some(([from, to]) => from === 'scout' && to === 'build'));
  const routeOnly = await app.inject({ method: 'GET',
    url: `/api/routes/${PROFILE}/routes/${ROUTE}/${routeHash}/graph` });
  assert.equal(routeOnly.statusCode, 200);
  assert.equal(routeOnly.json().graph.nodes.scout, undefined);
});

test('ROUTES-API-13: схема shared-профиля строится без ромба песочницы', async (t) => {
  const { app, root } = await fixture(t);
  // Режим читается из trusted profile.sh; без него (тест выше) ромб сохраняется.
  await mkdir(path.join(root, 'profiles', PROFILE), { recursive: true });
  await writeFile(
    path.join(root, 'profiles', PROFILE, 'profile.sh'),
    'profile_workspace_mode() { printf \'shared\\n\'; }\n',
  );
  const { routeHash } = (await publishRoute(app)).json();
  const { catalogHash } = (await publishCatalog(app, routeHash, null)).json();

  const response = await app.inject({
    method: 'GET',
    url: `/api/routes/${PROFILE}/catalog/${catalogHash}/graph?route=${ROUTE}`,
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'private, no-store');

  const { graph } = response.json();
  assert.deepEqual(Object.keys(graph.pos).sort(), ['build', 'scout']);
  assert.equal(graph.nodeOrigins['r:quick:stop:done']?.executable, false);
  assert.equal(graph.nodes.sandbox, undefined);
  assert.ok(!graph.edges.some(([from, to]) => from === 'sandbox' || to === 'sandbox'));
});
