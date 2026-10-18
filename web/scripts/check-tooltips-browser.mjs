#!/usr/bin/env node
// Изолированная приёмка настоящих подсказок в Chromium.
// Собственный Vite не обращается к серверу GrigDesk и закрывается в finally.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import vue from '../node_modules/@vitejs/plugin-vue/dist/index.mjs';
import { createServer } from '../node_modules/vite/dist/node/index.js';
import { artifactsPath } from '../../shared/runtime/dataHome.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const web = path.join(root, 'web');
const artifacts = path.join(artifactsPath({ env: process.env, home: os.homedir() }), 'title-tooltips');
const browserArtifacts = path.join(artifacts, 'browser');
const profile = path.join(browserArtifacts, 'chromium-profile');
const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const { chromium } = requireFromServer('playwright-core');
const report = {
  checks: [],
  browserErrors: [],
  apiRequests: [],
  screenshots: [],
};

/**
 * Используем уже установленный Chromium без скачивания и записи в домашний каталог.
 * Явное CHROME_BIN позволяет повторить проверку в другом окружении.
 */
function chromeBinary() {
  const candidates = [process.env.CHROME_BIN, '/usr/bin/google-chrome',
    '/usr/bin/chromium', '/usr/bin/chromium-browser'];

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error('Chrome/Chromium не найден; задайте CHROME_BIN.');
}

/**
 * Ждём состояние DOM вместо фиксированных пауз для задержки показа и анимаций.
 * Реальный текст проверяется отдельно, чтобы ошибка не пряталась за наличием поверхности.
 */
async function expectText(page, selector, text) {
  await page.waitForFunction(({ selector, text }) =>
    document.querySelector(selector)?.textContent === text, { selector, text });
  assert.equal(await page.locator(selector).textContent(), text);
}

/**
 * Снимки остаются рядом с отчётом и не затрагивают рабочие каталоги браузера.
 * Имя сохраняется в отчёте только после успешной записи файла.
 */
async function screenshot(page, name) {
  await page.screenshot({ path: path.join(browserArtifacts, name) });
  report.screenshots.push(name);
}

/**
 * Одна поверхность обслуживает обычные, вложенные и выключенные цели.
 * Переход с чипа на внешнюю ссылку проверяет выбор самой глубокой цели.
 */
async function checkPlain(page) {
  await page.locator('[data-test="plain"]').hover();
  await expectText(page, '#ui-tooltip-host', 'Обычная справка');
  await page.locator('[data-test="chip"]').hover();
  await expectText(page, '#ui-tooltip-host', 'Справка чипа');
  await page.locator('[data-test="link"]').hover({ position: { x: 5, y: 5 } });
  await expectText(page, '#ui-tooltip-host', 'Справка ссылки');
  await page.locator('[data-test="disabled"]').hover();
  await expectText(page, '#ui-tooltip-host', 'Причина недоступности');
  await screenshot(page, 'disabled-button-1280x800.png');
  report.checks.push('Общий хост: кнопка, вложенный чип/ссылка и выключенная кнопка');
}

/**
 * Подсказка рисуется выше диалога, но Tab остаётся у его focus trap.
 * Escape закрывает справку раньше диалога и не меняет его модель open.
 */
async function checkDialog(page) {
  await page.locator('[data-test="open-dialog"]').click();

  const dialog = page.getByRole('dialog', { name: 'Проверка диалога' });

  await dialog.waitFor();
  await page.mouse.move(2, 2);
  await page.keyboard.press('Tab');
  assert.equal(await page.locator('[data-test="dialog-tip"]')
    .evaluate((element) => element === document.activeElement), true);
  await expectText(page, '#ui-tooltip-host', 'Справка в диалоге');

  const z = await page.evaluate(() => ({
    tip: Number(getComputedStyle(document.querySelector('#ui-tooltip-host')).zIndex),
    dialog: Number(getComputedStyle(document.querySelector('.ui-dialog-overlay')).zIndex),
  }));

  assert.ok(z.tip > z.dialog, JSON.stringify(z));
  await screenshot(page, 'dialog-tab-1280x800.png');
  await page.keyboard.press('Tab');
  assert.equal(await dialog.evaluate((element) => element.contains(document.activeElement)), true);
  await page.keyboard.press('Escape');
  await page.locator('#ui-tooltip-host').waitFor({ state: 'detached' });
  assert.equal(await dialog.isVisible(), true);
  report.checks.push('Диалог: Tab замкнут, z-index справки выше, Escape закрывает только справку');
}

/**
 * Все ресурсы проверки имеют единый владелец и закрываются даже после assert.
 * Отчёт сохраняется при ошибке, чтобы ворота оставались воспроизводимыми.
 */
async function main() {
  let vite;
  let context;
  let page;

  await mkdir(browserArtifacts, { recursive: true });

  try {
    vite = await createServer({
      root: path.join(root, 'tests/web/fixtures/tooltips-browser'),
      configFile: false,
      cacheDir: path.join(artifacts, 'vite-cache'),
      plugins: [vue()],
      resolve: {
        alias: {
          vue: path.join(web, 'node_modules/vue'),
          pinia: path.join(web, 'node_modules/pinia'),
          'vue-router': path.join(web, 'node_modules/vue-router'),
        },
      },
      server: {
        host: '127.0.0.1',
        port: 0,
        fs: { allow: [root] },
      },
    });
    await vite.listen();

    const address = vite.httpServer.address();

    context = await chromium.launchPersistentContext(profile, {
      headless: true,
      executablePath: chromeBinary(),
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
      viewport: { width: 1280, height: 800 },
    });
    page = await context.newPage();
    page.on('pageerror', (error) => report.browserErrors.push(error.message));
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api')) {
        report.apiRequests.push(request.url());
      }
    });
    await page.goto(`http://127.0.0.1:${address.port}`, { waitUntil: 'networkidle' });
    await checkPlain(page);
    await checkDialog(page);
    assert.equal(await page.locator('[title], svg title').count(), 0);
    assert.deepEqual(report.apiRequests, []);
    assert.deepEqual(report.browserErrors, []);
    report.checks.push('Нет системных title, запросов API и ошибок браузера');
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    report.error = String(error);
    await page?.screenshot({ path: path.join(browserArtifacts, 'failure.png') }).catch(() => {});

    throw error;
  } finally {
    await context?.close();
    await vite?.close();
    await rm(profile, { recursive: true, force: true });
    await writeFile(path.join(browserArtifacts, 'report.json'), JSON.stringify(report, null, 2));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
