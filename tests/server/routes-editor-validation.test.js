import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import routesModule from '../../server/src/modules/routes/index.ts';
import { validateDraft } from '../../server/src/modules/routes/validation.ts';
import {
  validatePromptFiles,
  validateRoute,
} from '../../server/src/modules/routes/schema.ts';
import { makeDraft } from '../fixtures/routes-editor.mjs';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-route-validation-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const profileRoutes = path.join(root, 'profiles', 'sample', 'routes');
  await fs.mkdir(profileRoutes, { recursive: true });
  await fs.writeFile(path.join(root, 'profiles', 'sample', 'graph.json'),
    JSON.stringify({ capabilities: [] }));
  await fs.writeFile(path.join(profileRoutes, 'editor-capabilities.json'), JSON.stringify({
    schema: 1,
    commands: [{
      id: 'project-check',
      label: 'Проверка проекта',
      filesystem: ['state-only'],
    }],
    contextSections: [],
  }));
  const app = Fastify({ logger: false });
  await app.register(routesModule, {
    config: {
      routesDir: path.join(root, 'routes'),
      routesAuthoringDir: path.join(root, 'routes.authoring'),
      profilesDir: path.join(root, 'profiles'),
    },
    prefs: {
      read: () => ({ projects: { sample: {} } }),
      write: () => { throw new Error('validate не пишет prefs'); },
    },
  });
  await app.ready();
  t.after(() => app.close());
  return { app, root };
}

async function createDraft(app, draft) {
  const created = await app.inject({
    method: 'POST',
    url: '/api/routes/sample/drafts',
    payload: {
      kind: 'document',
      title: draft.title,
      baseCatalogHash: null,
      baseSourceRevision: 0,
      document: {
        routes: draft.routes,
        bootstrap: draft.bootstrap,
        bootstrapPrompts: draft.bootstrapPrompts,
        presentation: draft.presentation,
        provenance: draft.provenance,
      },
    },
  });
  assert.equal(created.statusCode, 201);
  return created.json();
}

async function validate(app, draftId) {
  return app.inject({
    method: 'POST',
    url: `/api/routes/sample/drafts/${draftId}/validate`,
    payload: {},
  });
}

test('RE-B5-01: пустой prompt и чужой переход дают независимые адресные issues', async (t) => {
  const { app } = await fixture(t);
  const draft = makeDraft();
  draft.routes.quick.prompts['prompts/build.base.md'] = '';
  draft.routes.audit = structuredClone(draft.routes.quick);
  draft.routes.audit.route.id = 'audit';
  draft.routes.audit.prompts['prompts/build.base.md'] = 'Проверь результат.';
  draft.routes.audit.route.nodes[0].on.done = { next: 'ghost' };
  const created = await createDraft(app, draft);

  const response = await validate(app, created.id);
  assert.equal(response.statusCode, 200);
  const issues = response.json().issues;
  assert.deepEqual(issues.map((issue) => [issue.code, issue.routeId, issue.nodeId]), [
    ['prompt_required', 'quick', 'build'],
    ['transition_target_missing', 'audit', 'build'],
  ]);
  assert.ok(issues.every((issue) => issue.path.startsWith('/routes/')));
  assert.equal(response.json().draftRevision, 1);
});

test('RE-B5-02: отсутствующий маршрут виден во всех видах ссылок', async (t) => {
  const { app } = await fixture(t);
  const draft = makeDraft();
  draft.bootstrap.escalation[0].allowedRoutes = ['ghost'];
  draft.bootstrap.nodes[0].on.done = { escalate: { routes: ['ghost'] } };
  draft.routes.quick.route.nodes[0].on.done = { escalate: { routes: ['ghost'] } };
  draft.routes.quick.route.nodes[1].onFailure = {
    build: { escalate: { routes: ['ghost'] } },
    tests: { stop: 'human' },
    environment: { stop: 'human' },
    plan: { stop: 'human' },
    human: { stop: 'human' },
  };
  const created = await createDraft(app, draft);
  const response = await validate(app, created.id);

  assert.equal(response.statusCode, 200);
  const references = response.json().issues.filter(
    (item) => item.code === 'route_reference_missing',
  );
  assert.equal(references.length, 4);
  assert.ok(references.some((item) => item.path.includes('/bootstrap/escalation/')));
  assert.ok(references.some((item) => item.path.includes('/bootstrap/nodes/0/on/done/')));
  assert.ok(references.some((item) => item.path.includes('/route/nodes/0/on/done/')));
  assert.ok(references.some((item) => item.path.includes('/onFailure/build/')));
});

test('RE-B5-03: историческая схема читается, новая проверка видит productFailure+rewind', () => {
  const draft = makeDraft();
  const check = draft.routes.quick.route.nodes[1];
  check.executor = 'agent';
  delete check.commandId;
  check.prompt = {
    blocks: [{ file: 'prompts/check.base.md' }],
    requiredContext: ['task'],
  };
  check.retry.productFailure = 1;
  check.on.failed = { rewind: 'build', reset: ['build', 'check'] };
  draft.routes.quick.prompts['prompts/check.base.md'] = 'Проверь работу.';

  const files = validatePromptFiles(draft.routes.quick.prompts, { prefix: 'prompts/' });
  assert.doesNotThrow(() => validateRoute(draft.routes.quick.route, {
    profile: 'sample',
    routeId: 'quick',
    promptFiles: files,
    allowLegacyProductFailureRewind: true,
  }));
  const report = validateDraft(draft);
  assert.ok(report.issues.some((item) => item.code === 'product_failure_rewind'
    && item.nodeId === 'check'
    && item.path.endsWith('/retry/productFailure')));
});

test('RE-B5-04: null, status-target и неверный reset имеют разные коды', async (t) => {
  const { app } = await fixture(t);
  const draft = makeDraft();
  const nodes = draft.routes.quick.route.nodes;
  nodes[0].on.skipped = null;
  nodes[0].on.done = { next: 'check_status' };
  nodes[3].on.rejected = { rewind: 'build', reset: ['build'] };
  const created = await createDraft(app, draft);
  const response = await validate(app, created.id);

  assert.equal(response.statusCode, 200);
  const issues = response.json().issues;
  assert.ok(issues.some((item) => item.code === 'transition_required'
    && item.nodeId === 'build'));
  assert.ok(issues.some((item) => item.code === 'status_target_invalid'
    && item.nodeId === 'build'));
  assert.ok(issues.some((item) => item.code === 'rewind_reset_invalid'
    && item.nodeId === 'gate_accept'));
  assert.equal(issues.some((item) => item.code === 'route_schema_invalid'), false);
});

test('RE-B5-05: повторная проверка детерминирована и не меняет draft/current', async (t) => {
  const { app, root } = await fixture(t);
  const draft = makeDraft();
  draft.routes.quick.prompts['prompts/build.base.md'] = '';
  const created = await createDraft(app, draft);
  const draftUrl = `/api/routes/sample/drafts/${created.id}`;
  const before = (await app.inject({ method: 'GET', url: draftUrl })).body;

  const first = await validate(app, created.id);
  const second = await validate(app, created.id);
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.deepEqual(second.json(), first.json());
  assert.match(second.json().capabilitiesHash, /^[a-f0-9]{64}$/);
  assert.equal((await app.inject({ method: 'GET', url: draftUrl })).body, before);
  await assert.rejects(
    fs.stat(path.join(root, 'routes', 'sample', 'catalog', 'current.json')),
    { code: 'ENOENT' },
  );
});
