import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import os from 'node:os';
import { clientBrowser, scaleClientText } from './helpers/client-browser.mjs';
import { responses as projects } from './fixtures/projects/data.mjs';

/**
 * Состояние вопроса меняется только в синтетическом Pinia экземпляре текущего документа.
 * Компоненты, UI-kit, router и настоящая геометрия Chromium остаются без подмен.
 */
async function pending(page, request) {
  await page.evaluate((value) => {
    const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;

    pinia._s.get('chat').pending = value ? { [value.pid]: value } : {};
  }, request);
}

test('телефон: чат, вложения, полный вопрос, разрешение и карточка задачи', {
  timeout: 120000,
}, async (t) => {
  const { browser, origin, artifacts } = await clientBrowser(t);

  for (const [width, height] of [[390, 844], [360, 740]]) {
    const context = await browser.newContext({
        viewport: { width, height },
        hasTouch: true,
        reducedMotion: 'reduce',
      });
    const page = await context.newPage();

    try {
      await page.goto(origin + '#/chats');
      await page.locator('.cl .row-hit').first().click();
      await page.locator('.cs-input').waitFor();
      assert.equal(await page.locator('.cl').isVisible(), false);
      assert.equal(await page.getByRole('button', { name: 'Приложить файл', exact: true }).isVisible(), true);
      await page.locator('textarea[data-role="chat-composer"]').fill('Черновик телефона');
      await page.getByRole('button', { name: 'К списку чатов', exact: true }).click();
      assert.equal(await page.locator('.cl').isVisible(), true);
      assert.equal(await page.locator('.cs-input').isVisible(), false);
      await page.locator('.cl .row-hit').first().click();
      assert.equal(await page.locator('textarea[data-role="chat-composer"]').inputValue(),
        'Черновик телефона');

      await pending(page, {
        pid: 'question-fixture',
        kind: 'question',
        chatKey: 'geometry-chat',
        questions: [{
          question: 'Полный_вопрос_'.repeat(30) + 'КОНЕЦ',
          options: [{ label: 'Первый вариант' }],
        }],
      });
      await page.locator('.q').waitFor();
      await scaleClientText(page, 1.3);

      const question = await page.locator('.q').evaluate((element) => ({
        width: element.clientWidth,
        scroll: element.scrollWidth,
        text: element.textContent,
      }));

      assert.ok(question.text.includes('КОНЕЦ'));
      assert.ok(question.scroll <= question.width + 1,
        `Вопрос обрезан: ${question.scroll}/${question.width}`);
      await page.screenshot({
        animations: "disabled",
        path: path.join(artifacts, `phone-question-${width}.png`),
      });
      await pending(page, {
        pid: 'permission-fixture',
        kind: 'perm',
        chatKey: 'geometry-chat',
        tool: 'Bash',
        input: { command: 'long_command_'.repeat(800) + 'КОНЕЦ' },
      });
      await page.locator('.perm').waitFor();
      await scaleClientText(page, 1.3, '.perm');

      const permission = await page.locator('.perm').evaluate((element) => ({
        width: element.clientWidth,
        scroll: element.scrollWidth,
        text: element.textContent,
      }));

      assert.ok(permission.text.includes('КОНЕЦ'));
      assert.ok(permission.scroll <= permission.width + 1);
      assert.equal(await page.getByRole('button', { name: 'Разрешить', exact: true }).isVisible(), true);
      await page.screenshot({
        animations: "disabled",
        path: path.join(artifacts, `phone-permission-${width}.png`),
      });
      await pending(page, null);
      await page.goto(origin + '#/board');
      await page.locator('[data-context="board-task"]').first().waitFor();
      await scaleClientText(page, 1.3);
      await page.locator('[data-context="board-task"]').first().click();
      await page.getByRole('heading', { name: 'Задача для узкого экрана', exact: true }).waitFor();
      await scaleClientText(page, 1.3, '[data-role="task-modal"]');
      assert.match(await page.locator('#task-modal-title').textContent(), /Задача для узкого экрана/);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth
        <= document.documentElement.clientWidth + 1), true);
      await page.screenshot({
        animations: "disabled",
        path: path.join(artifacts, `phone-task-${width}.png`),
      });
    } finally {
      await context.close();
    }
  }
});

const artifacts = path.join(process.env.GRIGDESK_ARTIFACTS_DIR
  || path.join(os.homedir(), '.grigdesk/artifacts'), 'mobile-layout');

const tasks = Array.from({ length: 55 }, (_, index) => ({
  id: index + 11,
  title: `Задача ${index + 1}: проверить мобильную раскладку и длинное название проекта`,
  group: 'Рабочие инструменты команды',
  timerElapsed: 125,
}));

const responses = {
  ...projects,
  '/api/tracker/dashboard': {
    today: { hours: 1, tasks_count: 1 },
    month: { hours: 1, norm: 160 },
    tasks,
    toReview: [{ ...tasks[0], id: 90 }],
    created: [],
    stages: [],
    projects: [],
  },
  '/api/plugins': { plugins: [{
    id: 'code',
    name: 'Код',
    enabled: true,
    system: true,
    nav: {
      path: '/code',
      label: 'Код',
      icon: 'code',
      group: 'dock',
    },
  }] },
};

/**
 * Проверка границ учитывает реальные панели, а не только отсутствие скролла документа.
 * Нижняя навигация не должна съедать ширину и перекрывать содержимое страницы.
 */
async function assertPhoneFrame(page, width, height) {
  const frame = await page.evaluate(() => {
    const main = document.querySelector('.content').getBoundingClientRect();
    const nav = document.querySelector('.phone-nav').getBoundingClientRect();

    return {
      left: main.left,
      width: main.width,
      bottom: main.bottom,
      navTop: nav.top,
      navBottom: nav.bottom,
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
    };
  });

  assert.equal(frame.left, 0);
  assert.equal(frame.width, width);
  assert.ok(frame.bottom <= frame.navTop + 1);
  assert.ok(frame.navBottom <= height + 1);
  assert.equal(frame.overflow, false);
}

test('телефон: полная ширина, меню разделов, чат и раскрытие настроек без потери черновика', {
  timeout: 120000,
}, async (t) => {
  const { browser, origin } = await clientBrowser(t, { responses, artifacts });

  for (const width of [320, 390, 600]) {
    const page = await browser.newPage({ viewport: { width, height: 844 }, hasTouch: true });

    try {
      await page.goto(origin + '#/chats');
      await page.locator('.cl .row-hit').first().click();

      const composer = page.locator('textarea[data-role="chat-composer"]');
      const model = page.locator('button[data-role="chat-model"][role="combobox"]');
      const nativeModel = page.locator('select[data-role="chat-model"]');
      const options = page.getByRole('button', { name: 'Настройки чата', exact: true });

      await composer.fill('Черновик на телефоне');
      await assertPhoneFrame(page, width, 844);
      assert.equal(await model.count(), 1);
      assert.equal(await nativeModel.count(), 1);
      assert.equal(await nativeModel.isVisible(), false);
      assert.equal(await page.locator('.sidebar').isVisible(), false);
      assert.equal(await model.isVisible(), false);
      assert.ok(await page.locator('.cs-top').evaluate((el) => el.clientHeight) <= 68);
      await options.click();
      assert.equal(await model.isVisible(), true);
      assert.equal(await nativeModel.isVisible(), false);
      await scaleClientText(page, 1.3, '.cs-top');
      assert.equal(await page.locator('.cs-top').evaluate((el) => (
        el.scrollWidth <= el.clientWidth + 1
      )), true);
      await options.click();
      assert.equal(await composer.inputValue(), 'Черновик на телефоне');
      await page.screenshot({ path: path.join(artifacts, `chat-${width}.png`) });

      await page.locator('.phone-nav').getByRole('button', { name: 'Разделы', exact: true }).click();

      const menu = page.getByRole('dialog', { name: 'Разделы', exact: true });

      await menu.getByRole('link', { name: 'Проекты', exact: true }).click();
      await page.locator('[data-role="project-row"]').first().waitFor();
      assert.equal(await menu.isVisible(), false);
      await assertPhoneFrame(page, width, 844);
      await page.locator('.phone-nav').getByRole('link', { name: /Чаты/ }).click();
      await page.locator('.cl .row-hit').first().click();
      assert.equal(await composer.inputValue(), 'Черновик на телефоне');
    } finally {
      await page.close();
    }
  }
});

test('телефон: страница доски прокручивает свой список, фильтрует и загружает оставшиеся задачи', {
  timeout: 120000,
}, async (t) => {
  const { browser, origin } = await clientBrowser(t, { responses, artifacts });
  const page = await browser.newPage({ viewport: { width: 360, height: 740 }, hasTouch: true });

  await page.goto(origin + '#/board');
  await page.locator('.trow').first().waitFor();
  await assertPhoneFrame(page, 360, 740);
  assert.equal(await page.locator('.trow').count(), 40);
  assert.equal(await page.locator('.scroller').evaluate((el) => getComputedStyle(el).overflowY), 'visible');
  assert.equal(await page.locator('.col.primary').evaluate((el) => getComputedStyle(el).overflowY), 'auto');
  assert.equal(await page.locator('.board-pages').evaluate((el) => getComputedStyle(el).scrollSnapType),
    'x mandatory');

  const firstTask = await page.locator('.ttext').first().boundingBox();

  assert.ok(firstTask.width >= 230);
  await page.screenshot({ path: path.join(artifacts, 'board-360.png') });
  await page.locator('[data-role="board-load-more"]').click();
  assert.equal(await page.locator('.trow').count(), 55);
  await page.locator('.col.primary').evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.locator('.filter-toggle').click();
  assert.equal(await page.locator('#board-task-filters').isVisible(), true);
  await page.locator('.search input').fill('Задача 55:');
  assert.equal(await page.locator('.trow').count(), 1);
  await page.locator('.search input').fill('');
  await page.locator('.filter-toggle').click();
  await page.locator('.ttext').first().click();
  await page.getByRole('heading', { name: 'Задача для узкого экрана', exact: true }).waitFor();
  assert.equal(await page.locator('[data-role="task-modal"]').evaluate((el) => (
    el.getBoundingClientRect().width <= innerWidth
  )), true);
});

test('телефон: клавиатура сокращает карточку задачи вместе с видимой областью', {
  timeout: 120000,
}, async (t) => {
  const { browser, origin } = await clientBrowser(t, { responses, artifacts });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });

  await page.addInitScript(() => {
    const viewport = new EventTarget();

    Object.assign(viewport, {
      height: innerHeight,
      width: innerWidth,
      offsetTop: 0,
      offsetLeft: 0,
    });
    Object.defineProperty(window, 'visualViewport', { value: viewport });
    window.__phoneViewport = viewport;
  });
  await page.goto(origin + '#/board');
  await page.locator('.ttext').first().click();
  await page.getByRole('heading', { name: 'Задача для узкого экрана', exact: true }).waitFor();
  await page.evaluate(() => {
    window.__phoneViewport.height = 440;
    window.__phoneViewport.dispatchEvent(new Event('resize'));
  });
  await page.waitForFunction(() => document.querySelector('[data-role="task-modal"]')
    .getBoundingClientRect().bottom <= 441);

  const footer = await page.locator('[data-role="task-modal"] .controls').boundingBox();

  assert.ok(footer.y + footer.height <= 441);
  await page.screenshot({ path: path.join(artifacts, 'task-keyboard-390.png') });
});
