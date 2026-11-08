import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { protocolRoutes } from './chat-protocol.js';
import { clientBrowser, chatSession } from './client-browser.mjs';
import { selectUiOption } from './selectUiOption.ts';
import data from '../fixtures/settings-modal/data.json' with { type: 'json' };

/**
 * Полный интерфейс получает только синтетические ответы из прежней фикстуры настроек.
 * Кэш и снимки принадлежат временному каталогу теста, данные владельца не читаются.
 */
export async function i18nBrowser(t, options = {}) {
  const artifacts = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-i18n-'));

  t.after(() => rm(artifacts, { recursive: true, force: true }));

  const chatStore = {
    sessions: [{
      ...chatSession,
      messages: [
        ...chatSession.messages,
        ...Array.from({ length: 39 }, (_, index) => ({
          role: 'assistant',
          text: `Непереведённый ответ ${index + 1}. Текст для прокрутки настоящего чата.`,
        })),
      ],
    }],
    activeId: chatSession.id,
  };

  const result = await clientBrowser(t, {
    artifacts,
    shell: null,
    chatStore,
    ...options,
    responses: {
      '/api/settings/prefs': structuredClone(data.prefs),
      '/api/settings/speech': structuredClone(data.speech),
      '/api/providers': structuredClone(data.providers),
      '/api/plugins': structuredClone(data.plugins),
      '/api/plugin-installs/jobs/current': { job: null, recoveryError: null },
      ...protocolRoutes(chatStore),
      ...options.responses,
    },
  });
  const newContext = result.browser.newContext.bind(result.browser);

  result.browser.newContext = async (contextOptions) => {
    const context = await newContext(contextOptions);

    context.setDefaultTimeout(10000);
    context.setDefaultNavigationTimeout(60000);

    return context;
  };

  return result;
}

/**
 * Открытый чат и его композер настоящие, сеть остаётся локальной фикстурой.
 * Сохранённые ссылки позволяют обнаружить пересоздание DOM при смене языка.
 */
export async function openLanguageChat(page, origin) {
  await page.goto(origin + '#/chats');
  await page.locator('.cl .row-hit').first().click();
  await page.locator('textarea[data-role="chat-composer"]').waitFor();
  await page.locator('textarea[data-role="chat-composer"]').fill('Черновик без перевода');
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() =>
    requestAnimationFrame(resolve))));
  await page.evaluate(() => {
    const input = document.querySelector('textarea[data-role="chat-composer"]');
    const body = document.querySelector('.cs-body');

    input.setSelectionRange(2, 9);
    body.scrollTop = 123;
    body.dispatchEvent(new Event('scroll'));
    window.__i18nChat = {
      input,
      body,
      root: document.querySelector('.cs'),
      activeId: document.querySelector('#app').__vue_app__.config.globalProperties.$pinia
        ._s.get('chat').activeId,
      scrollTop: body.scrollTop,
      scrollable: body.scrollHeight > body.clientHeight + 200,
      removals: 0,
    };
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.removedNodes) {
          if (node === window.__i18nChat.root || node.contains?.(window.__i18nChat.root)) {
            window.__i18nChat.removals += 1;
          }
        }
      }
    }).observe(document, { childList: true, subtree: true });
  });
}

/**
 * Барьер сравнивает значения и идентичность, не сериализуя живые узлы в assert.
 * Выделение и прокрутка проверяются после закрытия модального окна.
 */
export async function assertLanguageChat(page) {
  const result = await page.evaluate(() => {
    const saved = window.__i18nChat;
    const input = document.querySelector('textarea[data-role="chat-composer"]');
    const body = document.querySelector('.cs-body');

    return {
      sameInput: input === saved.input,
      sameBody: body === saved.body,
      sameRoot: document.querySelector('.cs') === saved.root,
      value: input.value,
      selection: [input.selectionStart, input.selectionEnd],
      activeId: document.querySelector('#app').__vue_app__.config.globalProperties.$pinia
        ._s.get('chat').activeId,
      previousId: saved.activeId,
      scroll: body.scrollTop === saved.scrollTop,
      scrollable: saved.scrollable,
      previousScroll: saved.scrollTop,
      removals: saved.removals,
    };
  });

  assert.equal(result.sameInput, true);
  assert.equal(result.sameBody, true);
  assert.equal(result.sameRoot, true);
  assert.equal(result.value, 'Черновик без перевода');
  assert.deepEqual(result.selection, [2, 9]);
  assert.equal(result.activeId, result.previousId);
  assert.equal(result.scroll, true);
  assert.equal(result.scrollable, true, 'Фикстура действительно прокручивается');
  assert.ok(result.previousScroll > 0, 'Барьер защищает ненулевую позицию');
  assert.equal(result.removals, 0);
}

/**
 * Настройка выбирается доступным именем и применяется настоящим обработчиком страницы.
 * Выбор страницы через store лишь открывает нужный раздел без зависимости от текущего перевода.
 */
export async function chooseLanguage(page, preference) {
  await page.getByRole('button', { name: /^(Настройки|Settings)$/ }).click();
  await page.locator('[data-role="settings-modal"]').waitFor();
  await page.evaluate(() => {
    document.querySelector('#app').__vue_app__.config.globalProperties.$pinia
      ._s.get('settings').selectPage('interface.behavior');
  });

  const control = page.getByRole('combobox', { name: /^(Язык интерфейса|Interface language)$/ });

  await selectUiOption(page, control, preference);
  await page.getByRole('button', { name: /^(Отмена|Cancel)$/ }).click();
  await page.locator('[data-role="settings-modal"]').waitFor({ state: 'hidden' });
}

