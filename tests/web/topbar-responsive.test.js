import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { clientBrowser, scaleClientText } from './helpers/client-browser.mjs';

const providers = Array.from({ length: 10 }, (_, index) => ({
  id: `fixture-${index}`,
  name: `Исполнитель ${index + 1}`,
  vendor: 'Fixture',
  type: 'universal',
  kind: 'cli',
  available: true,
  installed: true,
  chatEnabled: true,
  models: [],
  settings: [],
  credentials: [],
}));

test('узкая шапка сохраняет действия и полную сводку без прокрутки рейки по горизонтали', {
  timeout: 180000,
}, async (t) => {
  const { browser, origin, artifacts } = await clientBrowser(t, {
    responses: {
      '/api/providers': { providers, models: [] },
      '/api/system': {
        cpu: { percent: 23, cores: 8 },
        mem: {
          percent: 40,
          usedGb: 6.4,
          totalGb: 16,
        },
        net: {
          ip: '192.0.2.1',
          country: 'Fixture',
          countryCode: 'RU',
        },
      },
    },
  });
  const context = await browser.newContext({
    hasTouch: true,
    locale: 'ru-RU',
    reducedMotion: 'reduce',
  });

  t.after(() => context.close());

  const page = await context.newPage();

  for (const width of [320, 390, 600, 800, 1100, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(origin + '#/chats');
    await page.getByRole('button', { name: 'Настройки', exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('#app').__vue_app__
      .config.globalProperties.$pinia._s.get('providers')?.providers.length === 10);

    if (width === 390 || width === 800) {
      await scaleClientText(page, 1.3);
    }

    const geometry = await page.evaluate(() => {
      const rail = document.querySelector('.sidebar');
      const buttons = [...document.querySelectorAll('.topbar button')].filter((button) => (
        button.getBoundingClientRect().width > 0
      ));

      return {
        documentOverflow: document.documentElement.scrollWidth > innerWidth,
        railOverflow: rail && rail.scrollWidth > rail.clientWidth,
        buttonsFit: buttons.every((button) => {
          const rect = button.getBoundingClientRect();

          return rect.left >= 0 && rect.right <= innerWidth && rect.width >= 44 && rect.height >= 44;
        }),
      };
    });

    assert.equal(geometry.documentOverflow, false, `${width}: документ шире экрана`);
    assert.equal(Boolean(geometry.railOverflow), false, `${width}: горизонтальная прокрутка рейки`);
    assert.equal(geometry.buttonsFit, true, `${width}: действие шапки обрезано или мало`);

    if (width > 1100) {
      await page.locator('.topbar [data-context="provider-status"]').first().waitFor();
      assert.equal(await page.locator('.topbar [data-context="provider-status"]').count(), 10);
      assert.equal(await page.locator('[data-shell-status-trigger]').count(), 0);

      continue;
    }

    await page.getByRole('button', { name: 'Состояние системы', exact: true }).click();

    const overview = page.getByRole('dialog', { name: 'Состояние системы', exact: true });

    await overview.waitFor();

    if (width === 390 || width === 800) {
      await scaleClientText(page, 1.3, '.shell-status-panel');
    }

    assert.equal(await overview.locator('[data-context="provider-status"]').count(), 10);
    assert.equal(await overview.getByText('Исполнитель 10', { exact: true }).isVisible(), true);
    assert.equal(await overview.locator('[data-context="topbar-metrics"]').isVisible(), true);
    assert.equal(await overview.locator('[data-context="topbar-network"]').isVisible(), true);

    const fits = await overview.evaluate((element) => {
      const rect = element.getBoundingClientRect();

      return rect.left >= 0 && rect.right <= innerWidth && element.scrollWidth <= element.clientWidth;
    });

    assert.equal(fits, true, `${width}: сводка не помещается`);
    await overview.locator('[data-context="provider-status"]').last().click();
    await page.locator('.ptip-name').waitFor();

    if (width === 390) {
      assert.equal(await page.evaluate(() => window.grigdeskBack()), true);
    } else {
      await page.keyboard.press('Escape');
    }

    await page.locator('.ptip-name').waitFor({ state: 'hidden' });
    assert.equal(await overview.isVisible(), true);
    await page.screenshot({ path: path.join(artifacts, `topbar-${width}.png`), animations: 'disabled' });
    await page.keyboard.press('Escape');
    await overview.waitFor({ state: 'hidden' });

    const settings = page.getByRole('button', { name: 'Настройки', exact: true });

    await settings.click();
    await page.getByRole('dialog', { name: 'Настройки', exact: true }).waitFor();
    await page.keyboard.press('Escape');
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Состояние системы', exact: true }).click();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator('.topbar [data-context="provider-status"]').first().waitFor();
  assert.equal(await page.locator('.shell-status-panel').count(), 0);
});
