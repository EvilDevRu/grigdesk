import assert from 'node:assert/strict';
import {
  readFile
} from 'node:fs/promises';
import test from 'node:test';

import {
  webFile
} from './helpers/compile-vue.js';

test('S1: оболочка ставит переходы и снимает открывалку при уходе', async () => {
  const source = await readFile(webFile('src/shared/layout/AppShell.vue'), 'utf8');

  assert.match(source, /installAlertDeepLinks\(/);
  assert.match(source, /setAlertTargetOpener\(/);
  assert.match(source, /setAlertTargetOpener\(null\)/);
});

test('P1/P2: хост после модалок и очистка при выходе', async () => {
  const source = await readFile(webFile('src/App.vue'), 'utf8');

  assert.match(source, /<DocumentModal \/>[\s\S]*<UiToastHost \/>/);
  assert.match(source, /useTaskShelfStore\(\)\.clear\(\);\s*dismissAllAlerts\(\);\s*clearAlertHistory\(\)/);
});

test('история: колокольчик стоит в верхней панели рядом с настройками', async () => {
  const source = await readFile(webFile('src/shared/layout/AppShell.vue'), 'utf8');

  assert.match(source, /<AlertHistoryPopover \/>\s*<router-link to="\/settings"/);
});
