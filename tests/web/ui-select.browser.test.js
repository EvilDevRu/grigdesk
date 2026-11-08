import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { chromium } from '../../desktop/node_modules/playwright-core/index.mjs';
import { clientBrowser } from './helpers/client-browser.mjs';

/**
 * Проверка выполняется до clientBrowser, который начинает слушать раньше launch.
 * Ошибка окружения остаётся ошибкой, не превращаясь в skip или зависший Vite.
 */
async function fixture(t) {
  const binary = process.env.CHROME_BIN || chromium.executablePath();

  assert.equal(existsSync(binary), true, 'нужен установленный Chromium или CHROME_BIN');

  const artifacts = path.join(process.env.GRIGDESK_ARTIFACTS_DIR
    || '/tmp/grigdesk-select-artifacts', 'select-component');

  return clientBrowser(t, { artifacts });
}

/**
 * Каталог содержит несколько исполнителей и настоящую форму непрозрачного GLM id.
 * Проверяется весь экран чата с синтетическим API, без доступа к переписке пользователя.
 */
function chatCatalog() {
  return [
    ['claude', 'Claude', ['Opus', 'Sonnet', 'Haiku']],
    ['codex', 'Codex', ['Sol', 'Astra', 'Terra', 'Luna', 'Mini', 'Pro', 'Fast', 'Code']],
    ['kimi', 'Kimi', ['Kimi']],
    ['deepseek', 'DeepSeek', ['Pro', 'Flash', 'Vision', 'Lite', 'Code', 'Fast']],
    ['glm', 'GLM (Z.ai)', ['GLM-5.3', 'GLM-5.2', 'GLM-5-Turbo', 'GLM-4.7']],
  ].map(([id, name, names], index) => ({
    id,
    name,
    color: ['#d97757', '#10a37f', '#6657d9', '#4D6BFE', '#FFFFFF'][index],
    available: true,
    modes: [
      {
        id: 'ask',
        label: 'Вручную',
        hint: 'Подтверждать действия',
      },
      {
        id: 'auto',
        label: 'Авто',
        hint: 'Автоматический режим',
      },
    ],
    models: names.map((label) => ({
      id: id === 'glm' ? JSON.stringify(['zai', label.toLowerCase()]) : id + '-' + label,
      name: label,
      efforts: ['low', 'high'],
      contextRuntimeOnly: true,
    })),
  }));
}

test('SELECT-CHAT-BROWSER: модели на десктопе, телефоне и в низком viewport', async (t) => {
  const providers = chatCatalog();
  const glm = providers.at(-1);

  // Кэш моделей Claude сохраняется в реестре, даже когда текущая проверка не прошла.
  // Выбор обязан скрыть и вкладку, и эти прежние модели.
  providers[0].available = false;

  providers.push({
    id: 'disabled-executor',
    name: 'Отключённый исполнитель',
    chatEnabled: false,
    available: true,
    models: [{
      id: 'disabled-model',
      name: 'Скрытая модель',
      efforts: [],
      contextRuntimeOnly: true,
    }],
  });

  const session = {
    id: 'model-picker-chat',
    title: 'Выбор модели',
    model: glm.models[0].id,
    modelRef: { provider: 'glm', model: glm.models[0].id },
    messages: [],
  };
  const client = await clientBrowser(t, {
    artifacts: path.join(process.env.GRIGDESK_ARTIFACTS_DIR || '/tmp/grigdesk-select-artifacts',
      'model-picker'),
    chatStore: { sessions: [session], activeId: session.id },
    responses: { '/api/providers': { providers, models: [] } },
  });
  const errors = [];

  for (const [width, height, touch] of [
    [1440, 1000, false],
    [390, 844, true],
    [320, 568, true],
    [844, 390, true],
    [390, 430, true],
  ]) {
    const context = await client.browser.newContext({
      viewport: { width, height },
      hasTouch: touch,
      isMobile: touch,
      locale: 'ru-RU',
    });

    try {
      const page = await context.newPage();

      page.on('pageerror', (error) => errors.push(error.message));
      await page.addInitScript(() => localStorage.setItem('grigdesk-ui-language', 'ru'));
      await page.goto(client.origin + '#/chats');
      await page.locator('.cl .row-hit').first().click();

      const options = page.locator('.phone-options');

      if (await options.isVisible()) {
        await options.click();
      }

      const trigger = page.locator('button[data-role="chat-model"]');

      await trigger.waitFor();
      await page.locator('.cs:not(.frozen)').waitFor();

      const toolbarStyles = await page.locator('button[data-context="chat-session-toolbar"]')
        .evaluateAll((buttons) => buttons.map((button) => {
          const style = getComputedStyle(button);

          return {
            height: style.height,
            padding: style.padding,
            border: style.border,
            radius: style.borderRadius,
            background: style.backgroundColor,
            chevron: style.backgroundPosition,
            fontSize: style.fontSize,
          };
        }));

      assert.equal(toolbarStyles.length, 3);
      assert.deepEqual(toolbarStyles[0], toolbarStyles[1]);
      assert.deepEqual(toolbarStyles[1], toolbarStyles[2]);
      assert.equal(toolbarStyles[0].height, touch ? '44px' : '28px');
      assert.equal(toolbarStyles[0].radius, '4px');
      await page.locator('.cs-top').screenshot({
        path: path.join(client.artifacts, `chat-header-${width}x${height}.png`),
      });

      const selectBounds = await page.locator('button[data-context="chat-session-toolbar"]')
        .evaluateAll((fields) => {
        const boxes = fields.map((field) => field.getBoundingClientRect());
        const left = Math.min(...boxes.map((box) => box.left)) - 4;
        const top = Math.min(...boxes.map((box) => box.top)) - 4;

        return {
          x: left,
          y: top,
          width: Math.max(...boxes.map((box) => box.right)) - left + 4,
          height: Math.max(...boxes.map((box) => box.bottom)) - top + 4,
        };
      });

      await page.screenshot({
        path: path.join(client.artifacts, `chat-selects-${width}x${height}.png`),
        clip: selectBounds,
      });

      if (touch) {
        await trigger.tap();
      } else {
        await trigger.click();
      }

      const popup = page.locator('.ui-select-popup');

      await popup.waitFor({ state: 'visible' });
      assert.equal(await popup.getByRole('option').count(), 4);
      assert.equal(await trigger.locator('svg').count(), 1);
      assert.equal(await popup.locator('.ui-select-group-nav svg').count(), 5);
      assert.equal(await popup.getByRole('button', { name: 'Claude', exact: true }).count(), 0);
      assert.equal(await popup.locator('[role="option"] svg').count(), 4);
      assert.equal((await popup.innerText()).includes('Отключённый исполнитель'), false);
      assert.equal((await popup.innerText()).includes('["zai"'), false);
      assert.equal((await popup.innerText()).includes('после первого хода'), false);

      const codexIcon = popup.getByRole('button', { name: 'Codex', exact: true }).locator('svg');

      assert.equal(await codexIcon.evaluate((node) => getComputedStyle(node).color), 'rgb(16, 163, 127)');

      const geometry = await popup.evaluate((node) => {
        const box = node.getBoundingClientRect();
        const list = node.querySelector('[role="listbox"]');
        const buttons = [...node.querySelectorAll('.ui-select-group-nav button, [role="option"]')];
        const search = node.querySelector('input[type="search"]');
        const searchStyle = getComputedStyle(search);
        const groupButtons = [...node.querySelectorAll('.ui-select-group-nav [data-group-icon]')];

        return {
          left: box.left,
          right: box.right,
          top: box.top,
          bottom: box.bottom,
          overflow: node.scrollWidth > node.clientWidth + 1,
          listHeight: list.clientHeight,
          minButtonHeight: Math.min(...buttons.map((button) => {
            const height = button.getBoundingClientRect().height;
            const after = getComputedStyle(button, '::after');

            return after.content === 'none' ? height : Math.max(height, Number.parseFloat(after.height) || 0);
          })),
          searchFocused: document.activeElement === node.querySelector('input[type="search"]'),
          searchHeight: search.getBoundingClientRect().height,
          searchRadius: searchStyle.borderRadius,
          searchShadow: searchStyle.boxShadow,
          searchFontSize: Number.parseFloat(searchStyle.fontSize),
          labelsHidden: groupButtons.every((button) => {
            return getComputedStyle(button.querySelector('.ui-button__label')).display === 'none';
          }),
          navigationHeight: node.querySelector('.ui-select-group-nav').getBoundingClientRect().height,
        };
      });

      assert.equal(geometry.left >= 0 && geometry.right <= width, true);
      assert.equal(geometry.top >= 0 && geometry.bottom <= height, true);
      assert.equal(geometry.overflow, false);
      assert.equal(geometry.listHeight >= 44, true);
      assert.equal(geometry.searchFocused, !touch);
      assert.equal(geometry.searchHeight, touch ? 44 : 28);
      assert.equal(geometry.searchRadius, '4px');
      assert.equal(geometry.searchShadow, 'none');
      assert.equal(geometry.labelsHidden, true);
      assert.equal(geometry.navigationHeight <= (touch ? 50 : 34), true);

      if (touch) {
        assert.equal(geometry.minButtonHeight >= 44, true);
      }

      if (width <= 600) {
        assert.equal(geometry.searchFontSize >= 16, true);
      }

      await page.screenshot({ path: path.join(client.artifacts, `models-${width}x${height}.png`) });
      await popup.screenshot({ path: path.join(client.artifacts, `models-menu-${width}x${height}.png`) });

      const codex = popup.getByRole('button', { name: /^Codex/u });

      if (touch) {
        const target = await codex.boundingBox();

        assert.ok(target);
        // Знак группы занимает 32 px, прозрачная площадка — 44 px.
        // Нажатие у нижнего края доказывает работу расширения за пределами рисунка.
        await page.touchscreen.tap(target.x + target.width / 2, target.y + target.height / 2 + 21);
      } else {
        await codex.click();
      }

      assert.equal(await popup.getByRole('option').count(), 8);
      assert.equal(await trigger.innerText(), 'GLM-5.3');
      await popup.locator('input[type="search"]').fill('GLM-4.7');
      assert.equal(await popup.getByRole('option').count(), 1);
      await popup.locator('input[type="search"]').press('Enter');
      await popup.waitFor({ state: 'hidden' });
      assert.equal(await trigger.innerText(), 'GLM-4.7');

      await trigger.click();
      await popup.waitFor({ state: 'visible' });
      await popup.locator('[data-select-group="all"]').click();
      assert.equal(await popup.getByRole('option').count(), 19);
      assert.equal((await popup.innerText()).includes('Скрытая модель'), false);
      await popup.locator('input[type="search"]').fill('Opus');
      assert.equal(await popup.getByRole('option').count(), 0);
      assert.equal(await trigger.innerText(), 'GLM-4.7');
      await page.keyboard.press('Escape');
      await popup.waitFor({ state: 'hidden' });
    } finally {
      await context.close();
    }
  }

  assert.deepEqual(errors, []);
});

/**
 * Локальный marker проверяет перенос режима через Teleport без помощи root-токенов.
 * На touch-странице сохраняем тип настоящего pointer-события для проверки tap.
 */
async function prepare(page, origin, touch) {
  await page.goto(origin + 'ui-gallery.html');
  await page.locator('[data-select-demo]').waitFor();
  await page.evaluate((enabled) => {
    document.documentElement.removeAttribute('data-ui-touch');
    document.querySelector('[data-select-demo]').toggleAttribute('data-ui-touch', enabled);
    document.addEventListener('pointerdown', (event) => {
      document.documentElement.dataset.selectPointer = event.pointerType;
    }, { capture: true });
  }, touch);
}

/**
 * Геометрия измеряется на полном каталоге до фильтрации и в системе visualViewport.
 * Отдельно проверяем перенос текста, доступность конца списка и локальные control-токены.
 */
async function geometry(page) {
  return page.locator('.ui-select-popup').evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const list = node.querySelector('[role="listbox"]');
    const label = node.querySelector('[data-option-index="1"] .ui-select-option__label');
    const option = label.closest('[role="option"]');
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft || 0;
    const top = viewport?.offsetTop || 0;
    const width = viewport?.width || innerWidth;
    const height = viewport?.height || innerHeight;

    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      width: rect.width,
      bounds: {
        left,
        top,
        right: left + width,
        bottom: top + height,
      },
      triggerWidth: document.querySelector('button[data-select-demo-trigger]').getBoundingClientRect().width,
      localTouch: node.hasAttribute('data-ui-touch'),
      workspace: node.hasAttribute('data-ui-workspace'),
      controlHeight: Number.parseFloat(getComputedStyle(node).getPropertyValue('--control-height')),
      optionHeight: option.getBoundingClientRect().height,
      wraps: getComputedStyle(label).whiteSpace === 'normal',
      labelWidthFits: label.scrollWidth <= label.clientWidth + 1,
      labelHeight: label.getBoundingClientRect().height,
      lineHeight: Number.parseFloat(getComputedStyle(label).lineHeight),
      listScrolls: list.scrollHeight > list.clientHeight,
      overflow: node.scrollWidth > node.clientWidth + 1,
    };
  });
}

test('SELECT-GEOMETRY-01: полный каталог, локальный touch, pinch и длинные названия', async (t) => {
  const client = await fixture(t);
  const errors = [];

  for (const [width, height, touch, scale] of [
    [1440, 1000, false, 1],
    [390, 844, true, 1],
    [844, 390, true, 1],
    [320, 568, true, 1],
    [320, 568, true, 1.6],
  ]) {
    const context = await client.browser.newContext({
      viewport: { width, height },
      hasTouch: touch,
      isMobile: touch,
    });

    try {
      const page = await context.newPage();

      page.on('pageerror', (error) => {
        errors.push(error.message);
      });
      await prepare(page, client.origin, touch);

      if (scale !== 1) {
        const cdp = await context.newCDPSession(page);

        await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: scale });
      }

      const trigger = page.locator('button[data-select-demo-trigger]');

      await trigger.scrollIntoViewIfNeeded();

      if (touch) {
        await trigger.tap();
        assert.equal(await page.locator('html').getAttribute('data-select-pointer'), 'touch');
      } else {
        await trigger.click();
      }

      const popup = page.locator('.ui-select-popup');

      await popup.waitFor({ state: 'visible' });
      await page.waitForFunction((touch) => {
        const selector = touch ? '.ui-select-popup [role="listbox"]'
          : '.ui-select-popup input[type="search"]';

        return document.querySelector(selector) === document.activeElement;
      }, touch);

      const box = await geometry(page);

      assert.equal(box.left >= box.bounds.left - 1, true);
      assert.equal(box.right <= box.bounds.right + 1, true);
      assert.equal(box.top >= box.bounds.top - 1, true);
      assert.equal(box.bottom <= box.bounds.bottom + 1, true);
      assert.equal(box.width > box.triggerWidth, true);
      assert.equal(box.workspace, true);
      assert.equal(box.wraps, true);
      assert.equal(box.labelWidthFits, true);
      assert.equal(box.labelHeight > box.lineHeight + 1, true);
      assert.equal(box.listScrolls, true);
      assert.equal(box.overflow, false);

      if (touch) {
        assert.equal(box.localTouch, true);
        assert.equal(box.controlHeight, 44);
        assert.equal(box.optionHeight >= 44, true);
      }

      const listbox = popup.getByRole('listbox');

      await listbox.evaluate((node) => {
        node.scrollTop = node.scrollHeight;
      });
      assert.equal(await popup.getByRole('option', { name: 'Настоящий disabled', exact: true })
        .evaluate((node) => {
          const row = node.getBoundingClientRect();
          const list = node.closest('[role="listbox"]').getBoundingClientRect();

          return row.top >= list.top - 1 && row.bottom <= list.bottom + 1;
        }), true);
      await listbox.evaluate((node) => {
        node.scrollTop = 0;
      });
      await page.screenshot({
        path: path.join(client.artifacts, 'select-open-' + width + 'x' + height + '-' + scale + '.png'),
      });
    } finally {
      await context.close();
    }
  }

  assert.deepEqual(errors, []);
});

test('SELECT-BROWSER-02: поиск, label, короткий список и независимые поля общей группы', async (t) => {
  const client = await fixture(t);
  const page = await client.browser.newPage({ viewport: { width: 1440, height: 1000 } });

  await prepare(page, client.origin, false);

  const trigger = page.locator('button[data-select-demo-trigger]');
  const secondary = page.locator('button[data-select-secondary-trigger]');

  assert.notEqual(await trigger.getAttribute('id'), await secondary.getAttribute('id'));
  await page.locator('[data-select-demo] .ui-select-actions button').click();
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(await page.locator('[data-select-demo-actions]').textContent(), '1');
  await page.locator('[data-select-demo] label').first().click();

  const popup = page.locator('.ui-select-popup');
  const search = popup.locator('input[type="search"]');

  await popup.waitFor({ state: 'visible' });
  await page.waitForFunction(() => {
    return document.querySelector('.ui-select-popup input[type="search"]') === document.activeElement;
  });
  await search.fill('REPO/SPECIAL');
  assert.equal(await popup.getByRole('option').count(), 1);
  assert.equal(await popup.getByRole('group').getAttribute('aria-label'), 'Второй провайдер — недоступен');
  await search.press('Enter');
  await popup.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('[data-select-demo-value]').textContent(), 'repo/special');
  assert.equal(await page.locator('[data-select-demo-priority]').textContent(), 'low');
  assert.equal(await trigger.evaluate((node) => node === document.activeElement), true);
  await secondary.click();
  await popup.waitFor({ state: 'visible' });
  await page.waitForFunction(() => {
    return document.querySelector('.ui-select-popup [role="listbox"]') === document.activeElement;
  });
  assert.equal(await popup.locator('input[type="search"]').count(), 0);
  await popup.getByRole('listbox').press('End');
  await popup.getByRole('listbox').press('Space');
  await popup.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('[data-select-demo-priority]').textContent(), 'high');
  assert.equal(await page.locator('[data-select-demo-value]').textContent(), 'repo/special');
  await page.locator('[data-select-common-action]').click();
  assert.equal(await page.locator('[data-select-demo-common]').textContent(), '1');
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(await secondary.getAttribute('aria-expanded'), 'false');
  await trigger.focus();
  await trigger.press('ArrowDown');
  await popup.waitFor({ state: 'visible' });
  await popup.getByRole('button', { name: 'Добавить', exact: true }).click();
  await popup.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('[data-select-demo-actions]').textContent(), '2');
  assert.equal(await page.locator('[data-select-demo-value]').textContent(), 'repo/special');
});

test('SELECT-BROWSER-03: required, FormData, reset, Tab, язык и вложенный Escape', async (t) => {
  const client = await fixture(t);
  const page = await client.browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];

  page.on('pageerror', (error) => {
    errors.push(error.message);
  });
  page.on('console', (message) => {
    if (message.type() === 'error' && /invalid form control/u.test(message.text())) {
      errors.push(message.text());
    }
  });
  await prepare(page, client.origin, true);

  const form = page.locator('[data-select-demo-form]');
  const trigger = page.locator('button[data-select-demo-trigger]');

  assert.equal(await form.evaluate((node) => node.reportValidity()), false);
  assert.equal(await trigger.evaluate((node) => node === document.activeElement), true);
  await trigger.click();

  const popup = page.locator('.ui-select-popup');

  await popup.locator('input[type="search"]').fill('repo/special');
  await popup.getByRole('option').click();
  await popup.waitFor({ state: 'hidden' });
  assert.equal(await form.evaluate((node) => node.reportValidity()), true);
  assert.deepEqual(await form.evaluate((node) => new FormData(node).getAll('demoModel')), ['repo/special']);
  assert.equal(await page.locator('[data-select-demo-changes]').textContent(), '1');
  assert.equal(await page.locator('[data-select-demo-updates]').textContent(), '1');
  await form.evaluate((node) => node.reset());
  await page.waitForFunction(() => {
    return document.querySelector('select[name="demoModel"]').value === 'repo/special';
  });
  assert.equal(await page.locator('[data-select-demo-changes]').textContent(), '1');
  assert.equal(await page.locator('[data-select-demo-updates]').textContent(), '1');
  await trigger.click();
  await popup.getByRole('button', { name: 'Добавить', exact: true }).focus();
  await page.keyboard.press('Tab');
  await popup.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('[data-select-demo] .ui-select-actions button')
    .evaluate((node) => node === document.activeElement), true);
  await trigger.click();
  await popup.locator('input[type="search"]').press('Shift+Tab');
  await popup.waitFor({ state: 'hidden' });

  await page.locator('[data-select-open-dialog]').click();

  const dialog = page.locator('.ui-dialog');
  const dialogTrigger = page.locator('button[data-select-dialog-trigger]');

  await dialog.waitFor({ state: 'visible' });
  await dialogTrigger.click();

  const search = popup.locator('input[type="search"]');

  await search.fill('нет результата');
  assert.equal(await search.evaluate((node) => node === document.activeElement), true);
  assert.equal(await search.evaluate((node) => Boolean(node.closest('[inert]'))), false);
  await page.evaluate(async () => {
    const { setUiLocale } = await import('/src/ui.ts');

    setUiLocale('en');
  });

  const emptyLabel = await popup.getByRole('status').textContent();

  assert.equal(emptyLabel.trim(), 'No options found');
  assert.equal(await search.inputValue(), 'нет результата');
  assert.equal(await search.evaluate((node) => node === document.activeElement), true);
  assert.equal(await dialogTrigger.textContent().then((value) => value.trim()), 'Без выбора');
  await page.evaluate(async () => {
    const { setUiLocale } = await import('/src/ui.ts');

    setUiLocale('ru');
  });
  await search.press('Escape');
  await popup.waitFor({ state: 'hidden' });
  assert.equal(await dialog.isVisible(), true);
  assert.equal(await dialogTrigger.evaluate((node) => node === document.activeElement), true);
  await dialogTrigger.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  assert.deepEqual(errors, []);
});
