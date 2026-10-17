import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import { createPinia, setActivePinia } from '../../web/node_modules/pinia/dist/pinia.mjs';
import {
  comboFromEvent,
  comboIssue,
  formatCombo,
  isLayoutSwitch,
  normalizeCombo,
} from '../../web/src/shared/hotkeys/combo.ts';
import { DEFAULT_HOTKEYS, HOTKEYS_KEY, useHotkeysStore } from '../../web/src/stores/hotkeys.js';
import { TOOL_CATALOG } from '../../web/src/shared/tools/catalog.ts';

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

  const card = await source('web/src/views/settings/ToolHotkeys.vue');
  assert.match(card, /isLayoutSwitch\(event\)/, 'запись обязана отличать перехваченную клавишу');
});

test('назначение клавиши живёт на устройстве, отказывает дублю и различает «выключено» и «по умолчанию»', () => {
  const storage = installStorage();
  const hotkeys = useHotkeysStore();

  assert.equal(hotkeys.comboOf('code'), DEFAULT_HOTKEYS.code);
  assert.equal(hotkeys.toolByCombo[DEFAULT_HOTKEYS.terminal], 'terminal');

  assert.deepEqual(hotkeys.assign('code', 'Ctrl+KeyW').ok, false, 'системную комбинацию не берём');
  assert.equal(storage.value(HOTKEYS_KEY), undefined, 'отказ ничего не сохраняет');

  assert.equal(hotkeys.assign('code', 'Ctrl+Alt+KeyK').ok, true);
  assert.equal(hotkeys.comboOf('code'), 'Ctrl+Alt+KeyK');
  assert.deepEqual(JSON.parse(storage.value(HOTKEYS_KEY)), { code: 'Ctrl+Alt+KeyK' });

  const busy = hotkeys.assign('shelf', 'Ctrl+Alt+KeyK');
  assert.equal(busy.ok, false);
  assert.match(busy.error, /Код/, 'человек должен узнать, кто занял клавишу');
  assert.equal(hotkeys.comboOf('shelf'), DEFAULT_HOTKEYS.shelf);

  hotkeys.disable('terminal');
  assert.equal(hotkeys.comboOf('terminal'), '');
  assert.equal(hotkeys.toolByCombo[DEFAULT_HOTKEYS.terminal], undefined);
  assert.equal(hotkeys.isDefault('terminal'), false);

  hotkeys.restore('terminal');
  assert.equal(hotkeys.comboOf('terminal'), DEFAULT_HOTKEYS.terminal);
  assert.equal(hotkeys.isDefault('terminal'), true);

  hotkeys.resetAll();
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

test('настройка клавиш открыта в разделе устройства и не заводит второй источник состава', async () => {
  const [settings, card, store] = await Promise.all([
    source('web/src/views/SettingsView.vue'),
    source('web/src/views/settings/ToolHotkeys.vue'),
    source('web/src/stores/hotkeys.js'),
  ]);

  assert.match(settings, /import ToolHotkeys from '\.\/settings\/ToolHotkeys\.vue';/);
  assert.match(settings, /<ToolHotkeys \/>/);
  assert.match(card, /TOOL_CATALOG\.map\(/, 'список строк берётся из паспорта инструментов');
  assert.match(card, /window\.addEventListener\('keydown', onRecordKey, true\)/);
  assert.match(card, /event\.key === 'Escape'/);
  assert.doesNotMatch(card, /<button|<input/, 'контролы приходят только из общей границы UI');

  // Паспорт инструментов отделён от панелей ровно ради этого: настройка и store читают
  // список, не втягивая Monaco и терминал в свой граф загрузки.
  for (const text of [card, store]) {
    assert.doesNotMatch(text, /tools\/registry\.ts/, 'списка панелей здесь быть не должно');
    assert.match(text, /tools\/catalog\.ts/);
  }
});


test('SW-D04 Ctrl+Alt+S занято настройками', () => {
  installStorage({ [HOTKEYS_KEY]: JSON.stringify({ terminal: 'Ctrl+Alt+KeyS' }) });

  const hotkeys = useHotkeysStore();

  assert.match(comboIssue('Ctrl+Alt+KeyS'), /настройки/);
  assert.equal(hotkeys.assign('terminal', 'Ctrl+Alt+KeyS').ok, false);
  assert.equal(hotkeys.comboOf('terminal'), DEFAULT_HOTKEYS.terminal);
});
