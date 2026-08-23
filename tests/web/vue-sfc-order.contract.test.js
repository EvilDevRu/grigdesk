import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  checkSfcOrder,
  collectSfcOrder,
  compareSfcOrder,
  createSfcOrderBaseline,
  describeSfcOrder,
} from '../../web/scripts/check-vue-sfc-order.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../..');
const FIXTURE_ROOT = path.join(TEST_DIR, 'fixtures/ui/sfc');

function fixture(name) {
  return fs.readFileSync(path.join(FIXTURE_ROOT, name), 'utf8');
}

function writeFixtureRepo(t, files) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-sfc-order-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  for (const [relative, source] of Object.entries(files)) {
    const target = path.join(repoRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
  }
  return repoRoot;
}

test('SFC order: exact baseline только уменьшается от исходных 55 script-first файлов', () => {
  const { report, baseline, errors } = checkSfcOrder({ repoRoot: REPO_ROOT });
  assert.deepEqual(errors, []);
  assert.deepEqual(
    createSfcOrderBaseline(report),
    baseline,
    'переставленный SFC должен быть удалён из exact baseline в той же волне',
  );
  assert.ok(baseline.legacyScriptFirst.length <= 55);
  assert.ok(report.orderViolations.length <= baseline.legacyScriptFirst.length);
});

test('SFC order: compiler offsets принимают template → script → style', () => {
  const state = describeSfcOrder(fixture('Valid.vue'), 'Valid.vue');
  assert.equal(state.valid, true);
  assert.ok(state.offsets.template < state.offsets.scripts[0]);
  assert.ok(state.offsets.scripts[0] < state.offsets.styles[0]);
});

test('SFC order: строка с <template> внутри script не обманывает compiler-sfc', () => {
  const state = describeSfcOrder(
    fixture('ScriptFirstWithTemplateLiteral.vue'),
    'ScriptFirstWithTemplateLiteral.vue',
  );
  assert.equal(state.valid, false);
  assert.match(state.reasons.join('\n'), /template.*после.*script/i);
});

test('SFC order: style перед script нарушает канонический порядок', () => {
  const state = describeSfcOrder(fixture('ScriptAfterStyle.vue'), 'ScriptAfterStyle.vue');
  assert.equal(state.valid, false);
  assert.match(state.reasons.join('\n'), /script.*после.*style/i);
});

test('SFC order: старый exact файл разрешён, новый script-first запрещён', (t) => {
  const repoRoot = writeFixtureRepo(t, {
    'web/src/views/Legacy.vue': fixture('ScriptFirst.vue'),
  });
  const baseline = createSfcOrderBaseline(collectSfcOrder(repoRoot));
  assert.deepEqual(compareSfcOrder(collectSfcOrder(repoRoot), baseline), []);

  fs.writeFileSync(path.join(repoRoot, 'web/src/views/Fresh.vue'), fixture('ScriptFirst.vue'));
  assert.ok(compareSfcOrder(collectSfcOrder(repoRoot), baseline)
    .some((error) => error.includes('новый SFC с неверным порядком')));

  fs.writeFileSync(path.join(repoRoot, 'web/src/views/Legacy.vue'), fixture('Valid.vue'));
  fs.rmSync(path.join(repoRoot, 'web/src/views/Fresh.vue'));
  assert.deepEqual(compareSfcOrder(collectSfcOrder(repoRoot), baseline), []);
});

test('SFC order: components и gallery требуют script setup lang=ts без baseline-лазейки', (t) => {
  const repoRoot = writeFixtureRepo(t, {
    'web/src/components/primitives/UiWrong.vue': fixture('ScriptFirst.vue'),
    'web/dev/ui-gallery/UiGallery.vue': `
      <template><div /></template>
      <script setup>const value = true;</script>
    `,
  });
  const report = collectSfcOrder(repoRoot);
  const forged = {
    version: 1,
    legacyScriptFirst: ['web/src/components/primitives/UiWrong.vue'],
  };
  const errors = compareSfcOrder(report, forged).join('\n');
  assert.match(errors, /components\/ не могут быть legacy-исключением/);
  assert.match(errors, /нужен <script setup lang="ts">/);
});
