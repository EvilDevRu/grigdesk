import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { clientBrowser, scaleClientText } from './helpers/client-browser.mjs';

test('PHONE-17: RU/EN, узкий touch и единственная SSE', { timeout: 180000 }, async (t) => {
  const previousChrome = process.env.CHROME_BIN;

  process.env.CHROME_BIN ||= '/usr/bin/google-chrome';
  t.after(() => {
    if (previousChrome === undefined) {
      delete process.env.CHROME_BIN;
    }
    else {
      process.env.CHROME_BIN = previousChrome;
    }
  });

  const { browser, origin, artifacts } = await clientBrowser(t, {
    artifacts: path.join(process.env.GRIGDESK_TEST_ARTIFACTS_DIR || tmpdir(), 'phone-access-browser'),
    responses: {
      '/api/devices/access': {
        name: 'Выбранный сервер',
        source: 'env',
        direct: {
          state: 'online',
          addresses: ['192.0.2.10:8145'],
          error: null
        },
        networks: [{ name: 'LAN', address: '192.0.2.10' }],
        relays: [],
      },
      '/api/devices/phone-pairing': {
        text: 'GRIGDESK:PHONE:2:SYNTHETIC',
        svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0h1v1H0z"/></svg>',
        expiresInMs: 600000,
        expiresAt: 1,
        attemptId: 'synthetic',
        qr: { size: 1, rows: ['1'] },
      },
      '/api/devices/phone-pairing/synthetic': { status: 'pending' },
    },
  });

  for (const locale of ['ru', 'en']) {
    for (const width of [1280, 800, 390, 360]) {
      for (const scale of [1, 1.3]) {
        const context = await browser.newContext({
          viewport: { width, height: 900 },
          hasTouch: true,
          reducedMotion: 'reduce',
        });
        const page = await context.newPage();
        let sse = 0;
        let issued = 0;

        page.on('request', (request) => {
          const url = new URL(request.url());

          if (url.pathname === '/api/events') {
            sse += 1;
          }
          if (url.pathname === '/api/devices/phone-pairing' && request.method() === 'POST') {
            issued += 1;
          }
        });

        try {
          await page.goto(origin + '#/chats');
          await page.locator('.agents').waitFor();
          await page.evaluate(async (language) => {
            const { setUiLocale } = await import('/src/services/locale.ts');

            setUiLocale(language);
          }, locale);
          assert.equal(sse, 1, 'Основной UI должен открыть единственный SSE до диалога');

          const caption = locale === 'ru' ? 'Подключить телефон' : /Connect (a |your )?phone/i;

          if (width <= 600) {
            await page.locator('.phone-nav').getByRole('button', {
              name: locale === 'ru' ? 'Разделы' : 'Sections', exact: true,
            }).click();
          }

          const button = page.getByRole('button', { name: caption }).first();

          assert.equal(await button.count(), 1, 'В настоящем AppShell отсутствует действие телефона');
          await button.click();

          const dialog = page.locator('[data-role="phone-connect"]');

          await dialog.locator('img').waitFor();
          await scaleClientText(page, scale, '[data-role="phone-connect"]');
          assert.equal(issued, 1);
          assert.equal(sse, 1);
          assert.match(await dialog.innerText(), /Выбранный сервер/);

          const geometry = await dialog.evaluate((dialog) => {
            const rect = dialog.getBoundingClientRect();
            const buttons = [...dialog.querySelectorAll('button')].filter((element) =>
              element.getBoundingClientRect().height > 0);

            return {
              left: rect.left,
              right: rect.right,
              viewport: innerWidth,
              overflow: dialog.scrollWidth > dialog.clientWidth + 1,
              minimum: Math.min(...buttons.map((element) => element.getBoundingClientRect().height)),
            };
          });

          assert.ok(geometry.left >= -1 && geometry.right <= geometry.viewport + 1, `${width}/${scale}`);
          assert.equal(geometry.overflow, false);
          assert.ok(geometry.minimum >= 40, 'Сенсорные действия должны сохранять общий touch-размер');
          await page.screenshot({
            animations: 'disabled',
            path: path.join(artifacts, `${locale}-${width}-${scale}.png`),
          });
          await page.keyboard.press('Escape');
          await dialog.waitFor({ state: 'detached' });
          assert.equal(sse, 1);
          assert.equal(await page.locator('textarea').filter({ hasText: 'GRIGDESK:PHONE:2:' }).count(), 0);
          assert.equal(await button.evaluate((element) => document.activeElement === element), true);
        }
        finally {
          await context.close();
        }
      }
    }
  }
});
