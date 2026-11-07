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
  describeSfcOrder,
} from '../../web/scripts/check-vue-sfc-order.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../..');
const FIXTURE_ROOT = path.join(TEST_DIR, 'fixtures/ui/sfc');

function fixture(name) {
  return fs.readFileSync(path.join(FIXTURE_ROOT, name), 'utf8');
}

function writeFixtureRepo(t, files) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'grigdesk-sfc-order-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  for (const [relative, source] of Object.entries(files)) {
    const target = path.join(repoRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
  }
  return repoRoot;
}

test('SFC order: все production и gallery SFC соблюдают канонический порядок', () => {
  const { report, errors } = checkSfcOrder({ repoRoot: REPO_ROOT });
  assert.deepEqual(errors, []);
  assert.deepEqual(report.orderViolations, []);
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

test('SFC order: любой script-first файл запрещён без переходных исключений', (t) => {
  const repoRoot = writeFixtureRepo(t, {
    'web/src/views/Wrong.vue': fixture('ScriptFirst.vue'),
  });
  assert.ok(compareSfcOrder(collectSfcOrder(repoRoot))
    .some((error) => error.includes('неверный порядок блоков')));

  fs.writeFileSync(path.join(repoRoot, 'web/src/views/Wrong.vue'), fixture('Valid.vue'));
  assert.deepEqual(compareSfcOrder(collectSfcOrder(repoRoot)), []);
});

test('SFC order: components и gallery требуют script setup lang=ts', (t) => {
  const repoRoot = writeFixtureRepo(t, {
    'web/src/components/primitives/UiWrong.vue': fixture('ScriptFirst.vue'),
    'web/dev/ui-gallery/UiGallery.vue': `
      <template><div /></template>
      <script setup>const value = true;</script>
    `,
  });
  const report = collectSfcOrder(repoRoot);
  const errors = compareSfcOrder(report).join('\n');
  assert.match(errors, /неверный порядок блоков/);
  assert.match(errors, /нужен <script setup lang="ts">/);
});
