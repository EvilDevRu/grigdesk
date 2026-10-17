// Размещения плагинов в слотах и область по исполнителям: манифест называет места,
// список отдаёт их с подписью и тумблером, сохранение принимает только заявленные слоты
// и только строки-идентификаторы исполнителей.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import {
  SYSTEM,
  normalizePlacements,
  placementsState,
} from '../../server/src/lib/pluginsRegistry.ts';
import pluginsModule from '../../server/src/modules/plugins/index.ts';
import { PLUGIN_SLOT_LABELS, PLUGIN_SLOT_NAMES, isPluginSlotName } from '../../shared/plugins/slots/index.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

async function pluginFixture(t, initial = {}) {
  let prefsData = structuredClone(initial);
  const app = Fastify({ logger: false });
  const prefs = {
    read: () => prefsData,
    write(patch) {
      prefsData = { ...prefsData, ...structuredClone(patch) };
    },
  };

  await app.register(pluginsModule, {
    config: { userPluginsDir: '/definitely/missing/plugins' },
    prefs,
  });
  t.after(() => app.close());

  return { app, readPrefs: () => prefsData };
}

test('оглавление слотов: каждое имя носит пространство своей области и имеет подпись', () => {
  assert.ok(PLUGIN_SLOT_NAMES.length >= 1);
  for (const name of PLUGIN_SLOT_NAMES) {
    assert.match(name, /^[a-z]+\.[a-z-]+(\.[a-z-]+)*$/);
    assert.ok(PLUGIN_SLOT_LABELS[name].length > 5);
  }
  assert.equal(isPluginSlotName('provider.popover.after-bars'), true);
  assert.equal(isPluginSlotName('chat.nowhere'), false);
});

test('прогноз лимитов объявлен системным плагином с размещением и областью по исполнителям', () => {
  const forecast = SYSTEM.find((plugin) => plugin.id === 'usage-forecast');

  assert.ok(forecast);
  assert.equal(forecast.defaultEnabled, true);
  assert.equal(forecast.nav, null);
  assert.deepEqual(forecast.placements, [{ slot: 'provider.popover.after-bars', default: true }]);
  assert.deepEqual(
    forecast.settings.map((setting) => [setting.key, setting.type]),
    [['providers', 'providers'], ['sampleTickMinutes', 'number']],
  );
});

test('состояние размещений: умолчание манифеста, перекрытое prefs; чужой слот отбрасывается', () => {
  const manifest = {
    id: 'demo',
    placements: [
      { slot: 'provider.popover.after-bars' },
      { slot: 'chat.nowhere', default: true },
    ],
  };

  assert.deepEqual(placementsState({}, manifest), [{
    slot: 'provider.popover.after-bars',
    label: PLUGIN_SLOT_LABELS['provider.popover.after-bars'],
    enabled: true,
  }]);
  assert.equal(
    placementsState({ pluginPlacements: { demo: { 'provider.popover.after-bars': false } } }, manifest)[0].enabled,
    false,
  );

  const warnings = [];

  assert.deepEqual(normalizePlacements([{ slot: 'provider.popover.after-bars', default: false }, { slot: 'x' }, 7],
    (message) => warnings.push(message)), [{ slot: 'provider.popover.after-bars', default: false }]);
  assert.equal(warnings.length, 2);
  assert.deepEqual(normalizePlacements('нет', (message) => warnings.push(message)), []);
  assert.equal(warnings.length, 3);
});

test('список отдаёт размещения с подписью, а сохранение пишет только заявленные слоты и область', async (t) => {
  const { app, readPrefs } = await pluginFixture(t);
  const list = (await app.inject({ method: 'GET', url: '/api/plugins' })).json().plugins;
  const forecast = list.find((plugin) => plugin.id === 'usage-forecast');

  assert.deepEqual(forecast.placements, [{
    slot: 'provider.popover.after-bars',
    label: PLUGIN_SLOT_LABELS['provider.popover.after-bars'],
    enabled: true,
  }]);
  assert.deepEqual(forecast.values.providers, []);

  const saved = await app.inject({
    method: 'PUT',
    url: '/api/plugins/usage-forecast/settings',
    payload: {
      values: {
        providers: ['codex', 7, 'codex', '', 'claude'],
        sampleTickMinutes: 30,
      },
      placements: { 'provider.popover.after-bars': false, 'chat.nowhere': true },
    },
  });

  assert.equal(saved.statusCode, 200);
  assert.deepEqual(saved.json().values.providers, ['codex', 'claude']);
  assert.equal(saved.json().values.sampleTickMinutes, 30);
  assert.deepEqual(saved.json().placements, [{
    slot: 'provider.popover.after-bars',
    label: PLUGIN_SLOT_LABELS['provider.popover.after-bars'],
    enabled: false,
  }]);
  assert.deepEqual(readPrefs().pluginPlacements, {
    'usage-forecast': { 'provider.popover.after-bars': false },
  });

  // Повторное сохранение без размещений их не трогает.
  await app.inject({
    method: 'PUT',
    url: '/api/plugins/usage-forecast/settings',
    payload: { values: { providers: [] } },
  });
  assert.deepEqual(readPrefs().pluginPlacements, {
    'usage-forecast': { 'provider.popover.after-bars': false },
  });
});

test('размещения сохраняются независимо от параметров; явный пустой values возвращает умолчания', async (t) => {
  const previous = { providers: ['claude'], sampleTickMinutes: 0 };
  const { app, readPrefs } = await pluginFixture(t, {
    pluginSettings: { 'usage-forecast': previous, demo: { keep: true } },
  });
  const response = await app.inject({
    method: 'PUT',
    url: '/api/plugins/usage-forecast/settings',
    payload: { placements: { 'provider.popover.after-bars': false } },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().values, previous);
  assert.deepEqual(app.pluginSettings('usage-forecast'), previous);
  assert.deepEqual(readPrefs().pluginSettings, { 'usage-forecast': previous, demo: { keep: true } });

  const reset = await app.inject({
    method: 'PUT',
    url: '/api/plugins/usage-forecast/settings',
    payload: { values: {} },
  });

  assert.equal(reset.statusCode, 200);
  assert.deepEqual(reset.json().values, {});
  assert.deepEqual(app.pluginSettings('usage-forecast'), {
    providers: [],
    sampleTickMinutes: 15,
  });
  assert.deepEqual(readPrefs().pluginPlacements, {
    'usage-forecast': { 'provider.popover.after-bars': false },
  });
  assert.deepEqual(readPrefs().pluginSettings.demo, { keep: true });
});
