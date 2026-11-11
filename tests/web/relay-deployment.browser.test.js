import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { clientBrowser, scaleClientText } from './helpers/client-browser.mjs';

test('RD-BROWSER-01: настоящий AppShell RU/EN, compact/touch, preview и одна SSE', {
  timeout: 240000,
}, async (t) => {
  const previousChrome = process.env.CHROME_BIN;

  process.env.CHROME_BIN ||= '/usr/bin/google-chrome';
  t.after(() => {
    if (previousChrome === undefined) {
      delete process.env.CHROME_BIN;
    } else {
      process.env.CHROME_BIN = previousChrome;
    }
  });

  const fp = 'a'.repeat(64);
  const { browser, origin, artifacts } = await clientBrowser(t, {
    artifacts: path.join(process.env.GRIGDESK_TEST_ARTIFACTS_DIR || tmpdir(), 'relay-deployment-browser'),
    responses: {
      '/api/devices/access': {
        name: 'Сервер лаборатории',
        direct: {
          state: 'disabled',
          addresses: [],
          error: null
        },
        relays: [],
        networks: [],
      },
      '/api/mobile/status': {
        server: { up: true, fp },
        relays: [],
        devices: []
      },
      '/api/client/hello': {
        product: 'grigdesk',
        fp,
        name: 'Сервер лаборатории',
        api: { major: 0, minor: 1 },
        device: null
      },
    },
  });

  for (const locale of ['ru', 'en']) {
    for (const width of [1280, 800, 390, 360]) {
      for (const scale of [1, 1.3]) {
        for (const touch of [false, true]) {
          const context = await browser.newContext({
            viewport: { width, height: 900 },
            hasTouch: touch,
            reducedMotion: 'reduce',
          });
          const page = await context.newPage();
          const calls = [];
          const job = {
            id: 'browser-job',
            revision: 1,
            state: 'draft',
            expectedServerFp: fp,
            mode: 'setup',
            steps: [],
            service: { state: 'pending' },
            channel: { state: 'unverified' }
          };
          let sse = 0;

          page.on('request', (request) => {
            if (new URL(request.url()).pathname === '/api/events') {
              sse += 1;
            }
          });
          await page.route('**/api/mobile/deployments**', async (route) => {
            const request = route.request();
            const url = new URL(request.url()).pathname;

            calls.push({ url, method: request.method() });

            if (url.endsWith('/probe')) {
              Object.assign(job, {
                state: 'awaiting_host_key',
                revision: 2,
                hostKey: {
                  challengeId: 'browser-challenge',
                  fingerprint: 'SHA256:browser',
                  decision: 'trust_required',
                  revision: 2
                }
              });
            } else if (url.endsWith('/host-key')) {
              Object.assign(job, { state: 'awaiting_credentials', revision: 3 });
            } else if (url.endsWith('/credentials')) {
              Object.assign(job, {
                state: 'awaiting_confirmation',
                revision: 4,
                preview: {
                  digest: 'b'.repeat(64),
                  changes: ['Служба и отдельный пользователь'],
                  artifact: { version: '0.3.0', digest: 'c'.repeat(64) }
                }
              });
            } else if (url.endsWith('/start')) {
              Object.assign(job, {
                state: 'failed',
                revision: 5,
                error: { code: 'port_busy' }
              });
            }

            const body = url.endsWith('/deployments') && request.method() === 'GET'
              ? { jobs: [] } : { job };

            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              headers: { 'cache-control': 'no-store' },
              body: JSON.stringify(body)
            });
          });

          try {
            await page.goto(origin + '#/settings?page=connections.devices');
            await page.locator('.server-access').waitFor();
            await page.evaluate(async (language) => {
              const { setUiLocale } = await import('/src/services/locale.ts');

              setUiLocale(language);
            }, locale);

            const heading = locale === 'ru' ? 'Удалённый доступ' : /Remote access/i;

            assert.equal(await page.getByRole('heading', { name: heading }).count(), 1,
              'На существующей странице должен быть блок мастера');
            assert.equal(sse, 1);

            const open = page.getByRole('button', {
              name: locale === 'ru'
                ? /(?:Создать|Настроить|Новый).*доступ/i : /(?:Set up|Create|New).*access/i
            }).first();

            await open.click();

            const wizard = page.locator('[data-role=remote-access-wizard]');
            const settings = page.locator('[data-role=settings-modal]');

            await page.getByLabel(locale === 'ru' ? /имя|название/i : /name/i).fill('Лаборатория');
            await page.getByLabel(/SSH.*(?:адрес|сервер|host)|(?:адрес|host).*SSH/i).fill('127.0.0.1');
            await page.getByLabel(locale === 'ru' ? /пользователь|логин/i : /user/i).fill('root');
            await page.getByRole('button', {
              name: locale === 'ru'
                ? /Проверить|Продолжить/i : /Check|Continue/i
            }).last().click();
            await page.getByText('SHA256:browser', { exact: false }).waitFor();
            assert.equal(calls.some((call) => call.url.endsWith('/credentials')), false);
            await page.getByRole('button', {
              name: locale === 'ru'
                ? /Довер|Подтвердить отпечаток/i : /Trust|Confirm fingerprint/i
            }).last().click();
            await page.locator('input[type=password]').fill('BROWSER_PASSWORD_SENTINEL');
            await page.getByRole('button', {
              name: locale === 'ru'
                ? /Проверить|Продолжить/i : /Check|Continue/i
            }).last().click();
            assert.equal(calls.some((call) => call.url.endsWith('/start')), false);
            await wizard.getByText('0.3.0 · ' + 'c'.repeat(64), { exact: true }).waitFor();
            assert.match(await wizard.innerText(), /служб|service/iu);
            await scaleClientText(page, scale, '[data-role=remote-access-wizard]');
            await page.keyboard.press('Tab');

            const geometry = await wizard.evaluate((dialog) => {
              const rect = dialog.getBoundingClientRect();
              const buttons = [...dialog.querySelectorAll('button')]
                .filter((button) => button.getBoundingClientRect().height > 0);

              return {
                left: rect.left,
                right: rect.right,
                viewport: innerWidth,
                overflow: dialog.scrollWidth > dialog.clientWidth + 1,
                minimum: Math.min(...buttons.map((button) => button.getBoundingClientRect().height)),
                buttons: buttons.map((button) => ({
                  text: button.textContent.trim(),
                  height: button.getBoundingClientRect().height,
                })),
              };
            });

            await page.screenshot({
              path: path.join(artifacts,
                `${locale}-${width}-${scale}-${touch}.png`), animations: 'disabled'
            });
            await page.getByRole('button', {
              name: locale === 'ru'
                ? /Установить|Начать установку/i : /Install|Start installation/i
            }).last().click();
            await wizard.getByRole('alert').waitFor();
            assert.match(await wizard.innerText(), /порт|port/iu);
            assert.doesNotMatch(await wizard.innerText(), /BROWSER_PASSWORD_SENTINEL/u);
            await page.keyboard.press('Escape');
            await wizard.waitFor({ state: 'detached' });
            assert.equal(await settings.isVisible(), true);
            // UiDialog возвращает фокус нижнему диалогу, если прежняя кнопка была размонтирована.
            // Настройки остаются доступны клавиатуре после закрытия только верхнего мастера.
            const focusInSettings = await settings.evaluate((element) =>
              element.contains(document.activeElement));

            assert.equal(focusInSettings, true, 'После Escape фокус должен остаться в открытых настройках');
            assert.equal(sse, 1);
            assert.ok(geometry.left >= -1 && geometry.right <= geometry.viewport + 1);
            assert.equal(geometry.overflow, false, `${locale}/${width}/${scale}/${touch}`);
            assert.ok(geometry.minimum >= (touch ? 44 : 32), JSON.stringify(geometry));
          } finally {
            await context.close();
          }
        }
      }
    }
  }
});
