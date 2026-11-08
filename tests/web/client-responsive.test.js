import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { clientBrowser, scaleClientText } from './helpers/client-browser.mjs';

test('coarse: общие кнопки, узкий topbar и visualViewport', { timeout: 120000 }, async (t) => {
  const { browser, origin, artifacts } = await clientBrowser(t);
  const sizes = [[390, 844], [800, 1280], [1280, 800], [1280, 860]];

  for (const [width, height] of sizes) {
    for (const zoom of [1, 1.3]) {
      const context = await browser.newContext({
        viewport: { width, height },
        hasTouch: true,
        reducedMotion: 'reduce',
      });
      const page = await context.newPage();

      await page.addInitScript(() => {
        const viewport = new EventTarget();

        Object.assign(viewport, {
          height: innerHeight,
          width: innerWidth,
          offsetTop: 0,
          offsetLeft: 0,
          pageTop: 0,
          pageLeft: 0,
          scale: 1,
        });
        window.__geometryViewport = viewport;
        Object.defineProperty(window, 'visualViewport', { value: viewport });
      });

      try {
        await page.goto(origin + '#/chats');
        await page.locator('.agents').waitFor();

        await page.locator('.cl .row-hit').first().click();
        await page.locator('.cs-input').waitFor();
        await page.locator('.rich-md pre').first().waitFor();
        await scaleClientText(page, zoom);

        const result = await page.evaluate(() => {
          const button = document.querySelector('[data-connection-button]')
            || document.querySelector('button[aria-label*="Тестовая машина"]');
          const primaryActions = [
            '.topbar button',
            '[data-role="chat-attachment"]',
            '[data-context="chat-send"]',
            '[data-context="chat-stop"]',
            '[data-context="chat-microphone"]',
          ].join(',');
          const buttons = [...document.querySelectorAll(primaryActions)].filter((item) => {
            const rect = item.getBoundingClientRect();

            return rect.width > 0 && rect.height > 0;
          });

          return {
            coarse: matchMedia('(pointer: coarse)').matches,
            touch: document.documentElement.hasAttribute('data-ui-touch'),
            overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
            connection: button ? button.getBoundingClientRect().width : 0,
            primaryActions: buttons.length,
            minimum: Math.min(...buttons.map((item) => item.getBoundingClientRect().height)),
          };
        });

        assert.equal(result.coarse, true);
        assert.equal(result.touch, true, `${width}/${zoom}: coarse не включил общий touch`);
        assert.equal(result.overflow, false, `${width}/${zoom}: прокрутка документа`);
        assert.ok(result.connection >= 40, `${width}/${zoom}: пропала связь ${result.connection}`);
        assert.ok(result.primaryActions >= 5, `${width}/${zoom}: не найдены основные действия`);
        assert.ok(result.minimum >= 40, `${width}/${zoom}: малая кнопка ${result.minimum}`);
        await page.evaluate(() => {
          window.__geometryViewport.height = 440;
          window.__geometryViewport.dispatchEvent(new Event('resize'));
        });
        await page.waitForFunction(() => document.querySelector('.cs-input')
          .getBoundingClientRect().bottom <= 441);
        assert.ok(await page.locator('.cs-input').isVisible());
        await page.screenshot({
        animations: "disabled",
        path: path.join(artifacts, `${width}x${height}-${zoom}.png`),
      });
      } finally {
        await context.close();
      }
    }
  }
});
