import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { chatSession, clientBrowser, scaleClientText } from './helpers/client-browser.mjs';

test('Android: обе шапки чатов сохраняют общие оси при раскрытии фильтров', { timeout: 90000 }, async (t) => {
  const { browser, origin } = await clientBrowser(t, {
    chatStore: {
      sessions: [chatSession],
      activeId: chatSession.id,
      filtersProtocol: 1,
    },
  });
  const context = await browser.newContext({
    viewport: { width: 1164, height: 760 },
    userAgent: 'Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/146.0.0.0 Mobile Safari/537.36',
    hasTouch: true,
    reducedMotion: 'reduce',
  });

  t.after(() => context.close());

  const page = await context.newPage();
  const toggle = page.locator('[data-chat-filter-toggle]');
  const filterPanel = page.locator('#chat-list-filters');

  await page.goto(origin + '#/chats');
  await page.locator('.cl .row-hit').first().click();
  await page.locator('.cs-top .bar .model .ui-select').waitFor();

  /**
   * Сравнивает центры видимых контролов с осями рядов, а также границы
   * шапок. Текст, подписи и данные разговора для замера не нужны.
   */
  const measure = () => page.evaluate(() => {
    const center = (selector) => {
      const rect = document.querySelector(selector).getBoundingClientRect();

      return rect.top + rect.height / 2;
    };

    return {
      search: center('.cl .top-controls .tools input'),
      scope: center('.cl [data-context="chat-scope"]'),
      filter: center('.cl [data-chat-filter-toggle]'),
      primary: center('.cs-top .hrow'),
      secondary: center('.cs-top .bar .model .ui-select'),
      leftEnd: document.querySelector('.cl-body > .top').getBoundingClientRect().bottom,
      rightEnd: document.querySelector('.cs-top').getBoundingClientRect().bottom,
    };
  });

  for (const width of [1164, 960]) {
    await page.setViewportSize({ width, height: 760 });

    const closed = await measure();

    assert.equal(closed.search, closed.primary);
    assert.equal(closed.scope, closed.secondary);
    assert.equal(closed.filter, closed.secondary);
    assert.equal(closed.leftEnd, closed.rightEnd);

    await toggle.click();
    await filterPanel.waitFor();

    const expanded = await measure();
    const filterFields = filterPanel.locator(':is(button.ui-select, input)[data-chat-filter]');
    const heights = await filterFields.evaluateAll((fields) => {
      return fields.map((field) => field.getBoundingClientRect().height);
    });

    assert.ok(expanded.leftEnd > closed.leftEnd);
    assert.deepEqual(expanded, { ...closed, leftEnd: expanded.leftEnd });
    assert.deepEqual(heights, [32, 32, 32, 32]);

    await toggle.click();
    await filterPanel.waitFor({ state: 'hidden' });

    assert.deepEqual(await measure(), closed);
  }

  const taskSelect = page.locator('.cs-top .sel.task button.ui-select');
  const search = page.locator('.cl .tools input');

  await taskSelect.click();

  const menuSearch = page.locator('.ui-select-popup input[data-context="select-search"]');

  for (const field of [taskSelect, search, menuSearch]) {
    assert.equal((await field.boundingBox())?.height, 32);
  }
});

test('Android: клавиатура не сдвигает иконки, док остаётся под шапкой', { timeout: 90000 }, async (t) => {
  const projects = Array.from({ length: 8 }, (_, index) => ({
    id: `project-${index}`,
    title: `Проект ${index}`,
    tags: [],
    repos: [],
    defaultRepoKey: null,
    archivedAt: null,
    revision: 1,
    updatedAt: null,
    profile: { present: false, pathsSource: 'passport' },
    importStatus: 'none',
    routes: [],
    warnings: [],
  }));
  const plugins = ['code', 'shelf', 'ssh', 'db', 'docker'].map((id) => ({
    id,
    name: id,
    enabled: true,
    nav: { path: `/${id}`, group: 'dock' },
  }));
  const { browser, origin } = await clientBrowser(t, {
    chatStore: {
      sessions: [chatSession],
      archived: [],
      activeId: chatSession.id,
      filtersProtocol: 1,
      projectFiltersProtocol: 1,
    },
    responses: { '/api/projects': { projects }, '/api/plugins': { plugins } },
  });
  const context = await browser.newContext({
    viewport: { width: 1164, height: 760 },
    userAgent: 'Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/146.0.0.0 Mobile Safari/537.36',
    locale: 'ru-RU',
    hasTouch: true,
    reducedMotion: 'reduce',
  });

  t.after(() => context.close());

  const page = await context.newPage();
  const code = page.getByRole('button', { name: /^Код(?: ·|$)/ });
  const dock = page.locator('.tool-surface.is-dock');
  const codeRail = dock.locator('[data-context="code-rail-item"]');

  await page.goto(origin + '#/chats');
  await page.addStyleTag({
    content: `
      #app { padding: 30px 12px 16px 10px; }
      [data-context='code-rail-item']::before,
      [data-context='tool-rail-item']::before { transition: none; }
    `,
  });
  await page.locator('.project-rail-scroll [data-chat-project]').last().waitFor();
  await code.click();
  await dock.waitFor();
  await codeRail.first().waitFor();

  const selectedColor = await code.evaluate((button) => getComputedStyle(button, '::before').backgroundColor);

  for (const tab of ['files', 'changes', 'commits']) {
    const button = codeRail.and(page.locator(`[data-tab="${tab}"]`));

    await button.tap();

    const highlight = await button.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const fill = getComputedStyle(element, '::before');

      return {
        selected: element.getAttribute('aria-pressed'),
        width: box.width,
        height: box.height,
        inset: fill.inset,
        color: fill.backgroundColor,
        outside: getComputedStyle(element).backgroundColor,
      };
    });

    assert.deepEqual(highlight, {
      selected: 'true',
      width: 44,
      height: 44,
      inset: '4px',
      color: selectedColor,
      outside: 'rgba(0, 0, 0, 0)',
    });
  }

  /**
   * Запоминает геометрию тех же кнопок и краёв до и после уменьшения видимой области.
   * Размер окна браузера остаётся прежним, как при открытии клавиатуры в WebView.
   */
  const measure = () => page.evaluate(() => {
    const railSelectors = ['.sidebar', '.project-rail-scroll', '.tool-rail'];
    const rails = railSelectors.map((selector) => {
      const rail = document.querySelector(selector);
      const item = rail.querySelector('[data-ui-shell-nav], [data-chat-project], .tool-rail-item');
      const bounds = item.getBoundingClientRect();

      return {
        center: bounds.left + bounds.width / 2,
        scrollbar: getComputedStyle(rail, '::-webkit-scrollbar').display,
        gutter: rail.offsetWidth - rail.clientWidth,
        overflow: rail.scrollHeight > rail.clientHeight,
      };
    });
    const bar = document.querySelector('.topbar').getBoundingClientRect();
    const content = document.querySelector('.shell > .content').getBoundingClientRect();
    const dock = document.querySelector('.tool-surface.is-dock').getBoundingClientRect();
    const action = document.querySelector('[data-context="tool-dock-expand"]').getBoundingClientRect();

    return {
      rails,
      dockTopOffset: dock.top - bar.bottom,
      dockRightOffset: content.right - dock.right,
      dockBottomOffset: content.bottom - dock.bottom,
      actionHeight: action.height,
    };
  });

  const before = await measure();

  await page.evaluate(() => {
    Object.defineProperty(visualViewport, 'height', { value: 275 });
    visualViewport.dispatchEvent(new Event('resize'));
  });

  const after = await measure();

  for (const frame of [before, after]) {
    assert.equal(frame.dockTopOffset, 0);
    assert.equal(frame.dockRightOffset, 0);
    assert.equal(frame.dockBottomOffset, 0);
    assert.equal(frame.actionHeight, 36);
    assert.ok(frame.rails.every((rail) => rail.scrollbar === 'none' && rail.gutter === 0));
  }

  assert.ok(after.rails.every((rail) => rail.overflow));
  assert.deepEqual(after.rails.map((rail) => rail.center), before.rails.map((rail) => rail.center));

  await page.getByRole('button', { name: 'Во весь экран', exact: true }).click();
  assert.equal(await dock.evaluate((element) => element.getBoundingClientRect().left),
    await page.locator('.shell > .content').evaluate((element) => element.getBoundingClientRect().left));
  await page.locator('[data-context="tool-dock-hide"]').click();
  assert.equal(await dock.count(), 0);
});

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
