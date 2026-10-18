import assert from 'node:assert/strict';
import test from 'node:test';
import { searchSettings } from '../../web/src/features/settings/search.ts';

const address = {
  pageId: 'agents.providers',
  entityId: 'a/b',
  tabId: 'parameters',
  fieldPath: ['x.y', 'z/w'],
};

test('SE01: регистр, внешние пробелы, ё/е, путь и явные синонимы', () => {
  for (const query of ['  КЛАВИШИ ', 'сочетания', 'hotkey']) {
    assert.equal(searchSettings(query).some((item) => item.pageId === 'interface.shortcuts'), true);
  }

  assert.equal(searchSettings('Чаты и конвейер Контекст').some((item) =>
    item.pageId === 'automation.context'), true);
  assert.equal(searchSettings('ежик', [{
    address,
    label: 'Ёжик',
    description: 'Публичная подпись',
  }])
    .some((item) => item.address?.entityId === 'a/b'), true);
});

test('SE04/SE05 (guard): чистый поиск индексирует только публичные метаданные', () => {
  const fields = [{
    address,
    label: 'Лимит ответа',
    description: 'Размер результата',
    value: 'value-only-marker',
    secret: 'secret-only-marker',
  }];

  assert.deepEqual(searchSettings('value-only-marker', fields), []);
  assert.deepEqual(searchSettings('secret-only-marker', fields), []);
  assert.deepEqual(searchSettings('Лимит ответа', fields)[0].address, address);
  assert.equal(JSON.stringify(searchSettings('Лимит ответа', fields)).includes('marker'), false);
});

test('SE06: незагруженный доступный каталог объясняет продолжение поиска', () => {
  const fields = [{
    address,
    label: 'Дополнительные параметры исполнителя Alpha',
    description: 'Поиск продолжится после загрузки параметров',
    load: true,
  }];

  assert.equal(searchSettings('неизвестное поле', fields)[0].load, true);
  assert.match(searchSettings('неизвестное поле', fields)[0].description, /после загрузки/);
  assert.deepEqual(searchSettings('неизвестное поле', [{ ...fields[0], available: false }]), []);
  assert.deepEqual(searchSettings('', fields), []);
});
