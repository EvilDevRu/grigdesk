import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  checkUiDependencyBoundary,
  collectUiDependencyBoundary,
  compareUiDependencyBoundary,
  createUiDependencyBoundaryBaseline,
} from '../../web/scripts/check-ui-dependency-boundary.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../..');
const EMPTY = { version: 1, legacyDeepImports: [] };

function fixtureRepo(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grigdesk-ui-deps-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, source] of Object.entries(files)) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
  }
  return root;
}

test('UI dependencies: текущий exact compatibility baseline не вырос', () => {
  const { report, baseline, errors } = checkUiDependencyBoundary({ repoRoot: REPO_ROOT });
  assert.deepEqual(errors, []);
  assert.deepEqual(createUiDependencyBoundaryBaseline(report), baseline);
});

test('UI dependencies: product consumer импортирует UI только через ui.ts', (t) => {
  const root = fixtureRepo(t, {
    'web/src/views/BadView.vue': `<template><div /></template><script setup lang="ts">
      import UiButton from '../components/primitives/UiButton.vue';
    </script>`,
  });
  assert.match(compareUiDependencyBoundary(collectUiDependencyBoundary(root), EMPTY).join('\n'), /обходит web\/src\/ui\.ts/);
});

test('UI dependencies: UI-kit не знает stores/domain, UiFileInput остаётся private', (t) => {
  const root = fixtureRepo(t, {
    'web/src/components/primitives/UiBad.vue': `<template><div /></template><script setup lang="ts">
      import { useAuth } from '../../stores/auth.ts';
    </script>`,
    'web/src/components/composites/UiWrong.vue': `<template><div /></template><script setup lang="ts">
      import UiFileInput from '../primitives/UiFileInput.vue';
    </script>`,
    'web/src/ui.ts': `export { default as UiFileInput } from './components/primitives/UiFileInput.vue';`,
  });
  const errors = compareUiDependencyBoundary(collectUiDependencyBoundary(root), EMPTY).join('\n');
  assert.match(errors, /product dependency/);
  assert.match(errors, /private UiFileInput/);
  assert.match(errors, /не должен экспортировать private UiFileInput/);
});

test('UI dependencies: удаление legacy deep import разрешено, новый exact путь нет', (t) => {
  const root = fixtureRepo(t, {
    'web/src/shared/ui/Legacy.vue': `<template><div /></template><script setup lang="ts">
      import UiButton from '../../components/primitives/UiButton.vue';
    </script>`,
  });
  const before = collectUiDependencyBoundary(root);
  const baseline = createUiDependencyBoundaryBaseline(before);
  assert.deepEqual(compareUiDependencyBoundary(before, baseline), []);
  fs.writeFileSync(path.join(root, 'web/src/shared/ui/Legacy.vue'), '<template><div /></template><script setup lang="ts"></script>');
  assert.deepEqual(compareUiDependencyBoundary(collectUiDependencyBoundary(root), baseline), []);
});

test('UI dependencies: сервис тостов закрыт публичной границей', (t) => {
  const root = fixtureRepo(t, {
    'web/src/shared/BadAlerts.ts': "import { showToast } from '../services/toasts';",
  });
  const errors = compareUiDependencyBoundary(collectUiDependencyBoundary(root), EMPTY);

  assert.match(errors.join('\n'), /обходит web\/src\/ui\.ts/);
});

test('TIP-WIRE-03: product не импортирует приватный сервис подсказок', () => {
  const report = {
    parseErrors: [],
    imports: [{
      file: 'web/src/views/BadView.ts',
      specifier: '../services/tooltips',
      target: 'web/src/services/tooltips',
    }],
  };

  assert.match(compareUiDependencyBoundary(report, EMPTY).join('\n'), /обходит web\/src\/ui\.ts/);
});
