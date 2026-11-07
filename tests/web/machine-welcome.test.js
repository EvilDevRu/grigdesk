import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';

import { clientBrowser, scaleClientText } from './helpers/client-browser.mjs';

/**
 * Замеряется настоящая начальная страница внутри общей навигации приложения.
 * Малое окно и крупный шрифт сохраняют доступную прокрутку без обрезанных действий.
 * Обычное высокое окно телефона отдельно проверяется на полное размещение содержимого.
 */
async function inspectWelcome(page) {
  return page.evaluate(() => {
    const scope = document.querySelector('.machine-welcome');
    const buttons = [...scope.querySelectorAll('button')];

    return {
      overflow: document.documentElement.scrollWidth > innerWidth + 1
        || scope.scrollWidth > scope.clientWidth + 1,
      clipped: [...scope.querySelectorAll('h1, h2, h3, .ui-button__label')]
        .filter((element) => element.scrollWidth > element.clientWidth + 1)
        .map((element) => element.textContent.trim()),
      undersized: buttons.filter((button) => {
        const rect = button.getBoundingClientRect();

        return rect.width < 44 || rect.height < 44;
      }).map((button) => button.textContent.trim()),
      columns: getComputedStyle(scope.querySelector('.machine-welcome-layout'))
        .gridTemplateColumns.split(' ').length,
    };
  });
}

test('начальный выбор компьютера: адаптив, явное добавление и сохранённые машины', {
  timeout: 120000,
}, async (t) => {
  const { browser, origin, artifacts } = await clientBrowser(t, {
    artifacts: path.join(process.env.GRIGDESK_ARTIFACTS_DIR
      || path.join(process.env.HOME, '.grigdesk/artifacts'), 'mobile-machine-welcome'),
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

  for (const scale of [1, 1.3]) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      deviceScaleFactor: 2,
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();

    page.on('pageerror', (error) => errors.push(error.message));

    try {
      await page.goto(origin + '#/');
      await page.locator('.machine-welcome').waitFor();
      assert.equal(await page.locator('[data-role="add-machine"]').count(), 0);
      await scaleClientText(page, scale, '.machine-welcome');

      for (const [width, height] of [[320, 568], [360, 740], [393, 840], [390, 844],
        [800, 1280], [1280, 800]]) {
        await page.setViewportSize({ width, height });
        assert.deepEqual(await inspectWelcome(page), {
          overflow: false,
          clipped: [],
          undersized: [],
          columns: width >= 800 ? 2 : 1,
        }, `${width}×${height}, текст ${scale}`);

        if (scale === 1 && width >= 390) {
          const geometry = await page.locator('.machine-welcome').evaluate((element) => ({
            width: element.getBoundingClientRect().width,
            viewportWidth: innerWidth,
            scrollHeight: element.scrollHeight,
            clientHeight: element.clientHeight,
            documentHeight: document.documentElement.scrollHeight,
            viewportHeight: innerHeight,
          }));

          assert.ok(geometry.width >= geometry.viewportWidth - 1,
            'Начальный экран должен занимать всю ширину без внешнего отступа и scrollbar-gutter');
          assert.ok(geometry.scrollHeight <= geometry.clientHeight + 1,
            `${width}×${height}: инструкция должна помещаться без вертикальной прокрутки`);
          assert.ok(geometry.documentHeight <= geometry.viewportHeight + 1,
            'Начальный экран не должен прокручивать документ');
        }

        if (scale === 1 && width !== 320) {
          await page.screenshot({ path: path.join(artifacts, `welcome-${width}.png`) });
        }
      }

      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole('button', { name: 'Добавить машину', exact: true }).click();
      await page.locator('[data-role="add-machine"]').waitFor();
      await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
      await page.locator('[data-role="add-machine"]').waitFor({ state: 'hidden' });
      assert.equal(await page.locator('.machine-welcome').count(), 1);

      await page.evaluate(() => {
        const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
        const shell = pinia._s.get('shell');

        shell.apply({
          ...shell.snapshot,
          rev: shell.snapshot.rev + 1,
          profiles: [{
            id: 'saved',
            name: 'Сохранённая машина',
            kind: 'remote',
            status: 'none',
          }],
        });
      });
      await page.getByRole('button', { name: 'Выбрать сохранённую машину', exact: true }).click();
      await page.locator('.connections').waitFor();
      assert.ok(await page.getByText('Сохранённая машина', { exact: true }).count());
    } finally {
      await context.close();
    }
  }

  assert.deepEqual(errors, []);
});
