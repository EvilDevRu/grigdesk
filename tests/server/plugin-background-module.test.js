import assert from 'node:assert/strict';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { scanUserPlugins } from '../../server/src/lib/pluginsRegistry.ts';
import { validatePluginPackage } from '../../server/src/lib/packageInstall/validatePackage.ts';
import { expectedPackage, manifestV1, packageV1 } from '../helpers/pluginV1.js';
import { runtimeFixture } from './helpers/pluginRuntimeFixture.js';

const backgroundSource = 'throw new Error("Проверка не должна исполнять background");';

/**
 * Существующие server/panel ресурсы остаются валидными в каждой отрицательной проверке.
 * Меняется только новое optional объявление, поэтому отказ относится к его контракту.
 */
function backgroundManifest(background) {
  const manifest = manifestV1();

  manifest.entrypoints.web.background = background;

  return manifest;
}

for (const file of ['background.js', 'background.mjs', 'nested/фон 2.mjs']) {
  test(`PB-SCAN: background=${file}, полный URL и validator без import`, async (t) => {
    const f = await packageV1(t, backgroundManifest(file), {
      [`ui/${file}`]: backgroundSource,
    });
    const validated = await validatePluginPackage(f.dir, expectedPackage);
    const [card] = await scanUserPlugins(f.root, { warn() {} }, '1.0.0');
    const encoded = file.split('/').map(encodeURIComponent).join('/');

    assert.equal(validated.webModuleDir, 'ui');
    assert.equal(card.compatibility.status, 'compatible');
    assert.equal(card.entrypoints.web.background, `/api/ext/demo/module/${encoded}`);
  });
}

test('PB-OPTIONAL: старый v1 без background сохраняет прежнюю форму DTO', async (t) => {
  const f = await packageV1(t);
  const [card] = await scanUserPlugins(f.root, { warn() {} }, '1.0.0');

  assert.equal(Object.hasOwn(card.entrypoints.web, 'background'), false);
  assert.equal((await validatePluginPackage(f.dir, expectedPackage)).webModuleDir, 'ui');
});

for (const [label, declaration] of [
  ['absolute', '/etc/background.js'],
  ['escape', '../background.js'],
  ['scheme', 'https://outside.invalid/background.js'],
  ['query', 'background.js?outside=1'],
  ['hash', 'background.js#outside'],
  ['backslash', 'nested\\background.js'],
  ['hidden', '.hidden/background.js'],
  ['missing', 'missing.js'],
  ['typescript', 'background.ts'],
  ['json', 'background.json'],
  ['node_modules', 'node_modules/background.js'],
  ['null', null],
  ['boolean', true],
  ['number', 42],
  ['object', {}],
  ['array', ['background.js']],
]) {
  test(`PB-REFUSAL: ${label}, scanner incompatible и installer отказывает`, async (t) => {
    const f = await packageV1(t, backgroundManifest(declaration), {
      'ui/background.js': backgroundSource,
      'ui/background.ts': 'export const value: number = 1;',
      'ui/background.json': '{}',
    });
    const [card] = await scanUserPlugins(f.root, { warn() {} }, '1.0.0');

    assert.equal(card.compatibility.status, 'incompatible');
    assert.equal(card.entrypoints.web ?? null, null);
    await assert.rejects(validatePluginPackage(f.dir, expectedPackage), { code: 'manifest_invalid' });
  });
}

test('PB-ORDINARY: directory вместо background.js отвергается обоими путями', async (t) => {
  const f = await packageV1(t, backgroundManifest('background.js'));

  await mkdir(path.join(f.dir, 'ui/background.js'));

  const [card] = await scanUserPlugins(f.root, { warn() {} }, '1.0.0');

  assert.equal(card.compatibility.status, 'incompatible');
  await assert.rejects(validatePluginPackage(f.dir, expectedPackage), { code: 'manifest_invalid' });
});

for (const ancestor of [false, true]) {
  test(`PB-LINK: symlink ${ancestor ? 'предка' : 'файла'} не раскрывается`, async (t) => {
    const file = ancestor ? 'linked/background.js' : 'background.js';
    const f = await packageV1(t, backgroundManifest(file));
    const outside = path.join(f.root, 'outside');

    await mkdir(outside);
    await writeFile(path.join(outside, 'background.js'), backgroundSource);
    await symlink(ancestor ? outside : path.join(outside, 'background.js'),
      path.join(f.dir, ancestor ? 'ui/linked' : 'ui/background.js'));

    const cards = await scanUserPlugins(f.root, { warn() {} }, '1.0.0');
    const card = cards.find((item) => item.id === 'demo');

    assert.equal(card.compatibility.status, 'incompatible');
    await assert.rejects(validatePluginPackage(f.dir, expectedPackage), { code: 'symlink_forbidden' });
  });
}

test('PB-HTTP: background живёт в том же generation, auth и static проверяются повторно', async (t) => {
  const f = await runtimeFixture(t, [{
    id: 'demo',
    web: true,
    manifest: {
      entrypoints: {
        server: 'server.js',
        web: {
          dir: 'ui',
          entry: 'panel.js',
          background: 'background.js',
        },
      },
    },
    files: { 'ui/background.js': backgroundSource },
  }], { prefs: { plugins: { demo: false } } });

  assert.equal(await f.imported('demo'), false);
  assert.equal((await f.toggle('demo', true)).statusCode, 200);

  const first = await f.card('demo');
  const firstUrl = first.entrypoints.web.background;
  const prefix = first.entrypoints.web.entry.replace(/panel\.js$/u, '');

  assert.equal(firstUrl, `${prefix}background.js`);
  assert.equal(prefix, `/api/ext/demo/module/${first.runtimeGeneration}/`);
  assert.equal((await f.request('GET', firstUrl, undefined, {})).statusCode, 401);

  const resource = await f.request('GET', firstUrl);

  assert.equal(resource.statusCode, 200);
  assert.match(resource.headers['content-type'], /javascript/u);
  assert.equal(resource.body, backgroundSource);
  assert.equal((await f.toggle('demo', false)).statusCode, 200);
  assert.equal((await f.request('GET', firstUrl)).statusCode, 404);
  assert.equal((await f.toggle('demo', true)).statusCode, 200);

  const second = await f.card('demo');

  assert.notEqual(second.entrypoints.web.background, firstUrl);
  assert.equal((await f.request('GET', firstUrl)).statusCode, 404);
  assert.equal((await f.request('GET', second.entrypoints.web.background)).statusCode, 200);

  const outside = path.join(f.root, 'outside.js');

  await writeFile(outside, 'PRIVATE fixture bytes');
  await rm(path.join(f.config.userPluginsDir, 'demo/ui/background.js'));
  await symlink(outside, path.join(f.config.userPluginsDir, 'demo/ui/background.js'));

  const linked = await f.request('GET', second.entrypoints.web.background);

  assert.notEqual(linked.statusCode, 200);
  assert.equal(linked.body.includes('PRIVATE'), false);
});
