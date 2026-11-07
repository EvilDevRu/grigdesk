import assert from 'node:assert/strict';
import test from 'node:test';

import { pluginCard } from './helpers/pluginModuleContract.js';
import { serviceFixture } from './helpers/pluginModuleServices.js';
import { settingsHarness } from './helpers/settings-harness.js';

/**
 * Внешняя панель объявляет только metadata, тест не импортирует её entry.
 * Подпись намеренно отличается от builtin ключей и имени plugin id.
 */
function panel(id, hotkey, overrides = {}) {
  return pluginCard({
    id,
    name: `Панель ${id}`,
    nav: {
      path: `/ext/${id}`,
      label: `Название ${id}`,
      group: 'dock',
      order: 90,
    },
    contributes: { panels: [{ hotkey }] },
    ...overrides,
  });
}

/**
 * Store, каталог и adapter собираются единым графом с настоящим Pinia.
 * Storage содержит только синтетические device значения, HTTP не вызывается.
 */
async function hotkeysFixture(t, saved = {}) {
  const fixture = await serviceFixture(t, 'stores/hotkeys.ts', {
    plugins: 'stores/plugins.ts',
    device: 'features/settings/resources/device.ts',
    catalog: 'shared/tools/catalog.ts',
  });

  localStorage.setItem(fixture.HOTKEYS_KEY, JSON.stringify(saved));

  const pinia = fixture.pinia.createPinia();

  fixture.pinia.setActivePinia(pinia);

  const plugins = fixture.plugins.usePluginsStore(pinia);
  const builtin = fixture.catalog.TOOL_CATALOG.filter((tool) => tool.plugin).map((tool) => ({
    id: tool.plugin,
    name: tool.label,
    system: true,
    enabled: true,
  }));

  plugins.list = [...builtin];
  plugins.loaded = true;

  return {
    ...fixture,
    plugins,
    builtin,
    hotkeys: fixture.useHotkeysStore(pinia),
  };
}

test('PH-OVERRIDES: неизвестные custom/disabled сохраняются до каталога и после удаления', async (t) => {
  const saved = { sculpt: 'Ctrl+Alt+KeyK', dormant: '' };
  const fixture = await hotkeysFixture(t, saved);
  const { hotkeys, plugins } = fixture;

  assert.deepEqual(hotkeys.overrides, saved);
  assert.equal(hotkeys.toolByCombo['Ctrl+Alt+KeyK'], undefined);
  assert.equal(hotkeys.replaceOverrides({ code: 'Ctrl+Alt+KeyB' }).ok, true);
  assert.deepEqual(hotkeys.overrides, { ...saved, code: 'Ctrl+Alt+KeyB' });
  plugins.list.push(panel('sculpt', 'Ctrl+Shift+Digit8', { enabled: false }));
  assert.equal(hotkeys.rows.find((row) => row.id === 'sculpt').label, 'Название sculpt');
  assert.equal(hotkeys.toolByCombo['Ctrl+Alt+KeyK'], undefined);
  plugins.list.at(-1).enabled = true;
  assert.equal(hotkeys.toolByCombo['Ctrl+Alt+KeyK'], 'sculpt');
  plugins.list = [...fixture.builtin];
  assert.equal(hotkeys.toolByCombo['Ctrl+Alt+KeyK'], undefined);
  assert.equal(hotkeys.replaceOverrides({ code: 'Ctrl+Alt+KeyM' }).ok, true);
  assert.equal(hotkeys.overrides.sculpt, saved.sculpt);
  assert.equal(hotkeys.overrides.dormant, '');
  plugins.list.push(panel('sculpt', 'Ctrl+Shift+Digit8'));
  assert.equal(hotkeys.toolByCombo['Ctrl+Alt+KeyK'], 'sculpt');
  assert.deepEqual(JSON.parse(localStorage.getItem(fixture.HOTKEYS_KEY)), hotkeys.overrides);
});

test('PH-COLLISIONS: explicit сильнее defaults, builtin сильнее external, external по id', async (t) => {
  const fixture = await hotkeysFixture(t);
  const { hotkeys, plugins } = fixture;
  const externalCombo = 'Ctrl+Alt+KeyG';
  const builtinCombo = fixture.DEFAULT_HOTKEYS.code;

  plugins.list.push(
    panel('zeta', externalCombo),
    panel('alpha', externalCombo),
    panel('borrowed', builtinCombo),
  );
  assert.equal(hotkeys.toolByCombo[externalCombo], 'alpha');
  assert.equal(hotkeys.toolByCombo[builtinCombo], 'code');
  assert.equal(hotkeys.rows.find((row) => row.id === 'zeta').shadowedBy, 'alpha');
  assert.equal(hotkeys.rows.find((row) => row.id === 'borrowed').shadowedBy, 'code');
  plugins.list = [...fixture.builtin, ...plugins.list.filter((item) => !item.system).reverse()];
  assert.equal(hotkeys.toolByCombo[externalCombo], 'alpha');
  assert.equal(hotkeys.toolByCombo[builtinCombo], 'code');
  assert.equal(hotkeys.replaceOverrides({ zeta: externalCombo, borrowed: builtinCombo }).ok, true);
  assert.equal(hotkeys.toolByCombo[externalCombo], 'zeta');
  assert.equal(hotkeys.toolByCombo[builtinCombo], 'borrowed');
  assert.equal(hotkeys.rows.find((row) => row.id === 'code').shadowedBy, 'borrowed');

  const rejected = hotkeys.validateOverrides({ alpha: externalCombo, zeta: externalCombo });

  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /Название alpha|Название zeta/);
  assert.equal(hotkeys.validateOverrides({ absent: externalCombo, zeta: externalCombo }).ok, false);
  assert.equal(new Set(hotkeys.bindings.map((row) => row.combo)).size, hotkeys.bindings.length);
});

test('PH-ADMISSION: disabled/incompatible/неверный default не получают binding', async (t) => {
  const fixture = await hotkeysFixture(t, { broken: 'Ctrl+Alt+KeyG' });
  const { hotkeys, plugins } = fixture;

  plugins.list.push(
    panel('sculpt', 'Ctrl+Shift+Digit8', { enabled: false }),
    panel('invalid', 'Shift+Digit8'),
    panel('noncanonical', 'Shift+Ctrl+Digit8'),
    panel('broken', 'Ctrl+Shift+Digit9', {
      compatibility: {
        status: 'incompatible',
        code: 'old',
        reason: 'Не поддерживается',
      },
    }),
  );
  assert.equal(hotkeys.toolByCombo['Ctrl+Shift+Digit8'], undefined);
  assert.equal(hotkeys.toolByCombo['Ctrl+Alt+KeyG'], undefined);
  assert.equal(hotkeys.rows.some((row) => row.id === 'sculpt'), true);
  assert.equal(hotkeys.rows.some((row) => row.id === 'broken'), false);
  plugins.list.find((item) => item.id === 'sculpt').enabled = true;
  assert.equal(hotkeys.toolByCombo['Ctrl+Shift+Digit8'], 'sculpt');
  assert.equal(hotkeys.replaceOverrides({ sculpt: '' }).ok, true);
  plugins.list.find((item) => item.id === 'sculpt').enabled = false;
  plugins.list.find((item) => item.id === 'sculpt').enabled = true;
  assert.equal(hotkeys.toolByCombo['Ctrl+Shift+Digit8'], undefined);
  assert.equal(hotkeys.overrides.sculpt, '');
  assert.equal(hotkeys.replaceOverrides({}).ok, true);
  assert.equal(hotkeys.toolByCombo['Ctrl+Shift+Digit8'], 'sculpt');
  plugins.loaded = false;
  assert.equal(hotkeys.toolByCombo['Ctrl+Shift+Digit8'], undefined);
  assert.equal(hotkeys.overrides.broken, 'Ctrl+Alt+KeyG');
});

test('PH-ADAPTER: validate и write используют metadata store, unknown остаётся в полном ACK', async (t) => {
  const fixture = await hotkeysFixture(t, { absent: 'Ctrl+Alt+KeyB', dormant: '' });
  const { hotkeys, plugins } = fixture;

  plugins.list.push(panel('sculpt', 'Ctrl+Shift+Digit8'));

  const adapter = fixture.device.createHotkeysAdapter(hotkeys, fixture.ui.uiLocale);
  const rejected = new Map([['overrides', {
    op: 'set',
    value: { sculpt: 'Ctrl+Alt+KeyK', code: 'Ctrl+Alt+KeyK' },
  }]]);

  assert.equal(adapter.validate(rejected).length, 1);

  const accepted = new Map([['overrides', {
    op: 'set',
    value: { sculpt: fixture.DEFAULT_HOTKEYS.code },
  }]]);

  assert.deepEqual(adapter.validate(accepted), []);

  const result = await adapter.write(accepted);

  assert.equal(result.status, 'success');
  assert.deepEqual(result.fields[0].serverValue, {
    sculpt: fixture.DEFAULT_HOTKEYS.code,
    absent: 'Ctrl+Alt+KeyB',
    dormant: '',
  });
  assert.equal(hotkeys.toolByCombo[fixture.DEFAULT_HOTKEYS.code], 'sculpt');
});

test('PH-SETTINGS: внешние и disabled строки видны, loser объяснён ru/en без UI import', async (t) => {
  const harness = await settingsHarness(t, 'interface.shortcuts', 'InterfacePage', {
    prepare({ plugins }) {
      plugins.list.push(
        panel('sculpt', 'Ctrl+Shift+Digit8', { enabled: false }),
        panel('borrowed', 'Ctrl+Shift+Digit1'),
      );
    },
  });
  const sculpt = harness.wrapper.find('[data-hotkey-tool="sculpt"]');
  const borrowed = harness.wrapper.find('[data-hotkey-tool="borrowed"]');

  assert.equal(sculpt.exists(), true);
  assert.match(sculpt.text(), /Название sculpt/);
  assert.match(sculpt.text(), /Плагин выключен/);
  assert.match(borrowed.text(), /умолчанию.*занято|занято.*умолчанию/);
  harness.module.setUiLocale('en');
  await harness.flushPromises();
  assert.match(borrowed.text(), /default.*used|used.*default/);
  assert.equal(harness.writes().length, 0);
  harness.module.setUiLocale('ru');
});

test('PH-STORAGE: отказ чтения и записи не теряет неизвестный override в памяти', async (t) => {
  const saved = { absent: 'Ctrl+Alt+KeyK', dormant: '' };
  const fixture = await hotkeysFixture(t, saved);

  t.mock.method(fixture.browser.localStorage, 'getItem', () => {
    throw new Error('Storage недоступен');
  });
  t.mock.method(fixture.browser.localStorage, 'setItem', () => {
    throw new Error('Storage недоступен');
  });
  assert.equal(fixture.hotkeys.replaceOverrides({ terminal: 'Ctrl+Alt+KeyJ' }).ok, true);
  fixture.hotkeys.reload();
  assert.deepEqual(fixture.hotkeys.overrides, { ...saved, terminal: 'Ctrl+Alt+KeyJ' });
  assert.equal(fixture.hotkeys.toolByCombo['Ctrl+Alt+KeyJ'], 'terminal');
  assert.equal(fixture.hotkeys.toolByCombo['Ctrl+Alt+KeyK'], undefined);
});

test('PH-DESCRIPTOR: битый entry и array-like panels не владеют combo корректной панели', async (t) => {
  const fixture = await hotkeysFixture(t);
  const { hotkeys, plugins } = fixture;
  const combo = 'Ctrl+Alt+KeyG';

  plugins.list.push(
    panel('alpha-bad-entry', combo, {
      entrypoints: {
        web: {
          entry: '/api/ext/other/module/panel.js',
          css: [],
          locales: {},
        },
      },
    }),
    panel('beta-arraylike', combo, {
      contributes: { panels: { 0: { hotkey: combo }, length: 1 } },
    }),
    panel('zeta-valid', combo),
  );
  assert.equal(hotkeys.toolByCombo[combo], 'zeta-valid');
  assert.equal(hotkeys.rows.some((row) => row.id === 'alpha-bad-entry'), false);
  assert.equal(hotkeys.rows.some((row) => row.id === 'beta-arraylike'), false);
  assert.equal(hotkeys.rows.find((row) => row.id === 'zeta-valid').shadowedBy, null);
});
