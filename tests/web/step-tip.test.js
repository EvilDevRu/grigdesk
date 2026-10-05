import assert from 'node:assert/strict';
import test from 'node:test';

import { hasStepTip, stepTip } from '../../web/src/views/chat/stepTip.ts';

const command = "cd /srv/app && rg -n 'TODO' src | head -20; echo ---; sed -n 1,80p src/main.ts | cat";
const formatted = [
  'cd /srv/app &&',
  "  rg -n 'TODO' src |",
  '  head -20',
  'echo ---',
  'sed -n 1,80p src/main.ts |',
  '  cat',
].join('\n');
const rows = [
  {
    command,
    preview: 'Проверка',
    lang: 'bash',
    title: 'Bash',
  },
  { preview: command, lang: 'bash' },
  {
    command: '',
    preview: 'Описание',
    title: 'Заголовок',
    lang: 'bash',
  },
];

test('TIP-STEP-01: команда и описание исполнителя', () => {
  assert.deepEqual(stepTip(rows[0]), {
    code: formatted,
    lang: 'bash',
    caption: 'Проверка',
  });
});

test('TIP-STEP-02: команда из preview только без ключа command', () => {
  assert.deepEqual(stepTip(rows[1]), {
    code: formatted,
    lang: 'bash',
    caption: '',
  });
});

test('TIP-STEP-03: пустая command не превращает описание в команду', () => {
  assert.deepEqual(stepTip(rows[2]), {
    code: 'Заголовок',
    lang: '',
    caption: '',
  });
});

test('TIP-STEP-04: путь только у файловых инструментов', () => {
  for (const name of ['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
    const row = {
      name,
      sub: '/full/path',
      title: 'Файл',
    };

    rows.push(row);
    assert.equal(stepTip(row).code, '/full/path');
  }

  for (const name of ['Task', 'Grep', 'Skill', 'MCP']) {
    const row = {
      name,
      sub: 'Explore',
      title: 'Заголовок',
    };

    rows.push(row);
    assert.equal(stepTip(row).code, 'Заголовок');
  }

  rows.push({
    name: 'Read',
    sub: true,
    title: 'Старая лента',
  });
  assert.equal(stepTip(rows.at(-1)).code, 'Старая лента');
});

test('TIP-STEP-05: чужие типы и пробелы не становятся текстом', () => {
  for (const value of [42, {}, true, '   ', undefined]) {
    const row = {
      command: value,
      title: value,
      sub: value,
      preview: value,
      lang: value,
    };

    rows.push(row);
    assert.equal(stepTip(row), null);
  }

  assert.equal(stepTip({ command: '  echo ok  ', preview: '  echo ok  ' }).code, '  echo ok  ');
  assert.equal(stepTip({ command: 'echo ok', preview: 'echo ok' }).caption, '');
});

test('TIP-STEP-06: дешёвая проверка совпадает с наличием справки', () => {
  for (const row of rows) {
    assert.equal(hasStepTip(row), stepTip(row) !== null);
  }
});
