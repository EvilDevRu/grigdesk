import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';

import { clientBrowser, scaleClientText } from './helpers/client-browser.mjs';

/**
 * Меняем только публичный снимок и нативные команды синтетической оболочки.
 * Экран машин, общий UI-kit, стили, очереди диалогов и стек слоёв остаются настоящими.
 */
async function setMachines(page, status = 'online', detail = null) {
  await page.evaluate(({ status, detail }) => {
    const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
    const shell = pinia._s.get('shell');
    const profile = {
      id: 'work',
      name: 'Рабочая станция',
      address: 'https://work.example:443',
      kind: 'remote',
      status,
    };

    window.__machineCalls = [];
    shell.apply({
      ...shell.snapshot,
      rev: shell.snapshot.rev + 1,
      status,
      detail,
      profile,
      profiles: [profile, {
        ...profile,
        id: 'home',
        name: 'Домашний сервер',
        status: 'none',
      }, {
        ...profile,
        id: 'laptop',
        name: 'Ноутбук',
        status: 'none',
      }],
      capabilities: ['scan', 'unlock'],
    });
    shell.showConnections = true;
    shell.scan = async () => ({ pairing: 'GRIGDESK:PHONE:2:TEST' });
    shell.addMachine = async (pairing) => window.__machineCalls.push(['add', pairing]);
    shell.connect = async () => window.__machineCalls.push(['connect']);
    shell.selectProfile = async (id) => window.__machineCalls.push(['select', id]);
  }, { status, detail });
  await page.locator('.connections').waitFor();
}

/**
 * Замеряем все видимые действия в прокручиваемом экране и модальном окне.
 * Перенос текста разрешён, горизонтальное обрезание и площадки меньше 44 px запрещены.
 */
async function inspectMachines(page) {
  return page.evaluate(() => {
    const scope = document.querySelector('.ui-dialog') || document.querySelector('.connections');
    const buttons = [...scope.querySelectorAll('button')].map((button) => {
      const rect = button.getBoundingClientRect();

      return { button, rect };
    }).filter(({ rect }) => rect.width > 0 && rect.height > 0);

    return {
      overflow: document.documentElement.scrollWidth > innerWidth + 1
        || scope.scrollWidth > scope.clientWidth + 1,
      undersized: buttons.filter(({ rect }) => rect.width < 43.9 || rect.height < 43.9)
        .map(({ button, rect }) => `${button.textContent.trim()}: ${rect.width}×${rect.height}`),
      clipped: [...scope.querySelectorAll('.ui-button__label, h1, h2, strong')]
        .filter((element) => element.scrollWidth > element.clientWidth + 1)
        .map((element) => element.textContent.trim()),
    };
  });
}

test('машины: телефон, планшет, крупный текст, QR и восстановление связи', {
  timeout: 180000,
}, async (t) => {
  const { browser, origin, artifacts } = await clientBrowser(t, {
    artifacts: path.join(process.env.GRIGDESK_ARTIFACTS_DIR
      || path.join(process.env.HOME, '.grigdesk/artifacts'), 'mobile-machines-implementation'),
  });
  const errors = [];
  const cleanFrame = {
    overflow: false,
    undersized: [],
    clipped: [],
  };

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
      await page.goto(origin + '#/chats');
      await page.locator('.cl').waitFor();
      await setMachines(page);
      await scaleClientText(page, scale, '.connections');

      for (const [width, height] of [[320, 568], [360, 740], [390, 844], [800, 1280], [1280, 800]]) {
        await page.setViewportSize({ width, height });
        assert.deepEqual(await inspectMachines(page), cleanFrame,
          `${width}×${height}, текст ${scale}: список`);
      }

      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: path.join(artifacts, `machines-${scale}.png`) });
      await page.getByRole('button', { name: 'Параметры машины «Рабочая станция»', exact: true }).click();
      await page.locator('[data-role="machine-actions"]').waitFor();
      await scaleClientText(page, scale, '[data-role="machine-actions"]');
      assert.deepEqual(await inspectMachines(page), cleanFrame);

      if (scale === 1) {
        const box = await page.locator('[data-role="machine-actions"]').boundingBox();

        assert.ok(Math.abs(box.y + box.height - 844) <= 1, 'Меню машины должно прилегать к низу');
        await page.screenshot({ path: path.join(artifacts, 'machine-menu.png') });
      }

      await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
      await page.getByRole('button', { name: 'Добавить машину', exact: true }).click();
      await page.locator('[data-role="add-machine"]').waitFor();
      await scaleClientText(page, scale, '[data-role="add-machine"]');

      for (const [width, height] of [[320, 568], [360, 740], [390, 844], [800, 1280]]) {
        await page.setViewportSize({ width, height });
        assert.deepEqual(await inspectMachines(page), cleanFrame,
          `${width}×${height}, текст ${scale}: привязка`);
      }

      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: path.join(artifacts, `pair-${scale}.png`) });
      await page.getByRole('button', { name: 'Сканировать QR-код', exact: true }).click();
      await page.getByText('Код считан. Подтвердите добавление машины.', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Добавить', exact: true }).click();
      await page.locator('[data-role="add-machine"]').waitFor({ state: 'hidden' });
      assert.deepEqual(await page.evaluate(() => window.__machineCalls), [['add', 'GRIGDESK:PHONE:2:TEST']]);

      // Новый документ задаёт ровно 130%, не умножая повторно шрифт уже смонтированной карточки.
      await page.reload();
      await page.locator('.cl').waitFor();
      await setMachines(page, 'offline', { code: 'offline', retryAt: Date.now() + 8000 });
      await page.locator('.machine-recovery').waitFor();
      await scaleClientText(page, scale, '.connections');

      for (const [width, height] of [[320, 568], [360, 740], [390, 844], [800, 1280]]) {
        await page.setViewportSize({ width, height });
        assert.deepEqual(await inspectMachines(page), cleanFrame,
          `${width}×${height}, текст ${scale}: восстановление`);
      }

      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: path.join(artifacts, `recovery-${scale}.png`) });
      await page.getByRole('button', { name: 'Повторить сейчас', exact: true }).click();
      assert.deepEqual(await page.evaluate(() => window.__machineCalls), [['connect']]);
      await page.getByRole('button', { name: 'Выбрать другую машину', exact: true }).click();
      await page.getByRole('button', {
        name: 'Подключиться к машине «Домашний сервер»',
        exact: true,
      }).click();
      assert.deepEqual(await page.evaluate(() => window.__machineCalls), [['connect'], ['select', 'home']]);
    } finally {
      await context.close();
    }
  }

  assert.deepEqual(errors, []);
});
