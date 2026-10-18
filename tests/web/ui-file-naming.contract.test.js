import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  checkUiFileNaming,
  collectUiFileNaming,
  compareUiFileNaming,
  createUiFileNamingBaseline,
} from '../../web/scripts/check-ui-file-naming.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../..');

function fixtureRepo(t, names) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grigdesk-ui-naming-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of names) {
    const target = path.join(root, 'web/src/example', name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, name.endsWith('.vue') ? '<template><div /></template>' : 'export {};');
  }
  return root;
}

test('UI filename rule: текущий shrinking baseline точен', () => {
  const { report, baseline, errors } = checkUiFileNaming({ repoRoot: REPO_ROOT });
  assert.deepEqual(errors, []);
  assert.deepEqual(createUiFileNamingBaseline(report), baseline);
});

test('UI filename rule: Vue PascalCase, TS lowerCamelCase; role suffix обрабатывается отдельно', (t) => {
  const root = fixtureRepo(t, [
    'GoodView.vue', 'bad-view.vue', 'main.ts', 'goodName.ts', 'bad-name.ts',
    'env.d.ts', 'vite.config.ts', 'uiButton.test.ts',
  ]);
  const report = collectUiFileNaming(root);
  assert.deepEqual(report.invalid, [
    'web/src/example/bad-name.ts',
    'web/src/example/bad-view.vue',
  ]);
});

test('UI filename rule: существующее kebab-name живёт только в shrinking baseline', (t) => {
  const root = fixtureRepo(t, ['legacy-name.ts']);
  const baseline = createUiFileNamingBaseline(collectUiFileNaming(root));
  assert.deepEqual(compareUiFileNaming(collectUiFileNaming(root), baseline), []);
  fs.writeFileSync(path.join(root, 'web/src/example/new-name.ts'), 'export {};');
  assert.match(compareUiFileNaming(collectUiFileNaming(root), baseline).join('\n'), /new-name\.ts/);
  fs.rmSync(path.join(root, 'web/src/example/legacy-name.ts'));
  assert.match(compareUiFileNaming(collectUiFileNaming(root), baseline).join('\n'), /new-name\.ts/);
});
