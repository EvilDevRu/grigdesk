import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { compileModule, webFile } from './helpers/compile-vue.js';
import { createUiBrowser } from './helpers/ui-components.js';

let browser;
let api;

before(async () => {
  browser = await createUiBrowser();
  api = await compileModule(webFile('src/composables/useUiFieldSelect.ts'));
});

after(async () => {
  await browser?.close();
});

test('SELECT-DATA-01: группы, disabled и скрытые варианты сохраняют реальные индексы', () => {
  const select = browser.document.createElement('select');

  select.innerHTML = [
    '<option value="">Без выбора</option>',
    '<optgroup label="Провайдер — недоступен">',
    '<option value="repo/model" title="Полное описание">Модель</option>',
    '</optgroup>',
    '<optgroup label="Закрытая группа" disabled>',
    '<option value="locked">Запрещено</option>',
    '</optgroup>',
    '<option value="secret" hidden>Скрыто</option>',
  ].join('');

  const rows = api.readUiSelectOptions(select);

  assert.deepEqual(rows.map((row) => row.index), [0, 1, 2]);
  assert.equal(rows[1].groupLabel, 'Провайдер — недоступен');
  assert.equal(rows[1].disabled, false);
  assert.equal(rows[1].label, 'Модель');
  assert.equal(rows[1].description, 'Полное описание');
  assert.equal(rows[2].disabled, true);
  assert.equal(api.filterUiSelectOptions(rows, 'REPO/MODEL')[0].index, 1);
  assert.equal(api.filterUiSelectOptions(rows, 'недоступен')[0].index, 1);
  assert.equal(api.filterUiSelectOptions(rows, 'описание')[0].index, 1);
  assert.equal(api.filterUiSelectOptions(rows, 'нет результата').length, 0);
  assert.equal(rows.length, 3);
});

test('SELECT-DATA-02: пустота и number/trim повторяют существующий контракт', () => {
  assert.equal(api.normalizeUiSelectValue('', { number: true }), '');
  assert.equal(api.normalizeUiSelectValue('0', { number: true }), 0);
  assert.equal(api.normalizeUiSelectValue('2.5', { number: true }), 2.5);
  assert.equal(api.normalizeUiSelectValue('2', {}), '2');
  assert.equal(api.normalizeUiSelectValue(' x ', { trim: true }), 'x');
  assert.equal(api.normalizeUiSelectValue('unknown', { number: true }), 'unknown');
});

test('SELECT-DATA-03: отдельная подсказка ищется независимо от короткого описания', () => {
  const select = browser.document.createElement('select');

  select.innerHTML = '<option value="copy" data-description="dev" title="/work/project">Основная</option>';

  const rows = api.readUiSelectOptions(select);

  assert.equal(rows[0].description, 'dev');
  assert.equal(rows[0].title, '/work/project');
  assert.equal(api.filterUiSelectOptions(rows, '/WORK/PROJECT')[0].value, 'copy');
  assert.equal(api.filterUiSelectOptions(rows, 'dev')[0].value, 'copy');
});
