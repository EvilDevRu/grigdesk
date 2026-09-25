import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { makeCatalogInput } from '../fixtures/routes-editor.mjs';
import { makeDraft } from '../fixtures/routes-editor.mjs';
import routesModule from '../../server/src/modules/routes/index.ts';

const routeTool = fileURLToPath(new URL('../../engine/bin/factory-route', import.meta.url));
const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

function step(catalogInput, cursor, outcome, failureOwner = null,
  counters = { noResult: {}, productFailure: {}, rewinds: {} },
  selectedRouteId = null, pinned = false, humanApproved = false, stepIndex = 1) {
  const input = { catalogInput, cursor, counters, outcome, failureOwner,
    selectedRouteId, pinned, stepIndex,
    ...(humanApproved ? { humanApproved: true } : {}) };
  const run = spawnSync(routeTool, ['--profile', 'sample', 'editor-step'], {
    input: JSON.stringify(input), encoding: 'utf8', timeout: 5000,
  });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr,
    value: run.stdout ? JSON.parse(run.stdout) : null };
}

test('RE-G3-02: done, typed failed и rejected выбирают переходы движка с точным reset', () => {
  const catalog = makeCatalogInput();
  const check = catalog.routes.quick.route.nodes.find((node) => node.id === 'check');
  check.onFailure = Object.fromEntries(
    ['build', 'tests', 'environment', 'plan', 'human'].map((owner) => [
      owner, owner === 'build'
        ? { rewind: 'build', reset: ['build', 'check'] } : { stop: 'human' },
    ]),
  );
  const cursor = { scope: 'route', routeId: 'quick', nodeId: 'build', terminal: false };
  const done = step(catalog, cursor, 'done');
  assert.equal(done.status, 0);
  assert.equal(done.value.cursor.nodeId, 'check');
  assert.deepEqual(done.value.action, { next: 'check' });
  const failed = step(catalog, { ...cursor, nodeId: 'check' }, 'failed', 'build');
  assert.equal(failed.status, 0);
  assert.deepEqual(failed.value.action, { rewind: 'build', reset: ['build', 'check'] });
  assert.deepEqual(failed.value.reset, ['build', 'check']);
  assert.equal(failed.value.cursor.nodeId, 'build');
  const rejected = step(catalog, { ...cursor, nodeId: 'gate_accept' }, 'rejected');
  assert.equal(rejected.status, 0);
  assert.deepEqual(rejected.value.reset, ['build', 'check', 'gate_accept']);
  assert.equal(rejected.value.cursor.nodeId, 'build');
});

test('RE-G3-03: scout требует разрешённую цель и явное решение для закреплённой попытки',
  () => {
    const catalog = makeCatalogInput();
    const cursor = { scope: 'bootstrap', routeId: null, nodeId: 'scout', terminal: false };
    const requested = step(catalog, cursor, 'done', null, undefined, 'quick', true);
    assert.equal(requested.status, 0);
    assert.equal(requested.value.requiresHuman, true);
    assert.deepEqual(requested.value.cursor, cursor);
    assert.deepEqual(requested.value.escalation, ['quick']);

    const accepted = step(catalog, cursor, 'done', null, undefined, 'quick', true, true);
    assert.equal(accepted.status, 0);
    assert.equal(accepted.value.requiresHuman, false);
    assert.deepEqual(accepted.value.cursor, {
      scope: 'route', routeId: 'quick', nodeId: 'build', terminal: false,
    });

    const denied = step(catalog, cursor, 'done', null, undefined, 'missing');
    assert.equal(denied.status, 78);
    assert.equal(denied.value.ok, false);
  });

test('RE-G3-04: повторы noResult и committed failed исчерпывают объявленные бюджеты',
  () => {
    const catalog = makeCatalogInput();
    const build = catalog.routes.quick.route.nodes.find((node) => node.id === 'build');
    const cursor = { scope: 'route', routeId: 'quick', nodeId: 'build', terminal: false };
    const zero = step(catalog, cursor, 'noResult');
    assert.equal(zero.status, 0);
    assert.deepEqual(zero.value.action, { stop: 'human' });
    assert.equal(zero.value.cursor.terminal, true);

    build.retry.noResult = 1;
    build.retry.providerFailure = { attempts: 1, strategy: 'runner-failover' };
    build.retry.productFailure = 1;
    const initial = { noResult: {}, productFailure: {}, rewinds: {} };
    const first = step(catalog, cursor, 'noResult', null, initial);
    assert.equal(first.status, 0);
    assert.deepEqual(first.value.action, { retry: 'noResult' });
    const second = step(catalog, cursor, 'noResult', null, first.value.counters);
    assert.equal(second.status, 0);
    assert.deepEqual(second.value.action, { retry: 'noResult' });
    const done = step(catalog, cursor, 'done', null, second.value.counters);
    assert.equal(done.status, 0);
    assert.equal(done.value.cursor.nodeId, 'check');

    const exhausted = step(catalog, cursor, 'noResult', null, second.value.counters);
    assert.equal(exhausted.status, 0);
    assert.deepEqual(exhausted.value.action, { stop: 'human' });
    const failed = step(catalog, cursor, 'failed', null, initial);
    assert.equal(failed.status, 0);
    assert.deepEqual(failed.value.action, { retry: 'productFailure' });
    const committed = step(catalog, cursor, 'failed', null, failed.value.counters);
    assert.equal(committed.status, 0);
    assert.deepEqual(committed.value.action, { stop: 'failed' });
  });

test('RE-G3-04: возвраты соблюдают лимит дуги и общий лимит цели dispatcher', () => {
  const catalog = makeCatalogInput();
  const check = catalog.routes.quick.route.nodes.find((node) => node.id === 'check');
  check.onFailure = Object.fromEntries(
    ['build', 'tests', 'environment', 'plan', 'human'].map((owner) => [
      owner, { rewind: 'build', reset: ['build', 'check'] },
    ]),
  );
  const cursor = { scope: 'route', routeId: 'quick', nodeId: 'check', terminal: false };
  const arc = 'quick/check:build';
  const arcLimited = step(catalog, cursor, 'failed', 'build', {
    noResult: {}, productFailure: {}, rewinds: { [arc]: 6 },
  });
  assert.equal(arcLimited.status, 0);
  assert.equal(arcLimited.value.stop, 'rewind-limit');
  assert.equal(arcLimited.value.cursor.terminal, true);

  const targetLimited = step(catalog, cursor, 'failed', 'build', {
    noResult: {}, productFailure: {}, rewinds: { 'target:quick/build': 10 },
  });
  assert.equal(targetLimited.status, 0);
  assert.equal(targetLimited.value.stop, 'rewind-limit');
  assert.equal(targetLimited.value.cursor.terminal, true);
});

test('RE-G3-04: повторный вход в узел после rewind получает новый локальный бюджет', () => {
  const catalog = makeCatalogInput();
  const build = catalog.routes.quick.route.nodes.find((node) => node.id === 'build');
  build.retry.noResult = 1;
  const cursor = { scope: 'route', routeId: 'quick', nodeId: 'build', terminal: false };
  const retry = step(catalog, cursor, 'noResult');
  assert.equal(retry.status, 0);
  const done = step(catalog, cursor, 'done', null, retry.value.counters);
  assert.equal(done.status, 0);
  const returned = step(catalog, cursor, 'noResult', null, done.value.counters);
  assert.equal(returned.status, 0);
  assert.deepEqual(returned.value.action, { retry: 'noResult' });
});

test('RE-G3-05: предел 200 проверяется до перехода, остановку нельзя продолжить', () => {
  const catalog = makeCatalogInput();
  const gate = { scope: 'route', routeId: 'quick', nodeId: 'gate_accept', terminal: false };
  const last = step(catalog, gate, 'rejected', null, undefined, null, false, false, 200);
  assert.equal(last.status, 0);
  assert.equal(last.value.cursor.nodeId, 'build');

  const overflow = step(catalog, last.value.cursor, 'done', null,
    last.value.counters, null, false, false, 201);
  assert.equal(overflow.status, 78);
  assert.equal(overflow.value.ok, false);
  assert.match(overflow.value.issues[0].message, /stepIndex/);

  const stopped = step(catalog, gate, 'approved');
  assert.equal(stopped.status, 0);
  assert.equal(stopped.value.cursor.terminal, true);
  const resumed = step(catalog, stopped.value.cursor, 'approved');
  assert.equal(resumed.status, 78);
  assert.match(resumed.value.issues[0].message, /терминальн/);
});

test('RE-G3-04: noResult не выдаётся за исход команды, неизвестный маршрут даёт issue',
  () => {
    const catalog = makeCatalogInput();
    const command = step(catalog, {
      scope: 'route', routeId: 'quick', nodeId: 'check', terminal: false,
    }, 'noResult');
    assert.equal(command.status, 78);
    assert.equal(command.value.ok, false);
    const missing = step(catalog, {
      scope: 'route', routeId: 'missing', nodeId: 'build', terminal: false,
    }, 'done');
    assert.equal(missing.status, 78);
    assert.equal(missing.value.ok, false);
    assert.equal(missing.stderr, '');
  });

test('RE-G3-06: пробный шаг не создаёт runtime state и не вызывает профиль',
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-route-simulation-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const marker = path.join(root, 'profile-command-marker');
    const state = path.join(root, 'state');
    const profiles = path.join(root, 'profiles');
    await fs.mkdir(state);
    await fs.mkdir(profiles);
    const catalog = makeCatalogInput();
    catalog.routes.quick.prompts['prompts/build.base.md'] =
      '$(' + `touch ${marker}` + ')';
    const request = {
      catalogInput: catalog,
      cursor: { scope: 'route', routeId: 'quick', nodeId: 'build', terminal: false },
      counters: { noResult: {}, productFailure: {}, rewinds: {} },
      outcome: 'done', failureOwner: null, selectedRouteId: null,
      pinned: false, stepIndex: 1,
    };
    const run = spawnSync(routeTool, ['--profile', 'sample', 'editor-step'], {
      input: JSON.stringify(request), encoding: 'utf8', timeout: 5000,
      env: { ...process.env, FACTORY_STATE: state, FACTORY_PROFILES_DIR: profiles },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, '');
    assert.deepEqual(await fs.readdir(state), []);
    assert.deepEqual(await fs.readdir(profiles), []);
    await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
    assert.equal(/attemptId|runId|operationId/.test(run.stdout), false);
  });

test('RE-G3-02: API шага привязывает ответ к ревизии черновика и не пишет runtime',
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-route-step-api-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const routesDir = path.join(root, 'routes');
    const app = Fastify({ logger: false });
    await app.register(routesModule, {
      config: {
        routesDir,
        routesAuthoringDir: path.join(root, 'authoring'),
        profilesDir: path.join(root, 'profiles'),
      },
      prefs: {
        read: () => ({ projects: { sample: {} } }),
        write: () => { throw new Error('симуляция не меняет prefs'); },
      },
    });
    await app.ready();
    t.after(() => app.close());
    const draft = makeDraft();
    const created = await app.inject({
      method: 'POST', url: '/api/routes/sample/drafts',
      payload: {
        kind: 'document', title: draft.title,
        baseCatalogHash: null, baseSourceRevision: 0,
        document: {
          routes: draft.routes, bootstrap: draft.bootstrap,
          bootstrapPrompts: draft.bootstrapPrompts,
          presentation: draft.presentation, provenance: draft.provenance,
        },
      },
    });
    assert.equal(created.statusCode, 201);
    const draftId = created.json().id;
    const beforeRoutes = await fs.readdir(path.join(routesDir, 'sample'));
    const request = {
      expectedRevision: 1,
      cursor: { scope: 'route', routeId: 'quick', nodeId: 'build', terminal: false },
      counters: { noResult: {}, productFailure: {}, rewinds: {} },
      outcome: 'done', failureOwner: null, selectedRouteId: null,
      pinned: false, humanApproved: false, stepIndex: 1,
    };
    const response = await app.inject({ method: 'POST',
      url: `/api/routes/sample/drafts/${draftId}/simulate/step`, payload: request });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().draftRevision, 1);
    assert.equal(response.json().cursor.nodeId, 'check');
    assert.deepEqual(await fs.readdir(path.join(routesDir, 'sample')), beforeRoutes);

    const stale = await app.inject({ method: 'POST',
      url: `/api/routes/sample/drafts/${draftId}/simulate/step`,
      payload: { ...request, expectedRevision: 2 } });
    assert.equal(stale.statusCode, 409);
  });
