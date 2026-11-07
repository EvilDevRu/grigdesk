import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { parseRouteEditorInfo } from '../../shared/pipeline/routesEditorContracts.ts';
import {
  insertRole, requireWizardCommands, sampleDirectory, seedDraft, serverFixture, validateDraftThroughApi,
} from '../fixtures/routes-stage-wizard.mjs';
import { compileModule, webFile } from '../web/helpers/compile-vue.js';

const endpoint = '/api/routes/sample/editor/stage-roles';

/**
 * Сравнивает каталожные инструкции с непосредственно прочитанными файлами образца.
 * Выбор блока не зависит от написанного тестом эталонного текста или личного профиля.
 */
async function assertCatalog(catalog, bundled) {
  assert.equal(catalog.schema, 1);
  assert.deepEqual(catalog.roles.map((role) => role.id).sort(),
    ['browser', 'command', 'custom', 'human', 'review', 'tests']);

  for (const [id, files] of Object.entries({
    review: ['review.md', 'review-fix.md'],
    tests: ['tests.md'],
    browser: ['browser.md'],
  })) {
    const role = catalog.roles.find((item) => item.id === id);

    for (const file of files) {
      const bytes = await fs.readFile(path.join(bundled, 'profile/routes/prompts', file), 'utf8');

      assert.ok(Object.values(role.prompts).includes(bytes), `Роль ${id}, bytes ${file}`);
    }
  }
}

test('SW-S1: настроенный образец проходит проверку редактора', async (t) => {
  const { app } = await serverFixture(t);
  const draft = await seedDraft();
  const report = await validateDraftThroughApi(app, draft);

  assert.deepEqual(report.issues, [], 'Все три маршрута и bootstrap проходят настоящий /validate');
});

test('SW-S2: API отдаёт только роли поставляемого образца', async (t) => {
  const { app, bundled, profileDir, root } = await serverFixture(t, { auth: true });
  const headers = { authorization: 'Bearer fixture' };
  const prompt = path.join(bundled, 'profile/routes/prompts/review.md');
  const bytes = await fs.readFile(prompt, 'utf8') + '\nИзолированный поставляемый образец.\n';

  await fs.writeFile(prompt, bytes);
  await fs.writeFile(path.join(profileDir, 'routes/prompts/review.md'), 'PRIVATE_PROFILE_PROMPT');

  const marker = path.join(root, 'profile-executed');

  await fs.writeFile(path.join(profileDir, 'profile.sh'), `printf ran > "${marker}"\nexit 91\n`);
  await fs.writeFile(path.join(profileDir, 'runners.env'), 'PROJECT_RUNNER_PRIMARY=PRIVATE_RUNNER\n');

  const denied = await app.inject({ method: 'GET', url: endpoint });

  assert.equal(denied.statusCode, 401, 'Общий auth закрывает новый API');

  const response = await app.inject({
    method: 'GET',
    url: endpoint,
    headers,
  });

  assert.equal(response.statusCode, 200, 'Нужен отдельный GET каталога ролей вместо 404');
  assert.equal(response.headers['cache-control'], 'no-store');

  const catalog = response.json();

  await assertCatalog(catalog, bundled);
  assert.equal(response.body.includes('PRIVATE_PROFILE_PROMPT'), false);
  assert.equal(response.body.includes('PRIVATE_RUNNER'), false);
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
  assert.equal(response.body.includes(root), false);
  assert.equal(response.body.includes('<profile-id>'), false);

  const decoder = await import('../../shared/pipeline/routeStageWizardContracts.ts');

  assert.deepEqual(decoder.parseStageRoleCatalog(catalog), catalog);
  assert.throws(() => decoder.parseStageRoleCatalog({ ...catalog, runtimePath: '/private' }));
  assert.throws(() => decoder.parseStageRoleCatalog({
    ...catalog, roles: [{ ...catalog.roles[0], id: 'private-role' }],
  }));

  const missing = await app.inject({
    method: 'GET',
    url: '/api/routes/unknown/editor/stage-roles',
    headers,
  });
  const editor = await app.inject({
    method: 'GET',
    url: '/api/routes/sample/editor',
    headers,
  });

  assert.equal(missing.statusCode, 404);
  assert.equal(editor.statusCode, 200);
  assert.deepEqual(parseRouteEditorInfo(editor.json()), editor.json(), 'Старый DTO не расширен');
});

test('SW-S3: каждая роль даёт валидный полный черновик', async (t) => {
  const commands = await compileModule(webFile('src/views/routes/routeCommands.ts'));

  requireWizardCommands(commands);

  const { app } = await serverFixture(t);

  for (const role of ['review', 'tests', 'browser', 'human', 'command', 'custom']) {
    const draft = await seedDraft({ minimal: true });
    const before = structuredClone(draft);
    const result = await insertRole(commands, draft, role, 'build', {
      description: 'Проверь контракт', returnTargetId: 'build',
    });

    assert.deepEqual(result.issues, [], role);
    assert.deepEqual(result.draft.routes.small, before.routes.small);
    assert.deepEqual(result.draft.routes.debug, before.routes.debug);
    assert.deepEqual(draft, before);
    assert.deepEqual((await validateDraftThroughApi(app, result.draft)).issues, [], role);
  }

  const full = await seedDraft();
  const review = await insertRole(commands, full, 'review', 'build');
  const human = await insertRole(commands, review.draft, 'human', review.createdNodeIds[0]);

  assert.deepEqual(review.issues, []);
  assert.deepEqual(human.issues, []);
  assert.deepEqual((await validateDraftThroughApi(app, human.draft)).issues, []);
});

test('SW-S4: каталог ролей строится в режиме собранного сервера', async (t) => {
  const moduleUrl = new URL('../../server/src/modules/routes/stageRoleCatalog.ts', import.meta.url);
  const exists = await fs.access(moduleUrl).then(() => true, () => false);

  assert.equal(exists, true, 'Нужен загрузчик каталога ролей для bundled runtime');

  const loader = await import(moduleUrl.href);

  assert.equal(typeof loader.loadStageRoleCatalog, 'function');

  const { root, bundled } = await serverFixture(t);
  const runtime = path.join(root, 'runtime');
  const marker = path.join(root, 'bridge-imports.jsonl');

  await fs.mkdir(path.join(runtime, 'server/runtime'), { recursive: true });
  await fs.writeFile(path.join(runtime, 'server/package.json'), '{"type":"commonjs"}');
  await fs.writeFile(path.join(runtime, 'server/runtime/esmBridge.cjs'), [
    "const fs = require('node:fs');",
    'exports.importUrl = async (url) => {',
    `  fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify(url) + '\\n');`,
    '  return import(url);',
    '};',
  ].join('\n'));

  const catalog = await loader.loadStageRoleCatalog(bundled, { kind: 'sea', root: runtime });

  await assertCatalog(catalog, bundled);

  const calls = await fs.readFile(marker, 'utf8').catch((error) => {
    assert.equal(error.code, 'ENOENT');

    return '';
  });

  if (calls) {
    assert.ok(calls.split('\n').filter(Boolean).map((line) => JSON.parse(line))
      .some((url) => url.startsWith(pathToFileURL(bundled).href)));
  } else {
    const withoutBridge = await loader.loadStageRoleCatalog(sampleDirectory, {
      kind: 'sea', root: path.join(root, 'no-bridge'),
    });

    await assertCatalog(withoutBridge, sampleDirectory);
  }
});
