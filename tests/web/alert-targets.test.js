import assert from 'node:assert/strict';
import test from 'node:test';

import {
  alertTargetHash,
  alertTargetLabel,
  alertTargetMessage,
  firstQueryValue
} from '../../web/src/shared/alertTargets.ts';

test('цели: три адреса и кодирование id', () => {
  assert.equal(alertTargetHash({
    kind: 'chat',
    chatId: 'c #1'
  }), '#/chats?openChat=c%20%231');
  assert.equal(alertTargetHash({
    kind: 'pipeline',
    taskId: '42'
  }), '#/pipeline');
  assert.equal(alertTargetHash({
    kind: 'task',
    taskId: 't #2'
  }), '#/shelf?openTask=t%20%232');
});

test('цели: подписи быстрых переходов', () => {
  assert.equal(alertTargetLabel({
    kind: 'chat',
    chatId: 'c1'
  }), 'Открыть чат');
  assert.equal(alertTargetLabel({
    kind: 'pipeline',
    taskId: '42'
  }), 'Открыть конвейер');
  assert.equal(alertTargetLabel({
    kind: 'task',
    taskId: '42'
  }), 'Открыть задачу');
});

test('query: первый строковый элемент и пустые значения', () => {
  assert.equal(firstQueryValue(' c1 '), 'c1');
  assert.equal(firstQueryValue(['c2', 'c3']), 'c2');
  assert.equal(firstQueryValue([1, ' c4 ']), 'c4');

  for (const value of [
      [1], undefined, null, 7
    ]) {
    assert.equal(firstQueryValue(value), '');
  }
});

test('цель studio ведёт к версии и называет модель', () => {
  const target = {
    kind: 'studio',
    modelId: 'model #1',
    versionId: 'v01-model'
  };

  assert.equal(alertTargetHash(target), '#/3d?model=model%20%231&version=v01-model');
  assert.equal(alertTargetLabel(target), 'Открыть модель');
});

test('PM-PLUGIN-TARGET: системный адрес кодирует pluginId', () => {
  assert.equal(alertTargetHash({ kind: 'plugin', pluginId: 'a #/b' }), '#/ext/a%20%23%2Fb');
});

test('PM-PLUGIN-TARGET: подпись открытия панели переведена в общем каталоге RU/EN', () => {
  const target = { kind: 'plugin', pluginId: 'ui-module' };

  assert.equal(typeof alertTargetMessage(target).key, 'string',
    'Не определена подпись открытия панели плагина');
  assert.equal(alertTargetLabel(target, 'ru'), 'Открыть панель');
  assert.equal(alertTargetLabel(target, 'en'), 'Open panel');
});
