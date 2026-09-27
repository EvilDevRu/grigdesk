import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  checkCodeReadability,
  collectCodeReadability,
  collectFilesReadability,
  compareCodeReadability,
  createCodeReadabilityBaseline,
  introducedFindings,
} from '../../web/scripts/check-code-readability.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../..');

function fixtureRepo(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-readability-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  for (const [file, source] of Object.entries(files)) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
  }
  return root;
}

test('readability baseline совпадает с текущим долгом и может только уменьшаться', () => {
  const { report, baseline, errors } = checkCodeReadability({ repoRoot: REPO_ROOT });
  assert.deepEqual(errors, []);
  assert.deepEqual(createCodeReadabilityBaseline(report), baseline);
});

test('readability guard ловит плотные blocks, members и отсутствие логических отступов', (t) => {
  const root = fixtureRepo(t, {
    'web/src/example/dense.ts': `
const options = { first: 1, second: 2, third: 3 };
function choose(value: number): number {
  const next = value + 1;
  if (next > 2) return next;
  const doubled = next * 2;
  if (doubled > 8) return doubled;
  return next;
}
`,
  });
  const errors = compareCodeReadability(
    collectCodeReadability(root),
    { version: 1, findings: {} },
  ).join('\n');

  assert.match(errors, /packed-members/);
  assert.match(errors, /unbraced-control/);
  assert.match(errors, /logical-spacing/);
  assert.match(errors, /function-explanation/);
});

test('readability guard принимает визуальные группы и содержательное пояснение', (t) => {
  const root = fixtureRepo(t, {
    'web/src/example/readable.ts': `
const options = {
  first: 1,
  second: 2,
  third: 3,
};

/**
 * Выбирает безопасное значение после двух независимых ограничений.
 * Отдельные проверки сохраняют понятный порядок правил предметной области.
 */
function choose(value: number): number {
  const next = value + 1;

  if (next > 2) {
    return next;
  }

  const doubled = next * 2;

  if (doubled > 8) {
    return doubled;
  }

  return next;
}
`,
  });

  assert.deepEqual(
    compareCodeReadability(collectCodeReadability(root), { version: 1, findings: {} }),
    [],
  );
});

// Сторож по базовой линии видит только TypeScript в web/, поэтому однострочные пояснения
// функций в сторах на JS и в сервере проходили молча. Проверка по списку файлов
// применяет те же правила к любому слою и показывает строку нарушения.
test('проверка по списку файлов видит JS, серверный TS и SFC без lang="ts"', () => {
  const store = `
/** Одна строка — этого мало для нетривиальной функции. */
export function load(store) {
  const first = store.first;
  const second = store.second;
  const sum = first + second;

  return sum;
}
`;
  const server = `
export function pick(value: number): number {
  if (value > 2) return value;
  return 0;
}
`;
  const component = `<template><div /></template>

<script setup>
function choose(value) {
  if (value) return 1;
  return 2;
}
</script>
`;
  const report = collectFilesReadability([
    { file: 'web/src/stores/example.js', source: store },
    { file: 'server/src/lib/example.ts', source: server },
    { file: 'web/src/views/Example.vue', source: component },
  ]);
  const rules = (file) => Object.keys(report.findings[file] || {}).sort();
  const lineOf = (source, text) => source.split('\n').findIndex((line) => line.includes(text)) + 1;

  assert.deepEqual(rules('web/src/stores/example.js'), ['function-explanation']);
  assert.deepEqual(
    rules('server/src/lib/example.ts'),
    ['function-explanation', 'logical-spacing', 'unbraced-control'],
  );
  assert.deepEqual(rules('web/src/views/Example.vue'), ['logical-spacing', 'unbraced-control']);
  assert.deepEqual(
    Object.values(report.locations['web/src/stores/example.js']['function-explanation']),
    [[lineOf(store, 'export function load')]],
  );
  assert.deepEqual(
    Object.values(report.locations['web/src/views/Example.vue']['unbraced-control']),
    [[lineOf(component, 'if (value) return 1')]],
    'номер строки SFC считается от начала файла, а не блока script',
  );
});

test('в изменённом файле прежний долг не мешает, а новая функция без пояснения — нарушение', () => {
  const before = `
function legacy(value) {
  if (value) return 1;
  return 2;
}
${'const long = 1; // '.padEnd(120, 'x')}
`;
  const after = `
// Сдвиг строк вниз не делает старую длинную строку новым нарушением.

function legacy(value) {
  if (value) return 1;
  return 2;
}
${'const long = 1; // '.padEnd(120, 'x')}

/** Одна строка. */
function added(value) {
  const first = value + 1;
  const second = first * 2;
  const third = second - 3;

  return third;
}
`;
  const introduced = introducedFindings(
    collectFilesReadability([{ file: 'server/src/example.ts', source: after }]),
    collectFilesReadability([{ file: 'server/src/example.ts', source: before }]),
  );

  const addedLine = after.split('\n').indexOf('function added(value) {') + 1;

  assert.deepEqual(
    introduced.map(({ file, rule, lines }) => [file, rule, lines]),
    [['server/src/example.ts', 'function-explanation', [addedLine]]],
  );
});
