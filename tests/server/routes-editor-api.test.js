import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import routesModule from '../../server/src/modules/routes/index.ts';
import authPlugin, { SESSION_COOKIE } from '../../server/src/plugins/auth.ts';
import { makeCatalogInput, makeDraft } from '../fixtures/routes-editor.mjs';
import { ROUTES_EDITOR_LIMITS } from '../../shared/routesEditorContracts.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');
const DRAFT_BASE = '/api/routes/sample/drafts';

async function fixture(t, { authenticated = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-routes-editor-api-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = {
    routesDir: path.join(root, 'routes'),
    routesAuthoringDir: path.join(root, 'routes.authoring'),
    profilesDir: path.join(root, 'profiles'),
  };
  const prefs = {
    read: () => ({ projects: { sample: {}, another: {} } }),
    write: () => { throw new Error('editor не должен писать prefs'); },
  };
  const app = Fastify({ logger: false });
  if (authenticated) {
    await app.register(authPlugin, {
      authStore: {
        isConfigured: () => true,
        isValidSession: (id) => id === 'valid-editor-session',
      },
    });
  }
  await app.register(routesModule, { config, prefs });
  await app.ready();
  t.after(() => app.close());
  const cookie = `${SESSION_COOKIE}=valid-editor-session`;
  const inject = (options) => app.inject({
    ...options,
    headers: authenticated ? { cookie, ...options.headers } : options.headers,
  });
  return { root, config, prefs, app, inject };
}

async function publishedCatalog(app) {
  const input = makeCatalogInput();
  const hashes = {};
  for (const [routeId, route] of Object.entries(input.routes)) {
    const published = await app.inject({
      method: 'POST',
      url: `/api/routes/sample/routes/${routeId}`,
      payload: route,
    });
    assert.equal(published.statusCode, 201);
    hashes[routeId] = published.json().routeHash;
  }
  const catalog = await app.inject({
    method: 'POST',
    url: '/api/routes/sample/catalog',
    payload: {
      catalog: {
        schema: 2,
        profile: 'sample',
        routes: hashes,
        bootstrap: { file: 'bootstrap/scout.json' },
      },
      bootstrap: input.bootstrap,
      prompts: input.bootstrapPrompts,
      expectedCatalogHash: null,
    },
  });
  assert.equal(catalog.statusCode, 201);
  return catalog.json().catalogHash;
}

test('RE-B4-01: create/list/get/patch и точная копия catalog hash', async (t) => {
  const { app, inject } = await fixture(t);
  const empty = await inject({
    method: 'POST',
    url: DRAFT_BASE,
    payload: { kind: 'empty', title: 'Новый маршрут' },
  });
  assert.equal(empty.statusCode, 201);
  assert.equal(empty.json().revision, 1);
  assert.equal(empty.json().bootstrap.entry, null);
  const id = empty.json().id;

  const listed = await inject({ method: 'GET', url: DRAFT_BASE });
  assert.equal(listed.statusCode, 200);
  assert.deepEqual(listed.json().drafts.map((draft) => draft.id), [id]);
  assert.equal(JSON.stringify(listed.json()).includes('bootstrapPrompts'), false);
  const read = await inject({ method: 'GET', url: `${DRAFT_BASE}/${id}` });
  assert.deepEqual(read.json(), empty.json());

  const patched = await inject({
    method: 'PATCH',
    url: `${DRAFT_BASE}/${id}`,
    payload: {
      expectedRevision: 1,
      operations: [{ kind: 'setTitle', title: 'Новая инструкция' }],
    },
  });
  assert.equal(patched.statusCode, 200);
  assert.equal(patched.json().revision, 2);

  const catalogHash = await publishedCatalog(app);
  const copied = await inject({
    method: 'POST',
    url: DRAFT_BASE,
    payload: { kind: 'catalog', title: 'Из каталога', catalogHash },
  });
  assert.equal(copied.statusCode, 201);
  assert.equal(copied.json().baseCatalogHash, catalogHash);
  assert.deepEqual(copied.json().routes.quick, makeDraft().routes.quick);
});

test('RE-B4-02: коды формы, CAS, размера и повреждения не раскрывают путь', async (t) => {
  const { config, inject } = await fixture(t);
  const created = await inject({
    method: 'POST',
    url: DRAFT_BASE,
    payload: { kind: 'empty', title: 'Проверка ошибок' },
  });
  const id = created.json().id;

  const missingRevision = await inject({
    method: 'PATCH',
    url: `${DRAFT_BASE}/${id}`,
    payload: { operations: [] },
  });
  assert.equal(missingRevision.statusCode, 400);
  assert.equal(missingRevision.json().error, 'routes_revision_required');

  const conflict = await inject({
    method: 'PATCH',
    url: `${DRAFT_BASE}/${id}`,
    payload: {
      expectedRevision: 2,
      operations: [{ kind: 'setTitle', title: 'Старое' }],
    },
  });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().error, 'routes_draft_conflict');
  assert.equal(conflict.json().currentRevision, 1);

  const route = makeDraft().routes.quick.route;
  const oversized = await inject({
    method: 'PATCH',
    url: `${DRAFT_BASE}/${id}`,
    payload: {
      expectedRevision: 1,
      operations: [{
        kind: 'putRoute',
        routeId: 'quick',
        route,
        prompts: { 'prompts/build.base.md': 'x'.repeat(ROUTES_EDITOR_LIMITS.promptFileBytes + 1) },
      }],
    },
  });
  assert.equal(oversized.statusCode, 413);
  assert.equal(oversized.json().error, 'routes_payload_too_large');

  const badShape = await inject({
    method: 'POST',
    url: DRAFT_BASE,
    payload: { kind: 'empty', title: 'Лишнее поле', state: 'published' },
  });
  assert.equal(badShape.statusCode, 400);
  assert.equal(badShape.json().error, 'routes_bad_request');

  const file = path.join(config.routesAuthoringDir, 'sample', 'drafts', `${id}.json`);
  await fs.writeFile(file, '{broken JSON');
  const corrupted = await inject({ method: 'GET', url: `${DRAFT_BASE}/${id}` });
  assert.equal(corrupted.statusCode, 500);
  assert.equal(corrupted.json().error, 'routes_authoring_corrupted');
  assert.equal(corrupted.body.includes(config.routesAuthoringDir), false);
});

test('RE-B4-03: общий auth закрывает чтение и PATCH без сессии', async (t) => {
  const { app, inject } = await fixture(t, { authenticated: true });
  const created = await inject({
    method: 'POST',
    url: DRAFT_BASE,
    payload: { kind: 'empty', title: 'Закрытый черновик' },
  });
  assert.equal(created.statusCode, 201);
  const id = created.json().id;

  const get = await app.inject({ method: 'GET', url: `${DRAFT_BASE}/${id}` });
  const patch = await app.inject({
    method: 'PATCH',
    url: `${DRAFT_BASE}/${id}`,
    payload: {
      expectedRevision: 1,
      operations: [{ kind: 'setTitle', title: 'Недоступно' }],
    },
  });
  assert.equal(get.statusCode, 401);
  assert.equal(patch.statusCode, 401);
  assert.equal((await inject({
    method: 'GET',
    url: `${DRAFT_BASE}/${id}`,
  })).json().revision, 1);
});

test('RE-B4-04: неизвестный проект 404, проект без фабричного профиля сохраняет draft', async (t) => {
  const { config, inject } = await fixture(t);
  const unknown = await inject({
    method: 'POST',
    url: '/api/routes/unknown/drafts',
    payload: { kind: 'empty', title: 'Неизвестный' },
  });
  assert.equal(unknown.statusCode, 404);

  const created = await inject({
    method: 'POST',
    url: DRAFT_BASE,
    payload: { kind: 'empty', title: 'Локальный проект' },
  });
  assert.equal(created.statusCode, 201);
  const info = await inject({ method: 'GET', url: '/api/routes/sample/editor' });
  assert.equal(info.statusCode, 200);
  assert.equal(info.json().profile, 'sample');
  assert.ok(info.json().issues.some((issue) => issue.code === 'profileUnavailable'));
  await assert.rejects(fs.stat(path.join(config.profilesDir, 'sample')), { code: 'ENOENT' });
});

test('RE-B4-05: открытие редактора только читает общий реестр проектов', async (t) => {
  const { inject, config } = await fixture(t);
  const projects = await inject({ method: 'GET', url: '/api/profiles' });
  assert.equal(projects.statusCode, 200);
  assert.deepEqual(projects.json().profiles, ['another', 'sample']);

  const editor = await inject({ method: 'GET', url: '/api/routes/sample/editor' });
  assert.equal(editor.statusCode, 200);
  assert.equal(editor.json().currentCatalogHash, null);
  await assert.rejects(fs.stat(config.routesAuthoringDir), { code: 'ENOENT' });
});

test('RE-B4-06: document создаёт локальную копию с новым ID и проверенным основанием', async (t) => {
  const { app, inject } = await fixture(t);
  const catalogHash = await publishedCatalog(app);
  const source = makeDraft();
  const document = {
    routes: source.routes,
    bootstrap: source.bootstrap,
    bootstrapPrompts: source.bootstrapPrompts,
    presentation: source.presentation,
    provenance: source.provenance,
  };
  const payload = {
    kind: 'document',
    title: 'Спасённая локальная копия',
    baseCatalogHash: catalogHash,
    baseSourceRevision: 0,
    document,
  };
  const created = await inject({ method: 'POST', url: DRAFT_BASE, payload });
  assert.equal(created.statusCode, 201);
  assert.notEqual(created.json().id, source.id);
  assert.equal(created.json().revision, 1);
  assert.equal(created.json().state, 'editing');
  assert.deepEqual(created.json().routes, source.routes);

  const forged = await inject({
    method: 'POST',
    url: DRAFT_BASE,
    payload: { ...payload, document: { ...document, state: 'published' } },
  });
  assert.equal(forged.statusCode, 400);

  const foreign = await inject({
    method: 'POST',
    url: '/api/routes/another/drafts',
    payload,
  });
  assert.notEqual(foreign.statusCode, 201);
});
