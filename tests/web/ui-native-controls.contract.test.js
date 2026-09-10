import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  checkUiBoundary,
  collectUiBoundary,
  compareUiBoundary,
} from '../../web/scripts/check-ui-boundary.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../..');
const FIXTURE_ROOT = path.join(TEST_DIR, 'fixtures/ui');

function writeFixtureRepo(t, files) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-ui-boundary-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  for (const [relative, source] of Object.entries(files)) {
    const target = path.join(repoRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
  }
  return repoRoot;
}

function countFindings(map) {
  return Object.values(map)
    .flatMap((kinds) => Object.values(kinds))
    .reduce((sum, finding) => sum + finding.count, 0);
}

test('UI boundary: production-граф не содержит переходного UI-долга', () => {
  const { report, errors } = checkUiBoundary({ repoRoot: REPO_ROOT });
  assert.deepEqual(errors, []);
  assert.equal(countFindings(report.nativeTemplateControls), 0);
  assert.equal(countFindings(report.scriptControls), 0);
  assert.equal(countFindings(report.nonSemanticActivations), 0);
  assert.deepEqual(report.structural.legacySharedUiFiles, []);
});

test('UI boundary: комментарии не считаются, а raw control запрещён', (t) => {
  const source = fs.readFileSync(path.join(FIXTURE_ROOT, 'boundary/LegacyControl.vue'), 'utf8');
  const repoRoot = writeFixtureRepo(t, { 'web/src/views/LegacyView.vue': source });
  const report = collectUiBoundary(repoRoot);
  assert.equal(countFindings(report.nativeTemplateControls), 1);
  assert.match(compareUiBoundary(report).join('\n'), /нативные template-контролы/);
});

test('UI boundary: удаление raw control чинит guard, новый сразу его ломает', (t) => {
  const source = fs.readFileSync(path.join(FIXTURE_ROOT, 'boundary/LegacyControl.vue'), 'utf8');
  const repoRoot = writeFixtureRepo(t, { 'web/src/views/LegacyView.vue': source });
  assert.ok(compareUiBoundary(collectUiBoundary(repoRoot)).length > 0);

  fs.writeFileSync(
    path.join(repoRoot, 'web/src/views/LegacyView.vue'),
    source.replace('<button class="legacy-control" type="button">Старый контрол</button>', '<span>Готово</span>'),
  );
  assert.deepEqual(compareUiBoundary(collectUiBoundary(repoRoot)), []);

  const fresh = path.join(repoRoot, 'web/src/views/FreshView.vue');
  fs.writeFileSync(fresh, '<template><input /></template><script setup></script>\n');
  assert.ok(compareUiBoundary(collectUiBoundary(repoRoot))
    .some((error) => error.includes('web/src/views/FreshView.vue input')));
});

test('UI boundary: AST ловит native dialogs, createElement и render controls', (t) => {
  const repoRoot = writeFixtureRepo(t, {
    'web/src/features/programmatic.ts': `
      confirm('one');
      window.prompt('two');
      globalThis.alert('three');
      service.confirm('не системный вызов');
      document.createElement('input');
      h('button');
      createVNode('select');
    `,
  });
  const errors = compareUiBoundary(collectUiBoundary(repoRoot)).join('\n');
  assert.match(errors, /system:confirm/);
  assert.match(errors, /system:prompt/);
  assert.match(errors, /system:alert/);
  assert.match(errors, /createElement:input/);
  assert.match(errors, /h:button/);
  assert.match(errors, /createVNode:select/);
  assert.doesNotMatch(errors, /service\.confirm/);
});

test('UI boundary: clipboard exception точный и не скрывает второй control', (t) => {
  const repoRoot = writeFixtureRepo(t, {
    'web/src/shared/clipboard.ts': 'document.createElement("textarea");\n',
  });
  assert.deepEqual(compareUiBoundary(collectUiBoundary(repoRoot)), []);

  fs.appendFileSync(
    path.join(repoRoot, 'web/src/shared/clipboard.ts'),
    'document.createElement("textarea");\ndocument.createElement("button");\n',
  );
  const errors = compareUiBoundary(collectUiBoundary(repoRoot)).join('\n');
  assert.match(errors, /ровно один/);
  assert.match(errors, /createElement:button/);
});

test('UI boundary: role=button не обходит запрет non-semantic activation', (t) => {
  const repoRoot = writeFixtureRepo(t, {
    'web/src/views/ManualButton.vue': `
      <template><div role="button" tabindex="0" @click="run">Run</div></template>
      <script setup>const run = () => {};</script>
    `,
  });
  const errors = compareUiBoundary(collectUiBoundary(repoRoot)).join('\n');
  assert.match(errors, /несемантическая активация/);
  assert.match(errors, /click:div/);
});

test('UI boundary: structural boundary закрывает обходные каталоги и UiPressable consumers', (t) => {
  const component = '<template><span /></template><script setup lang="ts"></script>\n';
  const repoRoot = writeFixtureRepo(t, {
    'web/src/features/UiBad.vue': component,
    'web/src/components/ui/UiNested.vue': component,
    'web/src/components/private.ts': 'export const bad = true;\n',
    'web/src/shared/ui/NewWrapper.vue': component,
    'web/src/rogue.css': '.rogue {}\n',
    'web/dev/ui-gallery/rogue.css': '.rogue-dev {}\n',
    'web/src/views/WrongPressable.vue': '<template><UiPressable /></template><script setup></script>\n',
  });
  const errors = compareUiBoundary(collectUiBoundary(repoRoot)).join('\n');
  assert.match(errors, /Ui\*\.vue вне components/);
  assert.match(errors, /запрещён components\/ui/);
  assert.match(errors, /не-SFC файл в components/);
  assert.match(errors, /запрещён shared\/ui/);
  assert.match(errors, /global CSS вне styles/);
  assert.match(errors, /pressable allowlist/);
});
