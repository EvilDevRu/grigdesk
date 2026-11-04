import assert from 'node:assert/strict';

import { i18nBrowser } from './i18nBrowser.js';
import { oldMetrics } from './computer-resources-fixtures.js';

import ru from '../../../shared/i18n/assets/locales/ru/core.json' with { type: 'json' };
import en from '../../../shared/i18n/assets/locales/en/core.json' with { type: 'json' };

export { oldMetrics, extendedMetrics } from './computer-resources-fixtures.js';

export const labels = { ru, en };

/**
 * Транспорт меняет ответ без перезагрузки каркаса и без доступа к живому серверу.
 * Опрос после первого снимка остановлен; каждый следующий GET вызывает сам тест.
 */
export async function resourcesBrowser(t, initial = oldMetrics(), options = {}) {
  const { browser, origin } = await i18nBrowser(t, {
    responses: { '/api/system': initial },
  });
  const context = await browser.newContext({
    locale: options.locale || 'ru-RU',
    viewport: options.viewport || { width: 1440, height: 900 },
    hasTouch: options.hasTouch || false,
  });

  t.after(() => context.close());

  const page = await context.newPage();
  let snapshot = initial;
  let offline = false;

  await page.route('**/api/system', (route) => offline
    ? route.abort('failed') : route.fulfill({ json: snapshot }));
  await page.goto(origin + '#/chats', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.locator('.agents').waitFor({ state: 'attached', timeout: 60000 });

  const trigger = page.locator('[data-context="topbar-metrics"], [data-context="phone-status-metrics"]');

  await page.waitForFunction(() => document.querySelector('#app').__vue_app__
    ?.config.globalProperties.$pinia._s.get('system')?.data);
  await page.evaluate(() => {
    document.querySelector('#app').__vue_app__.config.globalProperties.$pinia
      ._s.get('system').stopPolling();
  });

  const panel = page.locator('[data-role="system-resources"] .computer-resources');
  const activate = (button) => options.hasTouch ? button.tap() : button.click();

  /**
   * Метрики доступны прямо в шапке на любой ширине.
   * Один клик открывает общий диалог без промежуточной сводки.
   */
  async function showTrigger() {
    await trigger.waitFor({ state: 'visible' });
  }

  return {
    page,
    context,
    trigger,
    panel,
    showTrigger,
    async open() {
      await showTrigger();
      await activate(trigger);
      await panel.waitFor();
    },
    /**
     * Следующий ответ проходит через настоящий API-клиент и store.
     * Два кадра дают Vue опубликовать снимок до измерения DOM.
     */
    async setMetrics(value, failed = false) {
      snapshot = value;
      offline = failed;
      await page.evaluate(async () => {
        await document.querySelector('#app').__vue_app__.config.globalProperties.$pinia
          ._s.get('system').load();
      });
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() =>
        requestAnimationFrame(resolve))));
    },
    async language(value) {
      await page.evaluate(async (locale) => {
        const { setUiLanguage } = await import('/src/shared/uiLocale.ts');

        await setUiLanguage(locale);
      }, value);
      await page.waitForFunction((locale) => document.documentElement.lang.startsWith(locale), value);
    },
  };
}

/**
 * Возвращает только сериализуемые значения строки, никогда не живой DOM в assert.
 * Поиск по подписи привязан к устройству, а не к случайному порядку новых строк.
 */
export async function resourceRow(panel, label) {
  const row = panel.locator('.pu-row').filter({ hasText: label });

  assert.equal(await row.count(), 1, `ровно одна строка устройства ${label}`);

  const note = row.locator('.pu-reset');

  return {
    text: (await row.innerText()).replaceAll(/\s+/g, ' ').trim(),
    head: (await row.locator('.pu-head').innerText()).replaceAll(/\s+/g, ' ').trim(),
    note: await note.count() ? (await note.innerText()).replaceAll(/\s+/g, ' ').trim() : '',
    width: await row.locator('.pu-fill').evaluate((node) => parseFloat(node.style.width)),
    classes: await row.locator('.pu-fill').getAttribute('class'),
  };
}
