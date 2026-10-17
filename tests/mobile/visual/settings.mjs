import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createServer } from '../../../web/node_modules/vite/dist/node/index.js';
import vue from '../../../web/node_modules/@vitejs/plugin-vue/dist/index.mjs';
import { chromium } from '../../../mobile/node_modules/playwright-core/index.mjs';
import { artifactsPath } from '../../../shared/runtime/dataHome.ts';
import { createMobileSeed } from '../../helpers/mobileSeed.mjs';
import { inspectFrame } from './rules.mjs';
import { chromiumPath } from './browser.mjs';

const output = path.join(artifactsPath({ env: process.env, home: os.homedir() }),
  'mobile-remote/settings-visual');
const cleanup = [];
const sizes = [
  [1920, 1080],
  [1366, 768],
  [1024, 768],
  [768, 1024],
  [390, 844],
];
const report = [];

/**
 * Настройки читают настоящий административный API отдельного Cockpit с временным CLI токеном.
 * Измеряется поддерево MobileAccess и открытый общий диалог, без перезапуска рабочего сервера.
 */
async function main() {
  await mkdir(output, { recursive: true });

  const seed = await createMobileSeed({ after: (fn) => cleanup.unshift(fn) });

  await seed.core.listen({
    port: 0,
    host: '127.0.0.1',
  });

  const apiPort = seed.core.server.address().port;
  const statuses = ['online', 'connecting', 'waiting_vpn', 'offline', 'error'];

  for (let index = 0; index < statuses.length; index += 1) {
    const added = await seed.core.inject({
      method: 'POST',
      url: '/api/mobile/relays',
      headers: { 'x-cockpit-token': seed.cliToken },
      payload: {
        name: 'Посредник ' + statuses[index],
        host: '127.0.0.1',
        port: 25000 + index,
      },
    });

    assert.equal(added.statusCode, 200);
  }

  const vite = await createServer({
    configFile: false,
    root: path.resolve('tests/web/fixtures/mobile-access-browser'),
    plugins: [vue()],
    resolve: {
      alias: {
        vue: path.resolve('web/node_modules/vue/dist/vue.runtime.esm-bundler.js'),
        pinia: path.resolve('web/node_modules/pinia/dist/pinia.mjs'),
        'vue-router': path.resolve('web/node_modules/vue-router/dist/vue-router.mjs'),
      },
    },
    server: {
      host: '127.0.0.1',
      port: 0,
      fs: { allow: [path.resolve('.')] },
      proxy: { '/api': `http://127.0.0.1:${apiPort}` },
    },
  });

  await vite.listen();
  cleanup.unshift(() => vite.close());

  const browser = await chromium.launch({
    executablePath: await chromiumPath(),
    headless: true,
    args: ['--no-sandbox'],
  });

  cleanup.unshift(() => browser.close());

  for (const [width, height] of sizes) {
    const page = await browser.newPage({
      viewport: {
        width,
        height,
      },
    });

    await page.route('**/api/**', async (route) => {
      if (new URL(route.request().url()).pathname === '/api/auth/state') {
        await route.fulfill({
          json: {
            configured: true,
            authenticated: true,
            login: 'Тест',
          },
        });

        return;
      }
      if (new URL(route.request().url()).pathname === '/api/events') {
        await route.continue({
          headers: {
            ...route.request().headers(),
            'X-Cockpit-Token': seed.cliToken,
          },
        });

        return;
      }

      const response = await route.fetch({
        headers: {
          ...route.request().headers(),
          'X-Cockpit-Token': seed.cliToken,
        },
      });

      if (new URL(route.request().url()).pathname === '/api/mobile/status') {
        const data = await response.json();

        data.relays.forEach((item, index) => {
          item.link.state = statuses[index];
          item.link.lastError = statuses[index] === 'error' ? 'Посредник недоступен' : null;
        });
        await route.fulfill({
          response,
          json: data,
        });
      } else {
        await route.fulfill({ response });
      }
    });
    await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}`);
    await page.locator('[data-testid=mobile-revoke]').waitFor();
    await frame(page, 'lists', width, height);
    await page.locator('#mobile-relay-name').fill('Новый домашний посредник');
    await page.locator('#mobile-relay-host').fill('127.0.0.1');
    await page.locator('[data-testid=mobile-add-relay]').click();
    await page.locator('.mobile-install').waitFor();
    await frame(page, 'add', width, height);
    await page.locator('[data-testid=mobile-phone-qr]').first().click();
    await page.locator('[role=dialog]').waitFor();
    await frame(page, 'qr', width, height);
    await page
      .getByRole('button', {
        name: 'Закрыть',
        exact: true,
      })
      .last()
      .click();
    await page.locator('[data-testid=mobile-revoke]').click();
    await page.locator('[role=dialog],[role=alertdialog]').waitFor();
    await frame(page, 'revoke', width, height);
    await page
      .getByRole('button', {
        name: 'Отмена',
        exact: true,
      })
      .click();
    await page.close();
  }

  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');

  const failures = report.filter((row) => row.issues.length);

  await writeFile(
    path.join(output, 'report.md'),
    '# Административный блок мобильного доступа\n\n' +
      `Кадров: ${report.length}; с нарушениями: ${failures.length}.\n`,
  );
  console.log('MV-07', report.length, 'кадров;', failures.length, 'с нарушениями');
  process.exitCode = failures.length ? 1 : 0;
}

/**
 * Общие правила геометрии применяются к реальным controls и modal host.
 * Снимок сохраняется после прокрутки к проверяемому блоку или открытому диалогу.
 */
async function frame(page, name, width, height) {
  if (name === 'add') {
    await page.locator('.mobile-install').scrollIntoViewIfNeeded();
  }

  const issues = await page.evaluate(inspectFrame);

  report.push({
    name,
    width,
    height,
    issues,
  });
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await page.screenshot({
    path: path.join(output, `${width}x${height}-${name}.png`),
    fullPage: true,
  });
}

try {
  await main();
} catch (error) {
  const message = String(error.message)
    .replace(/X-Cockpit-Token: [^\s]+/gi, 'X-Cockpit-Token: [скрыто]')
    .replace(/[a-f0-9]{64}/g, '[скрыто]');

  console.error('Проверка административного интерфейса не завершена:', message);
  process.exitCode = 1;
} finally {
  for (const close of cleanup) {
    await close();
  }
}
