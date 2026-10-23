import { after, before } from 'node:test';

import { createUiBrowser } from './ui-components.js';

let browser;

// Vue запоминает document при первом импорте: окно живёт до конца файла тестов.
// Сценарии очищают DOM и storage, сохраняя настоящие Teleport и UiDialog.
before(async () => {
  browser = await createUiBrowser();
  globalThis.sessionStorage = browser.sessionStorage;
});

after(async () => {
  await browser?.close();
});

/**
 * Каждый сценарий начинает с пустых данных в том же document, который запомнил Vue.
 * Компоненты и их таймеры освобождаются обычными t.after владельцев фикстур.
 */
export function phoneBrowser() {
  browser.document.body.innerHTML = '<div id="mount"></div>';
  browser.localStorage.clear();
  browser.sessionStorage.clear();
  delete browser.navigator.clipboard;

  return browser;
}
