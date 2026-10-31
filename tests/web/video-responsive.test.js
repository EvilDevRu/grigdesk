import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { clientBrowser, scaleClientText } from './helpers/client-browser.mjs';

const responses = {
  '/api/plugins': {
    plugins: [{
      id: 'video',
      name: 'Видео',
      enabled: true,
      system: true,
    }],
  },
  '/api/media/doctor': {
    ok: true,
    storage: null,
  },
  '/api/media/upload': { jobId: 'responsive-video' },
  '/api/media/ingest/responsive-video': {
    status: 'done',
    progress: null,
    error: null,
    result: {
      duration: 20,
      transcript: {
        segments: [{
          start: 0,
          end: 5,
          text: 'Проверить интерфейс приложения на телефоне.',
        }],
      },
    },
  },
  '/api/tracker/users': { users: [] },
  '/api/tracker/groups': { groups: [] },
};

test('видео: действие добавления задачи читается целиком на телефоне и сохраняет черновики', {
  timeout: 120000,
}, async (t) => {
  const { browser, origin, artifacts } = await clientBrowser(t, { responses });
  const sizes = [[320, 568], [390, 844], [844, 390], [768, 1024], [1024, 768], [1440, 1000]];

  for (const [width, height] of sizes) {
    for (const scale of width <= 390 ? [1, 1.3] : [1]) {
      const context = await browser.newContext({
        viewport: { width, height },
        hasTouch: width !== 1440,
        reducedMotion: 'reduce',
      });
      const page = await context.newPage();

      try {
        await page.goto(origin + '#/video');
        await page.locator('input[type="file"]').setInputFiles({
          name: 'meeting.mp4',
          mimeType: 'video/mp4',
          buffer: Buffer.from('synthetic-video'),
        });
        await page.locator('#video-step-tasks:not([disabled])').click();
        await page.getByRole('button', { name: 'Создать черновик', exact: true }).click();
        await page.getByPlaceholder('Заголовок задачи', { exact: true }).fill('Первый черновик');
        await scaleClientText(page, scale);

        const add = page.getByRole('button', { name: '+ ещё задача', exact: true });
        const geometry = await add.evaluate((button) => {
          const label = button.querySelector('.ui-button__label');
          const box = button.getBoundingClientRect();

          return {
            labelFits: label.scrollWidth <= label.clientWidth + 1,
            inside: box.left >= 0 && box.right <= innerWidth + 1,
            height: box.height,
          };
        });

        assert.equal(geometry.labelFits, true, `${width}/${scale}: подпись добавления задачи обрезана`);
        assert.equal(geometry.inside, true, `${width}/${scale}: действие выходит за окно`);
        assert.ok(geometry.height >= (width === 1440 ? 36 : 44));
        await add.click();
        assert.equal(await page.locator('.draft').count(), 2);
        assert.equal(await page.getByPlaceholder('Заголовок задачи', { exact: true }).first()
          .inputValue(), 'Первый черновик');
        await page.screenshot({ path: path.join(artifacts, `video-tasks-${width}-${scale}.png`) });
      } finally {
        await context.close();
      }
    }
  }
});
