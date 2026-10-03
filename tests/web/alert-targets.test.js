import assert from 'node:assert/strict';
import test from 'node:test';

import {
  alertTargetHash,
  alertTargetLabel,
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
