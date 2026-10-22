import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createUiBrowser } from './helpers/ui-components.js';
import { readFile } from 'node:fs/promises';


import {
  comboFromEvent,
  comboIssue,
  formatCombo,
  isLayoutSwitch,
  normalizeCombo,
} from '../../web/src/shared/hotkeys/combo.ts';

const browser = await createUiBrowser();

const { createPinia, setActivePinia } = await import('../../web/node_modules/pinia/dist/pinia.mjs');
const { DEFAULT_HOTKEYS, HOTKEYS_KEY, useHotkeysStore } =
  await import('../../web/src/stores/hotkeys.ts');
const { TOOL_CATALOG } = await import('../../web/src/shared/tools/catalog.ts');

after(() => browser.close());

const source = (relative) => readFile(new URL(`../../${relative}`, import.meta.url), 'utf8');

function memoryStorage(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    getItem: (key) => data.has(key) ? data.get(key) : null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
    value: (key) => data.get(key),
  };
}

function installStorage(seed = {}) {
  const storage = memoryStorage(seed);
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
  setActivePinia(createPinia());
  return storage;
}

test('сочетание берётся с физической клавиши, а системные комбинации не назначаются', () => {
  assert.equal(
    comboFromEvent({ code: 'KeyK', key: 'л', altKey: true, shiftKey: true }),
    'Alt+Shift+KeyK',
    'русская раскладка не должна менять сочетание',
  );
  assert.equal(comboFromEvent({ code: 'AltLeft', altKey: true }), '', 'один модификатор — не сочетание');
  assert.equal(comboFromEvent({ code: 'Escape' }), '', 'Escape принадлежит стеку слоёв');
  assert.equal(normalizeCombo('Shift+Alt+Digit1'), 'Alt+Shift+Digit1');
  assert.equal(normalizeCombo('Alt+Alt+KeyK'), '');
  assert.equal(formatCombo('Alt+Shift+Digit1'), 'Alt + Shift + 1');

  assert.equal(comboIssue('Alt+Shift+Digit1'), '');
  assert.equal(comboIssue('Ctrl+Alt+KeyK'), '');
  assert.notEqual(comboIssue('Shift+KeyK'), '', 'без Ctrl/Alt сочетание сработает при наборе текста');
  assert.notEqual(comboIssue('Meta+KeyK'), '', 'Win/Cmd принадлежит системе');

  for (const busy of ['Ctrl+KeyW', 'Ctrl+Shift+KeyT', 'Ctrl+Digit1', 'Alt+Digit2',
    'Ctrl+Alt+KeyT', 'Alt+ArrowLeft', 'Ctrl+KeyC']) {
    assert.notEqual(comboIssue(busy), '', `${busy} перехватывает браузер или система`);
  }
});

test('сочетания по умолчанию заданы реестром и сами проходят проверку конфликтов', () => {
  const combos = TOOL_CATALOG.map((item) => item.hotkey);

  assert.equal(combos.filter(Boolean).length, TOOL_CATALOG.length, 'у каждого инструмента есть клавиша');
  assert.equal(new Set(combos).size, combos.length, 'умолчания не пересекаются между собой');
  for (const combo of combos) assert.equal(comboIssue(combo), '', `${combo} нельзя предлагать по умолчанию`);
});

test('пару Alt+Shift забирает переключатель раскладки, и человеку об этом говорят', async () => {
  for (const item of TOOL_CATALOG) {
    const parts = normalizeCombo(item.hotkey).split('+');
    const layoutToggle = parts.includes('Alt') && parts.includes('Shift') && !parts.includes('Ctrl');
    assert.equal(layoutToggle, false, `${item.hotkey}: на машине с двумя раскладками пара не дойдёт`);
  }

  assert.equal(isLayoutSwitch({ key: 'GroupNext' }), true, 'вторая клавиша пары приезжает как GroupNext');
  assert.equal(isLayoutSwitch({ key: 'ModeChange' }), true);
  assert.equal(isLayoutSwitch({ key: 'Shift' }), false, 'обычный модификатор не перехват');

  const card = await source('web/src/views/settings/pages/InterfacePage.vue');
  assert.match(card, /isLayoutSwitch\(event\)/, 'запись обязана отличать перехваченную клавишу');
});

test('назначение клавиши живёт на устройстве, отказывает дублю и различает «выключено» и «по умолчанию»', () => {
  const storage = installStorage();
  const hotkeys = useHotkeysStore();

  assert.equal(hotkeys.comboOf('code'), DEFAULT_HOTKEYS.code);
  assert.equal(hotkeys.toolByCombo[DEFAULT_HOTKEYS.terminal], 'terminal');

  assert.equal(hotkeys.replaceOverrides({ code: 'Ctrl+KeyW' }).ok, false);
  assert.equal(storage.value(HOTKEYS_KEY), undefined, 'отказ ничего не сохраняет');

  assert.equal(hotkeys.replaceOverrides({ code: 'Ctrl+Alt+KeyK' }).ok, true);
  assert.equal(hotkeys.comboOf('code'), 'Ctrl+Alt+KeyK');
  assert.deepEqual(JSON.parse(storage.value(HOTKEYS_KEY)), { code: 'Ctrl+Alt+KeyK' });

  const busy = hotkeys.replaceOverrides({ ...hotkeys.overrides, shelf: 'Ctrl+Alt+KeyK' });
  assert.equal(busy.ok, false);
  assert.match(busy.error, /Код/, 'человек должен узнать, кто занял клавишу');
  assert.equal(hotkeys.comboOf('shelf'), DEFAULT_HOTKEYS.shelf);

  hotkeys.replaceOverrides({ ...hotkeys.overrides, terminal: '' });
  assert.equal(hotkeys.comboOf('terminal'), '');
  assert.equal(hotkeys.toolByCombo[DEFAULT_HOTKEYS.terminal], undefined);
  assert.equal(hotkeys.isDefault('terminal'), false);

  hotkeys.replaceOverrides({ code: hotkeys.overrides.code });
  assert.equal(hotkeys.comboOf('terminal'), DEFAULT_HOTKEYS.terminal);
  assert.equal(hotkeys.isDefault('terminal'), true);

  hotkeys.replaceOverrides({});
  assert.equal(hotkeys.comboOf('code'), DEFAULT_HOTKEYS.code);
  assert.deepEqual(JSON.parse(storage.value(HOTKEYS_KEY)), {});
});

test('устаревшая или испорченная запись устройства не отнимает клавишу у инструмента', () => {
  installStorage({
    [HOTKEYS_KEY]: JSON.stringify({
      code: 'Ctrl+KeyW',
      shelf: '',
      terminal: 'Ctrl+Alt+KeyJ',
      nosuchtool: 'Alt+Shift+KeyZ',
    }),
  });
  const hotkeys = useHotkeysStore();

  assert.equal(hotkeys.comboOf('code'), DEFAULT_HOTKEYS.code, 'запрещённая комбинация не переживает загрузку');
  assert.equal(hotkeys.comboOf('shelf'), '', 'осознанное выключение сохраняется');
  assert.equal(hotkeys.comboOf('terminal'), 'Ctrl+Alt+KeyJ');
  assert.equal(Object.values(hotkeys.toolByCombo).includes('nosuchtool'), false);
});

test('ToolHost слушает клавиши в capture, молчит во время записи и подписывает рейку', async () => {
  const host = await source('web/src/shared/layout/ToolHost.vue');

  assert.match(host, /document\.addEventListener\('keydown', onHotkey, true\)/);
  assert.match(host, /document\.removeEventListener\('keydown', onHotkey, true\)/);
  assert.match(host, /if \(hotkeys\.recording \|\| event\.defaultPrevented/);
  assert.match(host, /hotkeys\.toolByCombo\[comboFromEvent\(event\)\]/);
  assert.match(host, /railItems\.value\.some\(\(entry\) => entry\.id === id\)/);
  assert.match(host, /event\.preventDefault\(\);\s*\n\s*event\.stopPropagation\(\);/);
  assert.match(host, /v-tooltip\.left="railTitle\(item\)"/);
});

test('страница сочетаний показывает паспорт инструментов и запись без немедленной записи', async (t) => {
  const { settingsHarness } = await import('./helpers/settings-harness.js');
  const h = await settingsHarness(t, 'interface.shortcuts', 'InterfacePage');

  assert.deepEqual(h.wrapper.findAll('[data-hotkey-tool]').map((row) => row.attributes('data-hotkey-tool')),
    TOOL_CATALOG.map((tool) => tool.id));
  await h.wrapper.get('[data-record]').trigger('click');
  assert.match(h.wrapper.text(), /Нажмите сочетание/);
  assert.equal(h.settings.snapshot.dirtyCount, 0);
});

test('SW-D04 Ctrl+Alt+S занято настройками', () => {
  installStorage({ [HOTKEYS_KEY]: JSON.stringify({ terminal: 'Ctrl+Alt+KeyS' }) });

  const hotkeys = useHotkeysStore();

  assert.match(comboIssue('Ctrl+Alt+KeyS'), /настройки/);
  assert.equal(hotkeys.replaceOverrides({ terminal: 'Ctrl+Alt+KeyS' }).ok, false);
  assert.equal(hotkeys.comboOf('terminal'), DEFAULT_HOTKEYS.terminal);
});
