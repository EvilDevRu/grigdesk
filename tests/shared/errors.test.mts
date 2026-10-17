import assert from 'node:assert/strict';
import test from 'node:test';

import { errorCode, errorMessage, errorText } from '../../shared/lib/errors.ts';

test('код ошибки принимает только строковое поле объекта', () => {
  assert.equal(errorCode(Object.assign(new Error('x'), { code: 'ENOENT' })), 'ENOENT');
  assert.equal(errorCode({ code: '' }), '');
  assert.equal(errorCode(Object.create({ code: 'inherited' })), 'inherited');

  for (const value of [null, undefined, 'ENOENT', 1, { code: 7 }, () => {}]) {
    assert.equal(errorCode(value), '');
  }
});

test('сообщение объекта и строковое представление имеют разные контракты', () => {
  assert.equal(errorMessage(new Error('текст'), 'запас'), 'текст');
  assert.equal(errorMessage({ message: 'текст' }, 'запас'), 'текст');
  assert.equal(errorMessage({ message: '' }, 'запас'), 'запас');
  assert.equal(errorMessage({ message: 12 }, 'запас'), 'запас');
  assert.equal(errorMessage('строка', 'запас'), 'запас');
  assert.equal(errorMessage(null, ''), '');
  assert.equal(errorText(new Error('')), '');
  assert.equal(errorText({ message: 'текст' }), '[object Object]');
  assert.equal(errorText(null), 'null');
  assert.equal(errorText(undefined), 'undefined');
  assert.equal(errorText(Symbol('x')), 'Symbol(x)');
});

test('ошибки getter и преобразования не подавляются', () => {
  const failure = new Error('getter');
  const value = new Proxy({}, {
    get() {
      throw failure;
    },
  });

  assert.throws(() => errorCode(value), (error) => error === failure);
  assert.throws(() => errorMessage(value, 'запас'), (error) => error === failure);
  assert.throws(() => errorText(value), (error) => error === failure);
});
