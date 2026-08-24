import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  checkUiControlStyles,
  collectUiControlStyles,
  compareUiControlStyles,
  createUiControlStylesBaseline,
} from '../../web/scripts/check-ui-control-styles.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../..');
const EMPTY_BASELINE = Object.freeze({
  version: 1,
  findings: {},
});

function fixtureRepo(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-control-styles-'));

  t.after(() => fs.rmSync(root, {
    recursive: true,
    force: true,
  }));

  for (const [file, source] of Object.entries(files)) {
    const target = path.join(root, file);

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
  }

  return root;
}

test('control-style baseline точно совпадает с оставшимся legacy-долгом', () => {
  const { report, baseline, errors } = checkUiControlStyles({
    repoRoot: REPO_ROOT,
  });

  assert.deepEqual(errors, []);
  assert.deepEqual(
    createUiControlStylesBaseline(report),
    baseline,
    'baseline уменьшается только вместе с удалёнными локальными control styles',
  );
});

test('consumer не может заново оформить Ui-контрол локальным CSS', (t) => {
  const root = fixtureRepo(t, {
    'web/src/views/FreshView.vue': `
      <template><UiButton class="fresh-action">Запустить</UiButton></template>
      <script setup>const UiButton = {};</script>
      <style scoped>.fresh-action { background: red; padding: 2px; }</style>
    `,
  });
  const errors = compareUiControlStyles(
    collectUiControlStyles(root),
    EMPTY_BASELINE,
  ).join('\n');

  assert.match(errors, /новый control style/);
  assert.match(errors, /\.fresh-action/);
});

test('layout-обёртка вокруг Ui-контрола остаётся доменной ответственностью', (t) => {
  const root = fixtureRepo(t, {
    'web/src/views/FreshView.vue': `
      <template><div class="actions"><UiButton>Запустить</UiButton></div></template>
      <script setup>const UiButton = {};</script>
      <style scoped>.actions { display: flex; gap: 8px; margin-top: 4px; }</style>
    `,
  });

  assert.deepEqual(
    compareUiControlStyles(collectUiControlStyles(root), EMPTY_BASELINE),
    [],
  );
});

test('удалённый web/src/styles.css нельзя вернуть даже пустым файлом', (t) => {
  const root = fixtureRepo(t, {
    'web/src/styles.css': '',
  });
  const errors = compareUiControlStyles(
    collectUiControlStyles(root),
    EMPTY_BASELINE,
  ).join('\n');

  assert.match(errors, /legacy CSS entry запрещён/u);
});
