import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';

import { clientBrowser } from './helpers/client-browser.mjs';

/**
 * Состояние меняется через публичный снимок синтетической оболочки.
 * Авторизация, AppShell, окно настроек и их lifecycle остаются настоящими.
 */
async function setConnection(page, status) {
  await page.evaluate((nextStatus) => {
    const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
    const shell = pinia._s.get('shell');
    const profile = {
      id: 'test-machine',
      name: 'Компьютер',
      kind: 'remote',
      status: nextStatus,
    };

    shell.apply({
      ...shell.snapshot,
      rev: shell.snapshot.rev + 1,
      profile,
      profiles: [profile],
      status: nextStatus,
    });
  }, status);
}

test('настройки доступны только после подключения и входа, навигация скрыта без машины', {
  timeout: 120000,
}, async (t) => {
  const { browser, origin, artifacts } = await clientBrowser(t, {
    artifacts: path.join(process.env.GRIGDESK_ARTIFACTS_DIR
      || path.join(process.env.HOME, '.grigdesk/artifacts'), 'mobile-settings-availability'),
    shell: {
      rev: 1,
      profile: null,
      profiles: [],
      status: 'none',
      detail: null,
      localAvailable: false,
      serverApi: null,
      appApi: { major: 0, minor: 1 },
      capabilities: ['scan'],
    },
  });
  const errors = [];

  for (const [width, height] of [[390, 844], [800, 1280]]) {
    const context = await browser.newContext({
      viewport: { width, height },
      hasTouch: true,
      deviceScaleFactor: 2,
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    const serverRequests = [];
    let releaseAuth;
    const authReady = new Promise((resolve) => releaseAuth = resolve);

    await page.route('**/api/auth/state', async (route) => {
      await authReady;
      await route.continue();
    });

    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api/')) {
        serverRequests.push(new URL(request.url()).pathname);
      }
    });

    try {
      await page.goto(origin + '#/chats');
      await page.locator('.machine-welcome').waitFor();

      const gear = page.locator('.topbar-actions button[aria-label="Настройки"]');
      const modal = page.locator('[data-role="settings-modal"]');
      const content = await page.locator('.shell > .content').boundingBox();

      assert.equal(await page.locator('.sidebar').count(), 0);
      assert.equal(await gear.count(), 0);
      assert.equal(content.x, 0);
      assert.equal(content.width, width);
      await page.evaluate(() => window.dispatchEvent(new Event('grigdesk:open-settings')));
      assert.equal(await modal.count(), 0);
      await page.screenshot({ path: path.join(artifacts, `no-machine-${width}.png`) });
      await setConnection(page, 'connecting');
      await page.locator('.sidebar').waitFor({ state: 'attached' });
      await page.locator('.phone-nav').waitFor({ state: 'attached' });
      assert.equal(await gear.count(), 0);
      assert.equal(await modal.count(), 0);
      assert.deepEqual(serverRequests, [], 'До подключения и входа нет запросов рабочих страниц');

      const authenticating = page.waitForRequest('**/api/auth/state');

      await setConnection(page, 'online');
      await authenticating;
      assert.equal(await gear.count(), 0, 'Online без подтверждения входа не открывает настройки');
      assert.equal(await modal.count(), 0);
      releaseAuth();
      await modal.waitFor();
      assert.equal(await gear.count(), 1);
      await page.getByRole('button', { name: 'Закрыть настройки', exact: true }).click();
      await modal.waitFor({ state: 'hidden' });
      await gear.click();
      await modal.waitFor();
      await setConnection(page, 'offline');
      await modal.waitFor({ state: 'hidden' });
      assert.equal(await gear.count(), 0);
      assert.equal(await page.locator('.sidebar').count(), 1);
    } finally {
      releaseAuth();
      await context.close();
    }
  }

  assert.deepEqual(errors, []);
});
