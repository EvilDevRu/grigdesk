import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isPlainRecord,
  isRecord,
  objectOrEmpty,
  recordOrEmpty,
  recordOrNull,
} from '../../shared/lib/objects.ts';

test('проверки объектов различают прототипы, массивы и примитивы', () => {
  const plain = {};
  const withoutPrototype = Object.create(null);
  const instance = new Date(0);
  const array: unknown[] = [];

  for (const value of [plain, withoutPrototype]) {
    assert.equal(isPlainRecord(value), true);
    assert.equal(isRecord(value), true);
  }

  assert.equal(isPlainRecord(instance), false);
  assert.equal(isRecord(instance), true);

  for (const value of [null, undefined, false, 0, '', 1n, Symbol('x'), () => {}, array]) {
    assert.equal(isPlainRecord(value), false);
    assert.equal(isRecord(value), false);
  }
});

test('преобразования сохраняют ссылку и исходную политику массивов', () => {
  const value = { answer: 42 };
  const array = [1];

  assert.equal(objectOrEmpty(value), value);
  assert.equal(recordOrEmpty(value), value);
  assert.equal(recordOrNull(value), value);
  assert.equal(objectOrEmpty(array), array);
  assert.deepEqual(recordOrEmpty(array), {});
  assert.equal(recordOrNull(array), null);

  for (const invalid of [null, undefined, 0, false, '', () => {}]) {
    assert.deepEqual(objectOrEmpty(invalid), {});
    assert.deepEqual(recordOrEmpty(invalid), {});
    assert.equal(recordOrNull(invalid), null);
  }

  assert.notEqual(objectOrEmpty(null), objectOrEmpty(null));
  assert.notEqual(recordOrEmpty(null), recordOrEmpty(null));
});

test('проверка прототипа сохраняет ошибку proxy и не читает поля объекта', () => {
  const failure = new Error('prototype');
  const value = new Proxy({}, {
    getPrototypeOf() {
      throw failure;
    },
    get() {
      throw new Error('поле не должно читаться');
    },
  });

  assert.equal(isRecord(value), true);
  assert.equal(objectOrEmpty(value), value);
  assert.throws(() => isPlainRecord(value), (error) => error === failure);
});
