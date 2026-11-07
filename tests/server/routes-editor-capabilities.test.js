import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import routesModule from '../../server/src/modules/routes/index.ts';
import { makeDraft } from '../fixtures/routes-editor.mjs';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

async function fixture(t, { withProfile = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-editor-capabilities-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const profilesDir = path.join(root, 'profiles');
  const profileDir = path.join(profilesDir, 'sample');
  const routesDir = path.join(profileDir, 'routes');
  if (withProfile) {
    await fs.mkdir(routesDir, { recursive: true });
    await fs.writeFile(path.join(profileDir, 'graph.json'), JSON.stringify({ capabilities: [] }));
  }
  const app = Fastify({ logger: false });
  await app.register(routesModule, {
    config: {
      routesDir: path.join(root, 'published-routes'),
      routesAuthoringDir: path.join(root, 'authoring'),
      profilesDir,
    },
    prefs: {
      read: () => ({ projects: { sample: {} } }),
      write: () => { throw new Error('capabilities не пишут prefs'); },
    },
  });
  await app.ready();
  t.after(() => app.close());
  return { root, app, profileDir, routesDir };
}

async function info(app) {
  const response = await app.inject({
    method: 'GET',
    url: '/api/routes/sample/editor',
  });
  assert.equal(response.statusCode, 200);
  return response.json();
}

test('RE-C3-01: manifest command и встроенные секции входят в UI-контракт', async (t) => {
  const { app, routesDir } = await fixture(t);
  await fs.writeFile(path.join(routesDir, 'editor-capabilities.json'), JSON.stringify({
    schema: 1,
    commands: [{
      id: 'project-check',
      label: 'Проверка проекта',
      filesystem: ['state-only'],
    }],
    contextSections: [{ id: 'projectChecklist', label: 'Правила проекта' }],
  }));
  const editor = await info(app);

  assert.deepEqual(editor.capabilities.commands, [{
    id: 'project-check',
    label: 'Проверка проекта',
    filesystem: ['state-only'],
  }]);
  assert.ok(editor.capabilities.contextSections.some((entry) => entry.id === 'task'));
  assert.ok(editor.capabilities.contextSections.some((entry) => entry.id === 'routeCatalog'));
  assert.ok(editor.capabilities.contextSections.some((entry) => entry.id === 'projectChecklist'));
  assert.match(editor.capabilitiesHash, /^[a-f0-9]{64}$/);
});

test('RE-C3-02: без manifest встроенный agent доступен, command без объявления блокируется', async (t) => {
  const { app } = await fixture(t);
  const editor = await info(app);
  assert.deepEqual(editor.capabilities.commands, []);
  assert.ok(editor.capabilities.contextSections.some((item) => item.id === 'task'));

  const draft = makeDraft();
  const created = await app.inject({
    method: 'POST',
    url: '/api/routes/sample/drafts',
    payload: {
      kind: 'document',
      title: 'Команда без объявления',
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
  const validation = await app.inject({
    method: 'POST',
    url: `/api/routes/sample/drafts/${created.json().id}/validate`,
    payload: {},
  });
  assert.equal(validation.statusCode, 200);
  assert.ok(validation.json().issues.some((item) => item.code === 'command_unavailable'
    && item.nodeId === 'check'));
  assert.equal(validation.json().issues.some((item) => item.code === 'context_section_unavailable'),
    false);
  assert.match(validation.json().capabilitiesHash, /^[a-f0-9]{64}$/);
});

test('RE-C3-03: битый, подменённый и неизвестный manifest не исполняют профиль', async (t) => {
  const { root, app, profileDir, routesDir } = await fixture(t);
  const manifest = path.join(routesDir, 'editor-capabilities.json');
  const marker = path.join(root, 'profile-ran');
  await fs.writeFile(path.join(profileDir, 'profile.sh'), `touch "${marker}"\n`);
  const cases = [
    '{bad JSON',
    JSON.stringify({ schema: 2, commands: [], contextSections: [] }),
    JSON.stringify({ schema: 1, commands: [], contextSections: [], shell: 'touch marker' }),
  ];
  for (const contents of cases) {
    await fs.writeFile(manifest, contents);
    const result = await info(app);
    assert.ok(result.issues.some((item) => item.code === 'capabilities_invalid'));
    assert.equal(result.capabilitiesHash, null);
  }

  const outside = path.join(root, 'outside.json');
  await fs.writeFile(outside, JSON.stringify({ schema: 1, commands: [], contextSections: [] }));
  await fs.rm(manifest);
  await fs.symlink(outside, manifest);
  const linked = await info(app);
  assert.ok(linked.issues.some((item) => item.code === 'capabilities_invalid'));
  assert.equal(await fs.readFile(outside, 'utf8'),
    JSON.stringify({ schema: 1, commands: [], contextSections: [] }));
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
});

test('RE-C3-04: hash меняется с manifest и metadata, ответ не отдаёт prompt/current', async (t) => {
  const { app, profileDir, routesDir } = await fixture(t);
  const manifest = path.join(routesDir, 'editor-capabilities.json');
  const source = { schema: 1, commands: [], contextSections: [] };
  await fs.writeFile(manifest, JSON.stringify(source));
  const first = await info(app);
  const repeated = await info(app);
  assert.equal(first.capabilitiesHash, repeated.capabilitiesHash);

  await fs.writeFile(manifest, JSON.stringify({
    ...source,
    contextSections: [{ id: 'projectChecklist', label: 'Правила' }],
  }));
  const changedManifest = await info(app);
  assert.notEqual(changedManifest.capabilitiesHash, first.capabilitiesHash);

  await fs.writeFile(path.join(profileDir, 'runners.env'),
    'RUNNERS_COVERAGE=required\nPROJECT_RUNNER_PRIMARY=codex\n');
  const changedMetadata = await info(app);
  assert.notEqual(changedMetadata.capabilitiesHash, changedManifest.capabilitiesHash);
  assert.equal(JSON.stringify(changedMetadata).includes('codex'), false);
  assert.equal(JSON.stringify(changedMetadata).includes('prompt'), false);
  assert.equal(JSON.stringify(changedMetadata).includes('current.json'), false);
});

test('RE-C3-05: проект без фабричного профиля сохраняет draft без допуска публикации', async (t) => {
  const { app, profileDir } = await fixture(t, { withProfile: false });
  const created = await app.inject({
    method: 'POST',
    url: '/api/routes/sample/drafts',
    payload: { kind: 'empty', title: 'Локальный черновик' },
  });
  assert.equal(created.statusCode, 201);
  const read = await app.inject({
    method: 'GET',
    url: `/api/routes/sample/drafts/${created.json().id}`,
  });
  assert.equal(read.statusCode, 200);
  const editor = await info(app);
  assert.equal(editor.capabilitiesHash, null);
  assert.ok(editor.issues.some((issue) => issue.code === 'profileUnavailable'));
  await assert.rejects(fs.stat(profileDir), { code: 'ENOENT' });
});

test('RE-C3-06: metadata триажа указывает на удалённый route без исполнения profile.sh', async (t) => {
  const { root, app, profileDir, routesDir } = await fixture(t);
  await fs.writeFile(path.join(routesDir, 'editor-capabilities.json'), JSON.stringify({
    schema: 1,
    commands: [{
      id: 'project-check',
      label: 'Проверка проекта',
      filesystem: ['state-only'],
    }],
    contextSections: [],
  }));
  const marker = path.join(root, 'shell-marker');
  const policy = [
    'PROFILE_TRIAGE_ROUTES="feature:full=quick debug:light=legacy"',
    `touch "${marker}"`,
    '',
  ].join('\n');
  const profileScript = path.join(profileDir, 'profile.sh');
  await fs.writeFile(profileScript, policy);
  const draft = makeDraft();
  const created = await app.inject({
    method: 'POST',
    url: '/api/routes/sample/drafts',
    payload: {
      kind: 'document',
      title: 'Без legacy',
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
  const validation = await app.inject({
    method: 'POST',
    url: `/api/routes/sample/drafts/${created.json().id}/validate`,
    payload: {},
  });
  assert.equal(validation.statusCode, 200);
  assert.ok(validation.json().issues.some((issue) => issue.code === 'external_route_dependency'
    && issue.routeId === 'legacy'));
  assert.equal(await fs.readFile(profileScript, 'utf8'), policy);
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
});

test('RE-C3-07: многострочный литерал карты триажа читается без исполнения profile.sh', async (t) => {
  const { root, app, profileDir } = await fixture(t);
  const marker = path.join(root, 'shell-marker');
  const profileScript = path.join(profileDir, 'profile.sh');
  const policy = [
    '# Карта триажа в несколько строк, как у живых профилей.',
    'PROFILE_TRIAGE_ROUTES="feature:full=quick',
    'debug:light=legacy',
    'perf:full=quick"  # комментарий после литерала',
    `touch "${marker}"`,
    '',
  ].join('\n');
  await fs.writeFile(profileScript, policy);

  const editor = await info(app);

  assert.equal(editor.issues.some((issue) => issue.code === 'triage_metadata_unavailable'), false);
  assert.equal(typeof editor.capabilitiesHash, 'string');
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });

  const created = await app.inject({
    method: 'POST',
    url: '/api/routes/sample/drafts',
    payload: { kind: 'empty', title: 'Карта из нескольких строк' },
  });
  assert.equal(created.statusCode, 201);
  const validation = await app.inject({
    method: 'POST',
    url: `/api/routes/sample/drafts/${created.json().id}/validate`,
    payload: {},
  });
  assert.equal(validation.statusCode, 200);
  assert.ok(validation.json().issues.some((issue) => issue.code === 'external_route_dependency'
    && issue.routeId === 'legacy'));
});

test('RE-C3-08: подстановка в многострочной карте триажа не вычисляется', async (t) => {
  const { app, profileDir } = await fixture(t);
  for (const policy of [
    'PROFILE_TRIAGE_ROUTES="feature:full=quick\ndebug:full=$DEBUG_ROUTE"\n',
    'PROFILE_TRIAGE_ROUTES="feature:full=quick\ndebug:full=`pick`"\n',
    'PROFILE_TRIAGE_ROUTES="feature:full=quick\n',
    'PROFILE_TRIAGE_ROUTES="feature:full=quick" && pick\n',
    'PROFILE_TRIAGE_ROUTES = "feature:full=quick"\n',
  ]) {
    await fs.writeFile(path.join(profileDir, 'profile.sh'), policy);

    const editor = await info(app);

    assert.ok(editor.issues.some((issue) => issue.code === 'triage_metadata_unavailable'),
      JSON.stringify(policy));
    assert.equal(editor.capabilitiesHash, null);
  }
});
