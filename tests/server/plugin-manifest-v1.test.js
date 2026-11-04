import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeUserPluginManifest } from '../../server/src/lib/pluginsRegistry.ts';
import { manifestV1 } from '../helpers/pluginV1.js';

test('V1-SHAPE: contributes задаёт единственную панель, настройки и явный слот', () => {
  const input = manifestV1();
  const decoded = decodeUserPluginManifest(input, () => {}, '1.0.0');

  assert.deepEqual(decoded.settings, input.contributes.settings);
  assert.deepEqual(decoded.nav, {
    path: '/ext/demo',
    label: 'Панель',
    group: 'dock',
    order: 10,
  });
  assert.deepEqual(decoded.placements, [{ slot: 'provider.popover.after-bars', default: true }]);
  assert.equal(decoded.description, input.description);
  assert.equal('icon' in decoded.nav, false);
});

for (const field of ['description', 'icon', 'entrypoints', 'contributes', 'api']) {
  test(`V1-SHAPE: обязательное поле ${field} нельзя опустить`, () => {
    const input = manifestV1();

    delete input[field];
    assert.throws(() => decodeUserPluginManifest(input, () => {}, '1.0.0'));
  });
}

for (const [field, value] of [
  ['api', 2], ['description', '   '], ['description', 'я'.repeat(4097)],
  ['web', 'web'], ['webModule', {}], ['nav', {}], ['settings', []], ['placements', []],
  ['minGrigDeskVersion', '1.0.0'],
]) {
  test(`V1-SHAPE: запрещённый вход ${field}=${JSON.stringify(value).slice(0, 30)}`, () => {
    assert.throws(() => decodeUserPluginManifest(manifestV1({ [field]: value }), () => {}, '1.0.0'));
  });
}

test('V1-SHAPE: web без panels и декларации commands/themes не создают навигацию', () => {
  const input = manifestV1({ contributes: {
    commands: [{ id: 'inspect', title: 'Проверка' }],
    themes: [{ id: 'dark', title: 'Тёмная' }],
  } });
  const decoded = decodeUserPluginManifest(input, () => {}, '1.0.0');

  assert.equal(decoded.nav, null);
  assert.deepEqual(decoded.settings, []);
  assert.deepEqual(decoded.placements, []);
});

test('V1-ENGINES: minimum берётся из engines.grigdesk и сравнивается с переданной версией', () => {
  const input = manifestV1({ engines: { grigdesk: '>=1.0.0' } });

  assert.doesNotThrow(() => decodeUserPluginManifest(input, () => {}, '1.0.0'));
  assert.throws(() => decodeUserPluginManifest(input, () => {}, '0.9.9'));

  for (const minimum of ['1.0.0', '>=1.0.0 || >=2.0.0', '<2.0.0', 'broken']) {
    assert.throws(() => decodeUserPluginManifest(manifestV1({
      engines: { grigdesk: minimum },
    }), () => {}, '1.0.0'), minimum);
  }
});

test('V1-SHAPE: пустые entrypoints/contributes и описание ровно 4096 символов допустимы', () => {
  const input = manifestV1({
    entrypoints: {},
    contributes: {},
    description: 'я'.repeat(4096)
  });
  const decoded = decodeUserPluginManifest(input, () => {}, '1.0.0');

  assert.equal(decoded.description, input.description);
  assert.equal(decoded.nav, null);
  assert.deepEqual(decoded.settings, []);
  assert.deepEqual(decoded.placements, []);
});
