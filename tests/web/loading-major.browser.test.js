import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import { startLargeBrowser } from './fixtures/loading/largeBrowser.mjs';
import { frames } from './fixtures/loading/browser.mjs';

let browser;
let cleanup;

before(async () => {
  browser = await startLargeBrowser({ after(callback) {
    cleanup = callback;
  } });
});
after(async () => {
  await cleanup?.();
});

const layouts = [
  ['board', [
    ['primary', '.col.primary', ['x', 'width']],
    ['header', '.col.primary .colhead', ['y', 'height']],
  ]],
  ['pipeline', [
    ['card', '.card', ['x', 'width']],
    ['header', '.card .head', ['y', 'height']],
  ]],
];

/**
 * Отделяет размеры самого каркаса от переполнения неизменённых соседних частей экрана.
 * Сохраняет также ширину документа для сравнения ожидания с настоящим готовым экраном.
 */
async function horizontalGeometry(page) {
  return page.evaluate(() => ({
    viewport: innerWidth,
    document: document.documentElement.scrollWidth,
    loading: [...document.querySelectorAll('[data-ui-loading]')].map((element) => {
      const rect = element.getBoundingClientRect();

      return {
        left: rect.left,
        right: rect.right,
        client: element.clientWidth,
        scroll: element.scrollWidth,
      };
    }),
  }));
}

for (const [mode, pairs] of layouts) {
  for (const width of [1280, 390]) {
    test(`LOAD-GEO-major-${mode}-${width}: крупные области совпадают с настоящим экраном`, async (t) => {
      const h = await browser.open(t, { mode, viewport: { width, height: 844 } });
      const bricks = await h.page.locator('[data-ui-skeleton]').count();
      const pending = [];

      const measuredPairs = mode === 'board'
        ? [...pairs, ['summary', width < 600 ? '.stats-summary' : '.stats', ['y', 'height']]]
        : pairs;

      for (const [region] of measuredPairs) {
        const locator = h.page.locator(`[data-loading-region="${region}"]`).first();

        pending.push(await locator.count() ? await locator.boundingBox() : null);
      }

      const pendingHorizontal = await horizontalGeometry(h.page);

      await h.release();
      await h.page.evaluate(() => window.loadingFixture.ready());
      await h.page.locator(measuredPairs[0][1]).first().waitFor({ state: 'visible' });
      await frames(h.page);

      const ready = [];

      for (const [, selector] of measuredPairs) {
        ready.push(await h.page.locator(selector).first().boundingBox());
      }

      const readyHorizontal = await horizontalGeometry(h.page);

      assert.deepEqual(h.errors, [], 'настоящий ready не содержит ошибок');
      assert.deepEqual(h.unexpected, [], 'неизвестные API запрещены');
      assert.ok(ready.every(Boolean), 'все крупные области ready действительно видны');
      assert.equal(await h.page.locator('[data-ui-loading]').count(), 0);
      await writeFile(`${h.artifacts}/major-${mode}-${width}.json`, JSON.stringify({
        pairs: measuredPairs,
        pending,
        ready,
        pendingHorizontal,
        readyHorizontal,
      }, null, 2));
      assert.ok(bricks > 0, `${mode}: первое чтение имеет общий каркас`);

      for (const [index, [region, , dimensions]] of measuredPairs.entries()) {
        assert.ok(pending[index], `видна область каркаса ${region}`);

        for (const dimension of dimensions) {
          assert.ok(Math.abs(pending[index][dimension] - ready[index][dimension]) <= 4,
            `${mode}/${region}: ${dimension} ${pending[index][dimension]} → ${ready[index][dimension]}`);
        }
      }

      assert.ok(pendingHorizontal.loading.length > 0, 'измерен контейнер загрузки');

      for (const loading of pendingHorizontal.loading) {
        assert.ok(loading.left >= -1 && loading.right <= pendingHorizontal.viewport + 1,
          'контейнер каркаса помещается в viewport');
        assert.ok(loading.scroll <= loading.client + 1, 'каркас не переполняет свой контейнер');
      }

      // У готовой toolbar Конвейера есть исходное переполнение вне области замены.
      // Каркас не должен увеличивать его; остальные экраны сохраняют строгую проверку.
      assert.ok(pendingHorizontal.document <= Math.max(readyHorizontal.document, readyHorizontal.viewport),
        'ожидание не добавляет горизонтального переполнения к готовому экрану');

      if (mode !== 'pipeline') {
        assert.ok(readyHorizontal.document <= readyHorizontal.viewport);
      }
    });
  }
}

for (const route of ['chats', 'board', 'unknown']) {
  test(`LOAD-GEO-workspace-route-${route}: подключение сохраняет каркас маршрута и имя машины`, async (t) => {
    const h = await browser.open(t, { mode: `workspace-${route}` });
    const status = h.page.locator('[role="status"]').filter({ hasText: 'Синтетическая машина' });
    const announced = await status.count();
    const visible = announced ? await status.first().evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const text = [...element.querySelectorAll('*')].find((child) =>
        child.textContent.includes('Синтетическая машина') && !child.children.length);
      const label = text || element;
      const labelRect = label.getBoundingClientRect();
      const labelStyle = getComputedStyle(label);

      return rect.width > 1 && rect.height > 1 && style.visibility !== 'hidden'
        && labelRect.width > 1 && labelRect.height > 1
        && labelStyle.clip === 'auto' && labelStyle.clipPath === 'none';
    }) : false;
    const regions = route === 'chats' ? ['list', 'header', 'input'] : ['summary', 'primary'];
    const pending = [];

    for (const region of regions) {
      const locator = h.page.locator(`[data-loading-region="${region}"]`).first();

      pending.push(await locator.count() ? await locator.boundingBox() : null);
    }

    const bricks = await h.page.locator('[data-ui-skeleton]').count();

    await h.page.evaluate(() => window.loadingFixture.online());
    await frames(h.page);
    assert.deepEqual(h.errors, []);
    assert.deepEqual(h.unexpected, []);
    assert.equal(await h.page.locator('.shell > main.content').count(), 1);
    assert.equal(announced, 1, 'имя машины объявлено единственным статусом');
    assert.ok(visible, 'при подключении имя машины доступно зрячему пользователю');
    assert.ok(bricks > 0, 'подключение показывает каркас маршрута или общий outline');

    if (route !== 'unknown') {
      for (const [index, region] of regions.entries()) {
        const selector = region === 'list' ? '.cl' : `[data-loading-region="${region}"]`;
        const locator = h.page.locator(selector).first();
        const online = await locator.count() ? await locator.boundingBox() : null;

        assert.ok(pending[index] && online, `область ${region} есть до и после online`);

        for (const dimension of region === 'primary' || region === 'list'
          ? ['x', 'width'] : ['y', 'height']) {
          assert.ok(Math.abs(pending[index][dimension] - online[dimension]) <= 4,
            `подключение не сдвигает ${region}/${dimension}`);
        }
      }
    }

    assert.equal(await h.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  });
}

for (const compact of [false, true]) {
  test(`LOAD-PREFS-pipeline-${compact}: прежние ключи режима без перезаписи`, async (t) => {
    const storage = {
      'grigdesk-compact': compact ? '1' : '0',
      'grigdesk-loops': '1',
      'grigdesk-cards-collapsed': '[42]',
    };
    const h = await browser.open(t, { mode: 'pipeline', storage });
    const pending = h.page.locator('[data-loading-region="header"]').first();
    const pendingRect = await pending.count() ? await pending.boundingBox() : null;
    const bricks = await h.page.locator('[data-ui-skeleton]').count();

    await h.release();
    await h.page.locator('.card').waitFor({ state: 'visible' });
    await frames(h.page);
    assert.deepEqual(h.errors, []);
    assert.deepEqual(h.unexpected, []);
    assert.equal(await h.page.locator('.card.collapsed').count(), 1);
    assert.equal(h.requests.filter((request) => request === 'GET /api/tasks').length, 1);
    assert.equal(h.requests.filter((request) => request === 'GET /api/tasks/42/graph').length, 1);
    assert.deepEqual(await h.page.evaluate((keys) => Object.fromEntries(keys.map((key) =>
      [key, localStorage.getItem(key)])), Object.keys(storage)), storage);

    const ready = await h.page.locator('.card .head').boundingBox();

    assert.ok(bricks > 0, 'до ответа показан каркас с сохранённым компактным режимом');
    assert.ok(pendingRect && ready);
    assert.ok(Math.abs(pendingRect.height - ready.height) <= 4,
      'каркас компактной шапки сохраняет высоту готовой карточки');
  });
}
