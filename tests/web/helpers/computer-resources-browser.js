import assert from 'node:assert/strict';

import { i18nBrowser } from './i18nBrowser.js';
import ru from '../../../shared/i18n/assets/locales/ru/core.json' with { type: 'json' };
import en from '../../../shared/i18n/assets/locales/en/core.json' with { type: 'json' };

export const labels = { ru, en };

/**
 * Старый DTO сохранён отдельно от новых полей для барьера совместимости.
 * Все цифры синтетические, их источник — ответ управляемого API этой фикстуры.
 */
export function oldMetrics() {
  return {
    cpu: {
      percent: 42,
      cores: 4,
      load1: 1.23,
    },
    mem: {
      totalGb: 24,
      usedGb: 16,
      freeGb: 8,
      percent: 67,
      ramTotalGb: 16,
      ramUsedGb: 12,
      ramFreeGb: 4,
      ramPercent: 75,
      swapTotalGb: 8,
      swapUsedGb: 4,
      swapPercent: 50,
    },
    net: { ip: '192.0.2.1', countryCode: 'ZZ' },
  };
}

/**
 * Два раздела одного NVMe остаются разными строками, каждая со своей нагрузкой.
 * Разные температуры помогают заметить перестановку показаний между устройствами.
 */
export function extendedMetrics() {
  const metrics = oldMetrics();

  metrics.cpu.temperature = { celsius: 72.8 };
  metrics.gpus = [{
    id: 'gpu-one',
    name: 'Fixture RTX 3070',
    percent: 24,
    memoryUsedGb: 1.5,
    memoryTotalGb: 8,
    temperature: { celsius: 53 },
  }, {
    id: 'gpu-two',
    name: 'Fixture Radeon',
    percent: 37,
    memoryUsedGb: 2.25,
    memoryTotalGb: 16,
    temperature: { celsius: 61 },
  }];
  metrics.disks = [{
    id: 'disk-one',
    device: '/dev/nvme0n1p1',
    mountpoint: '/data/first',
    totalGb: 100,
    usedGb: 80,
    freeGb: 10,
    percent: 80,
    dataHome: true,
    temperature: {
      celsius: 41,
      maxCelsius: 79.85,
      critCelsius: 84.85,
    },
  }, {
    id: 'disk-two',
    device: '/dev/nvme0n1p2',
    mountpoint: '/data/second',
    totalGb: 234.5,
    usedGb: 180,
    freeGb: 54.5,
    percent: 180 / 234.5 * 100,
    dataHome: false,
    temperature: { celsius: 35 },
  }];

  return metrics;
}

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
  await page.goto(origin + '#/chats');

  const trigger = page.locator('[data-context="topbar-metrics"]');

  await trigger.waitFor({ state: 'attached' });
  await page.evaluate(() => {
    document.querySelector('#app').__vue_app__.config.globalProperties.$pinia
      ._s.get('system').stopPolling();
  });

  const panel = page.locator('.ui-topbar-panel');

  return {
    page,
    context,
    trigger,
    panel,
    async open() {
      await trigger.click();
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
      await page.waitForFunction((name) => document.querySelector('[data-context="topbar-metrics"]')
        ?.getAttribute('aria-label')?.includes(name), labels[value].computerResources);
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
