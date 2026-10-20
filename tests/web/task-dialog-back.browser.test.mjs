import assert from 'node:assert/strict';
import test from 'node:test';

import { desktopUserAgent } from '../../shared/desktop/desktopWindowContract.ts';
import { clientBrowser } from './helpers/client-browser.mjs';

test('TD-B01: диалог и системная Назад без windows', { timeout: 120000 }, async (t) => {
  const { browser, origin } = await clientBrowser(t);
  const modes = [
    { name: 'браузер' },
    {
      name: 'Android',
      userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile',
      hasTouch: true,
    },
    { name: 'прежний desktop', userAgent: desktopUserAgent('Electron', 'main') },
  ];

  for (const { name, ...options } of modes) {
    await t.test(name, async () => {
      const context = await browser.newContext(options);
      const native = [];

      context.on('request', (request) => {
        if (request.url().includes('/__shell/surfaces/')) {
          native.push(request.url());
        }
      });

      try {
        const page = await context.newPage();

        await page.goto(origin + '#/board');

        const task = page.getByText('Задача для узкого экрана', { exact: true }).first();

        await task.click();
        await page.locator('[role="dialog"][aria-modal="true"]').waitFor();

        const before = page.url();

        assert.equal(await page.evaluate(() => window.grigdeskBack()), true);
        await page.locator('[role="dialog"]').waitFor({ state: 'detached' });
        assert.equal(page.url(), before);
        assert.equal(await page.evaluate(() => window.grigdeskBack()), false);
        await task.click();
        await page.locator('[role="dialog"][aria-modal="true"]').waitFor();
        assert.equal(await page.evaluate(() => window.grigdeskBack()), true);
        await page.locator('[role="dialog"]').waitFor({ state: 'detached' });
        assert.deepEqual(native, []);
      } finally {
        await context.close();
      }
    });
  }
});
