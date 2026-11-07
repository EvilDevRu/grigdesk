import assert from 'node:assert/strict';
import test from 'node:test';
import { createPinia, setActivePinia } from '../../web/node_modules/pinia/dist/pinia.mjs';
import { reactive } from '../../web/node_modules/vue/index.mjs';
import { installUiBrowser } from './helpers/ui-components.js';
import { compileModule, webFile } from './helpers/compile-vue.js';

/**
 * UI-зависимый граф компилируется после создания DOM и использует одну Pinia.
 * Прямого импорта navigation/settings с Vue SFC в Node здесь нет.
 */
async function navigationFixture(t) {
  const browser = await installUiBrowser(t);
  const entry = await compileModule(webFile('../tests/web/helpers/help-entry.ts'), {
    stubs: { '../router.ts': 'export const router = { push: async () => {} };' },
  });

  setActivePinia(createPinia());

  return {
    browser,
    entry,
    help: entry.useHelpStore()
  };
}

test('HELP-N2: F1 выбирает раздел, disposer снимает оба слушателя', async (t) => {
  const h = await navigationFixture(t);
  const dispose = h.entry.installHelpNavigation(h.browser,
    { currentRoute: { value: { path: '/projects/example' } } }, () => true);

  t.after(dispose);
  h.browser.dispatchEvent(new h.browser.KeyboardEvent('keydown', { code: 'F1', cancelable: true }));
  assert.equal(h.help.isOpen, true);
  assert.equal(h.help.articleId, 'projects');
  h.help.close();
  dispose();
  h.browser.dispatchEvent(new h.browser.KeyboardEvent('keydown', { code: 'F1' }));
  h.browser.dispatchEvent(new h.browser.Event('grigdesk:open-help'));
  assert.equal(h.help.isOpen, false);
});

test('HELP-N4: logout, другой scope и другая машина закрывают help без самовозврата', async (t) => {
  const h = await navigationFixture(t);
  const auth = reactive({ authenticated: true, clientScope: 'owner-a' });
  const shell = reactive({ profile: { id: 'machine-a' } });
  const stop = h.entry.bindHelpAccess(auth, shell, h.help.close);

  t.after(stop);
  h.help.open('chats');
  auth.authenticated = false;
  assert.equal(h.help.isOpen, false);
  auth.authenticated = true;
  assert.equal(h.help.isOpen, false);
  h.help.open('chats');
  auth.clientScope = 'owner-b';
  assert.equal(h.help.isOpen, false);
  h.help.open('chats');
  shell.profile = { id: 'machine-b' };
  assert.equal(h.help.isOpen, false);
  assert.equal(h.help.articleId, 'overview');
});
