import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  checkCodeReadability,
  collectCodeReadability,
  compareCodeReadability,
  createCodeReadabilityBaseline,
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
