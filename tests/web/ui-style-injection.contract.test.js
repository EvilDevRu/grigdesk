import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  checkUiStyleInjection,
  collectUiStyleInjection,
  compareUiStyleInjection,
  createUiStyleInjectionBaseline,
} from '../../web/scripts/check-ui-style-injection.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../..');
const EMPTY = { version: 1, findings: {} };

function fixtureRepo(t, source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grigdesk-ui-injection-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'web/src/runtime.ts');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source);
  return root;
}

test('UI style injection: текущий baseline точен', () => {
  const { report, baseline, errors } = checkUiStyleInjection({ repoRoot: REPO_ROOT });
  assert.deepEqual(errors, []);
  assert.deepEqual(createUiStyleInjectionBaseline(report), baseline);
});

test('UI style injection: createElement(style), CSSStyleSheet и insertRule запрещены', (t) => {
  const root = fixtureRepo(t, `
    const style = document.createElement('style');
    style.textContent = '.bad { color: red }';
    const sheet = new CSSStyleSheet();
    sheet.replaceSync('.also-bad {}');
    document.styleSheets[0].insertRule('.third {}');
  `);
  const errors = compareUiStyleInjection(collectUiStyleInjection(root), EMPTY).join('\n');
  assert.match(errors, /createElement:style/);
  assert.match(errors, /style:textContent/);
  assert.match(errors, /CSSStyleSheet/);
  assert.match(errors, /runtime-style:replaceSync/);
  assert.match(errors, /runtime-style:insertRule/);
});

test('UI style injection: legacy fingerprint может только исчезнуть', (t) => {
  const root = fixtureRepo(t, `const style = document.createElement('style'); style.textContent = '.old {}';`);
  const baseline = createUiStyleInjectionBaseline(collectUiStyleInjection(root));
  fs.writeFileSync(path.join(root, 'web/src/runtime.ts'), 'export const clean = true;');
  assert.deepEqual(compareUiStyleInjection(collectUiStyleInjection(root), baseline), []);
});
