import assert from 'node:assert/strict';
import test from 'node:test';

import {
  quickPermission
} from '../../web/src/shared/quickPermission.ts';

const BASH = {

  pid: 'p1',

  kind: 'perm',

  chatKey: 'c1',

  tool: 'Bash',

  input: {
    description: 'Список файлов',
    command: 'ls -la',
  },

};

test('простое разрешение: полный текст в порядке полей', () => {
  assert.deepEqual(quickPermission(BASH), {
    detail: 'Список файлов\nls -la'
  });
});

test('Q1: сложный запрос открывается только в чате', () => {
  assert.equal(quickPermission({
    ...BASH,
    kind: 'question'
  }), null);
});

test('Q2-ssh: сложный запрос открывается только в чате', () => {
  assert.equal(quickPermission({
    ...BASH,
    origin: 'ssh'
  }), null);
});

test('Q2-db: сложный запрос открывается только в чате', () => {
  assert.equal(quickPermission({
    ...BASH,
    origin: 'db'
  }), null);
});

test('Q3-tool: сложный запрос открывается только в чате', () => {
  assert.equal(quickPermission({
    ...BASH,
    tool: 'ExitPlanMode'
  }), null);
});

test('Q3-plan: сложный запрос открывается только в чате', () => {
  assert.equal(quickPermission({
    ...BASH,
    input: {
      ...BASH.input,
      plan: 'План'
    }
  }), null);
});

test('Q4-external: сложный запрос открывается только в чате', () => {
  assert.equal(quickPermission({
    ...BASH,
    input: {
      ...BASH.input,
      kind: 'external_url'
    }
  }), null);
});

test('Q4-other: сложный запрос открывается только в чате', () => {
  assert.equal(quickPermission({
    ...BASH,
    input: {
      ...BASH.input,
      kind: 'other'
    }
  }), null);
});

test('Q5-choices: сложный запрос открывается только в чате', () => {
  assert.equal(quickPermission({
    ...BASH,
    input: {
      ...BASH.input,
      choices: ['a']
    }
  }), null);
});

test('Q5-diff: сложный запрос открывается только в чате', () => {
  assert.equal(quickPermission({
    ...BASH,
    input: {
      ...BASH.input,
      diff: 'изменение'
    }
  }), null);
});

test('Q6: сложный запрос открывается только в чате', () => {
  assert.equal(quickPermission({
    ...BASH,
    input: {
      ...BASH.input,
      url: 'x'
    }
  }), null);
});

test('Q7: длинная команда требует полного чата', () => {
  assert.equal(quickPermission({
    ...BASH,
    input: {
      command: 'x'.repeat(401)
    }
  }), null);
});

test('пустые дополнительные значения не скрывают простое разрешение', () => {
  for (const extra of ['', null, undefined]) {
    assert.deepEqual(quickPermission({
      ...BASH,
      input: {
        ...BASH.input,
        extra
      }
    }), {
      detail: 'Список файлов\nls -la'
    });
  }

  assert.deepEqual(quickPermission({
    ...BASH,
    input: {}
  }), {
    detail: ''
  });
  assert.equal(quickPermission(null), null);
});
