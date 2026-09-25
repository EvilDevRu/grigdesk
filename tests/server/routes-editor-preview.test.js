import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import routesModule from '../../server/src/modules/routes/index.ts';
import { renderDraftPreview } from '../../server/src/modules/routes/editorEngine.ts';
import { RoutesStore } from '../../server/src/modules/routes/store.ts';
import { makeDraft } from '../fixtures/routes-editor.mjs';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');
const ROUTE_TOOL = fileURLToPath(new URL('../../engine/bin/factory-route', import.meta.url));
const DRAFT_BASE = '/api/routes/sample/drafts';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-editor-preview-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = {
    routesDir: path.join(root, 'routes'),
    routesAuthoringDir: path.join(root, 'authoring'),
    profilesDir: path.join(root, 'profiles'),
  };
  const app = Fastify({ logger: false });
  await app.register(routesModule, {
    config,
    prefs: {
      read: () => ({ projects: { sample: {} } }),
      write: () => { throw new Error('preview не пишет prefs'); },
    },
  });
  await app.ready();
  t.after(() => app.close());
  const draft = makeDraft();
  const created = await app.inject({
    method: 'POST',
    url: DRAFT_BASE,
    payload: {
      kind: 'document',
      title: 'Предпросмотр',
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
  return { root, config, app, draftId: created.json().id, draft };
}

async function publishedRender(config, draft, context, root) {
  const store = new RoutesStore({ baseDir: config.routesDir });
  const routes = {};
  for (const [routeId, bundle] of Object.entries(draft.routes)) {
    routes[routeId] = (await store.publishRoute('sample', routeId, bundle)).routeHash;
  }
  const published = await store.publishCatalog('sample', {
    catalog: {
      schema: 2,
      profile: 'sample',
      routes,
      bootstrap: { file: 'bootstrap/scout.json' },
    },
    bootstrap: draft.bootstrap,
    prompts: draft.bootstrapPrompts,
  }, { expectedCatalogHash: null });
  const contextFile = path.join(root, 'context.json');
  await fs.writeFile(contextFile, JSON.stringify(context));
  const result = spawnSync(ROUTE_TOOL, [
    '--routes-dir', config.routesDir,
    '--profile', 'sample',
    'render-route', '--catalog-hash', published.catalogHash,
    '--route', 'quick', '--node', 'build', '--context', contextFile,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function editorRender(draft, context, scope = 'route', nodeId = 'build') {
  const result = spawnSync(ROUTE_TOOL, ['--profile', draft.profile, 'editor-render'], {
    input: JSON.stringify({
      catalogInput: {
        profile: draft.profile,
        routes: draft.routes,
        bootstrap: draft.bootstrap,
        bootstrapPrompts: draft.bootstrapPrompts,
      },
      scope,
      routeId: scope === 'route' ? 'quick' : null,
      nodeId,
      context,
    }),
    encoding: 'utf8',
  });
  assert.equal(result.error, undefined);
  return { status: result.status, ...JSON.parse(result.stdout) };
}

test('RE-C5-01: preview черновика побайтово совпадает с immutable renderer', async (t) => {
  const { root, config, app, draftId, draft } = await fixture(t);
  const context = { task: { kind: 'audit' } };
  const expected = await publishedRender(config, draft, context, root);
  const preview = await app.inject({
    method: 'POST',
    url: `${DRAFT_BASE}/${draftId}/preview`,
    payload: {
      expectedRevision: 1,
      scope: 'route',
      routeId: 'quick',
      nodeId: 'build',
      context,
    },
  });
  assert.equal(preview.statusCode, 200);
  assert.equal(preview.json().draftRevision, 1);
  assert.equal(preview.json().text, expected);
  assert.deepEqual(preview.json().includedBlocks, [
    'prompts/build.base.md', 'prompts/build.audit.md',
  ]);
  assert.deepEqual(preview.json().excludedBlocks, []);
  assert.deepEqual(preview.json().issues, []);
  assert.equal(preview.json().text.includes('attemptId'), false);
});

test('RE-C5-02: условия различают false, 0, null, отсутствующее поле и scalar', () => {
  const cases = [
    { expected: false, actual: false, included: true },
    { expected: 0, actual: 0, included: true },
    { expected: null, actual: null, included: true },
    { expected: 0, actual: false, included: false },
    { expected: null, actual: 0, included: false },
    { expected: 'audit', actual: 'normal', included: false },
    { expected: 0, actual: undefined, included: false },
  ];
  for (const { expected, actual, included } of cases) {
    const draft = makeDraft();
    draft.routes.quick.route.nodes[0].prompt.blocks[1].when.equals = expected;
    const context = { task: actual === undefined ? { other: 'fixture' } : { kind: actual } };
    const result = editorRender(draft, context);
    assert.equal(result.status, 0, JSON.stringify({ expected, actual, result }));
    assert.equal(result.issues.length, 0);
    assert.equal(result.includedBlocks.includes('prompts/build.audit.md'), included);
    assert.equal(result.excludedBlocks.includes('prompts/build.audit.md'), !included);
    assert.equal(result.text.includes('Для аудита перечисли найденные риски.'), included);
  }
});

test('RE-C5-03: missing root и секретный ключ дают issue без раскрытия значения', async (t) => {
  const draft = makeDraft();
  const missing = editorRender(draft, {});
  assert.equal(missing.status, 78);
  assert.equal(missing.text, '');
  assert.ok(missing.issues.some((item) => item.path === '/context'));

  const secret = 'CANARY_PREVIEW_SECRET_VALUE';
  const context = { task: { kind: 'audit' }, apiToken: secret };
  const rejected = editorRender(draft, context);
  assert.equal(rejected.status, 78);
  assert.ok(rejected.issues.some((item) => item.code === 'sensitive_context_forbidden'));
  assert.equal(JSON.stringify(rejected).includes(secret), false);

  const { app, draftId } = await fixture(t);
  const response = await app.inject({
    method: 'POST',
    url: `${DRAFT_BASE}/${draftId}/preview`,
    payload: {
      expectedRevision: 1, scope: 'route', routeId: 'quick', nodeId: 'build', context,
    },
  });
  assert.equal(response.statusCode, 200);
  assert.ok(response.json().issues.some((item) => item.code === 'sensitive_context_forbidden'));
  assert.equal(response.body.includes(secret), false);
});

test('RE-C5-04: shell-похожие строки промпта остаются текстом', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-prompt-literal-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const marker = path.join(root, 'would-run');
  const dollar = '$(' + 'touch ' + marker + ')';
  const ticks = String.fromCharCode(96) + 'touch ' + marker + String.fromCharCode(96);
  const draft = makeDraft();
  draft.routes.quick.prompts['prompts/build.base.md'] = `${dollar}\n${ticks}\n`;
  const result = editorRender(draft, { task: { kind: 'normal' } });
  assert.equal(result.status, 0);
  assert.ok(result.text.includes(dollar));
  assert.ok(result.text.includes(ticks));
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
});

test('RE-C5-05: зависший и неисправный child не дают пустого успешного preview', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-preview-child-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const request = {
    scope: 'route', routeId: 'quick', nodeId: 'build', context: { task: { kind: 'audit' } },
  };
  const cases = [
    ['hang', '#!/usr/bin/env python3\nimport time\ntime.sleep(60)\n', 40],
    ['invalid', '#!/usr/bin/env python3\nprint("invalid-json")\n', 1000],
    ['oversize', '#!/usr/bin/env python3\nimport sys\nsys.stdout.write("x" * (17 * 1024 * 1024))\n', 1000],
  ];
  for (const [name, source, timeoutMs] of cases) {
    const toolPath = path.join(root, name);
    await fs.writeFile(toolPath, source, { mode: 0o700 });
    await assert.rejects(
      renderDraftPreview(makeDraft(), request, { toolPath, timeoutMs }),
      { code: 'routes_engine_unavailable' },
      name,
    );
  }
});
