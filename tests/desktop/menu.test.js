import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applicationMenuTemplate,
  SETTINGS_ACCELERATOR,
  isSettingsShortcut,
  isReloadShortcut,
  contextMenuTemplate,
} from '../../desktop/src/menu.ts';

const labels = new Map([
  ['undo', 'Отменить'],
  ['redo', 'Повторить'],
  ['cut', 'Вырезать'],
  ['copy', 'Копировать'],
  ['paste', 'Вставить'],
  ['selectAll', 'Выделить всё'],
  ['reload', 'Обновить'],
  ['zoomIn', 'Увеличить'],
  ['zoomOut', 'Уменьшить'],
  ['resetZoom', 'Сбросить масштаб'],
  ['togglefullscreen', 'Полный экран'],
]);

function params(editFlags = {}, linkURL = '', isEditable = false) {
  return {
    editFlags: {
      canCut: false,
      canCopy: false,
      canPaste: false,
      canSelectAll: false,
      ...editFlags,
    },
    isEditable,
    linkURL,
  };
}

/**
 * Между непустыми группами допустим один разделитель, на краях его быть не должно.
 * Проверка одинакова для меню приложения и контекстных комбинаций.
 */
function checkSeparators(items) {
  assert.notEqual(items[0]?.type, 'separator');
  assert.notEqual(items.at(-1)?.type, 'separator');

  for (let index = 1; index < items.length; index += 1) {
    assert.equal(items[index].type === 'separator' && items[index - 1].type === 'separator', false);
  }
}

test('DW-25: роли и русские подписи', () => {
  const template = applicationMenuTemplate({ openSettings() {} });

  assert.deepEqual(template.map((item) => item.label), ['Файл', 'Правка', 'Вид']);
  assert.deepEqual(template[1].submenu.filter((item) => item.role).map((item) => item.role), [
    'undo',
    'redo',
    'cut',
    'copy',
    'paste',
    'selectAll',
  ]);
  assert.deepEqual(template[2].submenu.filter((item) => item.role).map((item) => item.role), [
    'zoomIn',
    'zoomOut',
    'resetZoom',
    'togglefullscreen',
  ]);

  for (const group of template.slice(1)) {
    checkSeparators(group.submenu);

    for (const item of group.submenu.filter((entry) => entry.type !== 'separator')) {
      assert.equal(item.label, labels.get(item.role));
      assert.notEqual(item.role, 'toggleDevTools');
      assert.notEqual(item.role, 'forceReload');
    }
  }
});

test('DW-26: контекстное меню без пустых разделителей', () => {
  const copied = [];
  const copyLink = (url) => copied.push(url);
  const link = 'https://example.org/path?x=1';

  assert.deepEqual(contextMenuTemplate(params(), copyLink), []);
  assert.deepEqual(contextMenuTemplate(params({ canCopy: true }), copyLink), [{
    role: 'copy',
    label: 'Копировать',
  }]);

  const editable = contextMenuTemplate(params({
    canCut: true,
    canCopy: true,
    canPaste: true,
    canSelectAll: true,
  }, '', true), copyLink);

  assert.deepEqual(editable.map((item) => item.role), ['cut', 'copy', 'paste', 'selectAll']);

  for (const item of editable) {
    assert.equal(item.label, labels.get(item.role));
  }

  const onlyLink = contextMenuTemplate(params({}, link), copyLink);

  assert.equal(onlyLink.length, 1);
  assert.equal(onlyLink[0].label, 'Копировать адрес ссылки');
  onlyLink[0].click();
  assert.deepEqual(copied, [link]);

  const combined = contextMenuTemplate(params({ canCopy: true }, link), copyLink);

  assert.deepEqual(combined.map((item) => item.role ?? item.type ?? item.label), [
    'copy',
    'separator',
    'Копировать адрес ссылки',
  ]);

  for (const items of [[], editable, onlyLink, combined]) {
    checkSeparators(items);
  }

  assert.deepEqual(contextMenuTemplate(params({}, '', true), copyLink), []);
});


test('SW-N04 Файл → Настройки…', () => {
  let calls = 0;
  const template = applicationMenuTemplate({ openSettings: () => {
      calls += 1;
    } });
  const items = template[0].submenu;

  assert.equal(items.length, 1);
  assert.equal(items[0].label, 'Настройки…');
  assert.equal(items[0].accelerator, SETTINGS_ACCELERATOR);
  assert.equal(items[0].registerAccelerator, false);
  assert.equal('role' in items[0], false);
  items[0].click();
  assert.equal(calls, 1);
});

test('SW-N05 сочетание по физической клавише', () => {
  const input = {
    type: 'keyDown',
    code: 'KeyS',
    control: true,
    alt: true,
    shift: false,
    meta: false,
  };

  assert.equal(isSettingsShortcut(input), true);

  for (const change of [
    { type: 'keyUp' }, { shift: true }, { meta: true },
    { control: false }, { alt: false }, { code: 'KeyA' },
  ]) {
    assert.equal(isSettingsShortcut({ ...input, ...change }), false);
  }
});

test('перезагрузка заблокирована по физической клавише, обычный ввод сохраняется', () => {
  const base = { code: 'KeyR', control: false, meta: false, alt: false };

  for (const input of [{ control: true }, { meta: true }, { code: 'F5' }]) {
    assert.equal(isReloadShortcut({ ...base, ...input }), true);
  }

  assert.equal(isReloadShortcut(base), false);
  assert.equal(isReloadShortcut({ ...base, code: 'KeyC', control: true }), false);
  assert.equal(isReloadShortcut({ ...base, control: true, alt: true }), false);
});
