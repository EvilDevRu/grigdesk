import assert from 'node:assert/strict';
import {
  readFile
} from 'node:fs/promises';
import test from 'node:test';

import { shellContractBrowser } from './helpers/shell-contract-browser.js';

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

  const clearOnBrowserLogout = [...source.matchAll(/if \(!shell\.present\) \{([\s\S]*?)\n  \}/g)]
    .find((match) => match[1].includes('useTaskFavoritesStore'));

  assert.ok(clearOnBrowserLogout);
  assert.match(clearOnBrowserLogout[1], /useTaskFavoritesStore\(\)\.clear\(\)/);
  assert.match(clearOnBrowserLogout[1], /useTaskShelfStore\(\)\.clear\(\)/);
  assert.match(clearOnBrowserLogout[1], /clearAlertHistory\(\)/);
});

test('история: колокольчик стоит в верхней панели перед справкой и настройками', async (t) => {
  const { page } = await shellContractBrowser(t);
  const neighbour = await page.locator('[data-ui-topbar] .alert-bell').evaluate((bell) => ({
    tag: bell.nextElementSibling?.tagName,
    label: bell.nextElementSibling?.getAttribute('aria-label'),
    settings: bell.nextElementSibling?.nextElementSibling?.getAttribute('aria-label'),
  }));

  assert.deepEqual(neighbour, { tag: 'BUTTON', label: 'Справка', settings: 'Настройки' });
});
