import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodeUriComponentOrOriginal,
  jsonPointerPart,
  lexical,
  splitsUtf16Character,
  textOr,
  trimmedText,
} from '../../shared/lib/text.ts';

test('UTF-16 сохраняет границы, surrogate и исходную обработку индекса', () => {
  assert.equal(splitsUtf16Character('a😀b', 2), true);
  assert.equal(splitsUtf16Character('a😀b', 2.5), true);

  for (const at of [-1, 0, 1, 3, 4, 10, NaN, Infinity]) {
    assert.equal(splitsUtf16Character('a😀b', at), false);
  }

  assert.equal(splitsUtf16Character('\uD800x', 1), false);
  assert.equal(splitsUtf16Character('x\uDC00', 1), false);
  assert.equal(splitsUtf16Character('', 0), false);
});

test('порядок строк не зависит от локали и не сортирует числа естественным порядком', () => {
  assert.equal(lexical('10', '2'), -1);
  assert.equal(lexical('a', 'a'), 0);
  assert.equal(lexical('ё', 'я'), 1);
  assert.equal(lexical('😀', '\uE000'), -1);
});

test('нормализация текста не преобразует неизвестные значения', () => {
  assert.equal(trimmedText('  текст\n'), 'текст');
  assert.equal(textOr(' ', 'запас'), ' ');
  assert.equal(textOr('', 'запас'), '');

  for (const value of [null, undefined, 0, false, {}, ['x']]) {
    assert.equal(trimmedText(value), '');
    assert.equal(textOr(value), '');
    assert.equal(textOr(value, 'запас'), 'запас');
  }
});

test('URI и JSON Pointer сохраняют отдельные правила экранирования', () => {
  assert.equal(decodeUriComponentOrOriginal('%D1%8F%2F+a'), 'я/+a');
  assert.equal(decodeUriComponentOrOriginal('%E0%A4%A'), '%E0%A4%A');
  assert.equal(decodeUriComponentOrOriginal('%'), '%');
  assert.equal(jsonPointerPart('~/~1'), '~0~1~01');
  assert.equal(jsonPointerPart(''), '');
});
