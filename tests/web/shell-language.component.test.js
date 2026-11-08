import assert from 'node:assert/strict';
import test from 'node:test';

import { i18nComponent, prepareI18nWindow } from './helpers/i18nComponent.js';
import { catalogMessage } from './helpers/i18nCatalog.js';
import { pluginCard } from './helpers/pluginModuleContract.js';

process.env.NODE_ENV = 'test';

// Vite загружает runtime-dom; к этому моменту он должен увидеть то же окно,
// в котором ниже монтируются компоненты, иначе document останется null.
await prepareI18nWindow();

const { i18nBrowser, chooseLanguage } = await import('./helpers/i18nBrowser.js');

test('I18N-U01: EN/RU каркас, builtin/custom/disabled и прежний порядок rail/tools/dock', {
  timeout: 120000,
}, async (t) => {
  const plugins = [
    { 
      id: 'code', 
      name: 'Код', 
      system: true, 
      enabled: true,
      
      nav: { 
        path: '/code', 
        label: 'Код', 
        group: 'tools', 
        order: 10 
      } 
    },
    { 
      id: 'custom', 
      name: 'Домашний плагин', 
      system: false, 
      enabled: true, 
      web: 'index.html',
      
      nav: { 
        path: '/custom', 
        label: 'Домашний плагин', 
        group: 'tools', 
        order: 10 
      } 
    },
    { 
      id: 'off', 
      name: 'Выключенный плагин', 
      enabled: false,
      
      nav: { 
        path: '/off', 
        label: 'Выключенный плагин', 
        group: 'rail', 
        order: 10 
      } 
    },
    { 
      id: 'docker', 
      name: 'Докер', 
      system: true, 
      enabled: true,
      
      nav: { 
        path: '/docker', 
        label: 'Докер', 
        group: 'rail', 
        order: 10 
      } 
    },
    { 
      id: 'custom-rail', 
      name: 'Абажур', 
      system: false, 
      enabled: true, 
      web: 'index.html',
      
      nav: { 
        path: '/custom-rail', 
        label: 'Абажур', 
        group: 'rail', 
        order: 10 
      } 
    },
    { 
      id: 'db', 
      name: 'Базы', 
      system: true, 
      enabled: true,
      
      nav: { 
        path: '/db', 
        label: 'Базы', 
        group: 'dock', 
        order: 10 
      } 
    },
    { 
      id: 'custom-dock', 
      name: 'Ящик', 
      system: false, 
      enabled: true, 
      web: 'index.html',
      
      nav: { 
        path: '/custom-dock', 
        label: 'Ящик', 
        group: 'dock', 
        order: 10 
      } 
    },
  ].map((plugin) => plugin.system || !plugin.enabled ? plugin : pluginCard({
    ...plugin,
    contributes: { panels: [{ title: plugin.name, group: plugin.nav.group }], slots: [] },
    placements: [],
  }));
  const { browser, origin } = await i18nBrowser(t, {
    responses: { '/api/plugins': { plugins } },
  });
  const context = await browser.newContext({ locale: 'ru-RU' });

  t.after(() => context.close());

  const page = await context.newPage();

  await page.goto(origin + '#/chats');
  await page.getByRole('button', { name: 'Настройки', exact: true }).waitFor();

  const before = await page.evaluate(() => {
    const plugins = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia
      ._s.get('plugins');

    return ['railNav', 'toolsNav', 'dockNav'].map((group) =>
      plugins[group].map((item) => [item.id, item.to]));
  });

  await chooseLanguage(page, 'en');
  assert.equal(await page.getByRole('button', { name: 'Settings', exact: true }).isVisible(), true);
  assert.equal(await page.locator('.navitem[href="#/docker"]').getAttribute('aria-label'), 'Docker');
  assert.equal(await page.locator('.navitem[href*="custom-rail"]').getAttribute('aria-label'), 'Абажур');
  assert.equal(await page.locator('.navitem[href="#/off"]').count(), 0);

  const after = await page.evaluate(() => {
    const plugins = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia
      ._s.get('plugins');

    return ['railNav', 'toolsNav', 'dockNav'].map((group) =>
      plugins[group].map((item) => [item.id, item.to]));
  });

  assert.deepEqual(after, before);
  assert.equal(await page.title(), 'GrigDesk');
  await chooseLanguage(page, 'ru');
  assert.equal(await page.getByRole('button', { name: 'Настройки', exact: true }).isVisible(), true);
});

test('I18N-U02: топбар без поиска команд, соседние действия и локальный поиск RU/EN', {
  timeout: 120000,
}, async (t) => {
  const profile = {
    id: 'topbar-machine',
    name: 'Тестовая машина',
    kind: 'remote',
    address: 'https://machine.example:443',
    status: 'online',
  };
  const { browser, origin } = await i18nBrowser(t, {
    shell: {
      rev: 1,
      profile,
      profiles: [profile],
      status: 'online',
      detail: null,
      localAvailable: false,
      serverApi: { major: 0, minor: 1 },
      appApi: { major: 0, minor: 1 },
      capabilities: [],
    },
    responses: {
      '/api/system': {
        cpu: { percent: 12, cores: 8 },
        mem: {
          percent: 25,
          usedGb: 4,
          totalGb: 16,
        },
        net: { ip: '203.0.113.1', countryCode: 'GB' },
      },
    },
  });

  for (const locale of ['ru-RU', 'en-US']) {
    const context = await browser.newContext({ locale });

    t.after(() => context.close());

    const page = await context.newPage();

    for (const width of [1440, 600]) {
      await page.setViewportSize({ width, height: 900 });

      for (const route of ['/chats', '/routes']) {
        await page.goto(origin + '#' + route);

        const actions = page.locator('.topbar-actions');
        const settings = actions.getByRole('button', { name: /^(Настройки|Settings)$/ });

        await settings.waitFor();
        await actions.locator('[data-context="connection-trigger"]').waitFor();
        assert.equal(await actions.getByRole('button', { name: /поиск|search/i }).count(), 0);

        const phone = width === 600;

        // Телефон и справка на узком экране перенесены в «Разделы».
        // Подключение, колокольчик и настройки остаются в основной полосе.
        assert.equal(await actions.getByRole('button').count(), phone ? 3 : 5);
        assert.equal(
          await actions.getByRole('button', { name: /^(Подключить телефон|Connect phone)$/ }).count(),
          phone ? 0 : 1,
        );
        assert.equal(await actions.locator('[data-context="alert-history"]').isVisible(), true);

        if (phone) {
          await page.locator('.phone-nav').getByRole('button', { name: /^(Разделы|Sections)$/ }).click();
          await page.locator('[data-role="phone-sections"]')
            .getByRole('button', { name: /^(Подключить телефон|Connect phone)$/ }).waitFor();
        }

        await page.locator('[data-context="topbar-network"]').waitFor();
        await page.locator('[data-context="provider-status"]').first().waitFor();

        if (phone) {
          await page.keyboard.press('Escape');
          await page.locator('[data-role="phone-sections"]').waitFor({ state: 'hidden' });
        }

        const unusedWidth = await actions.evaluate((element) => {
          const buttons = [...element.querySelectorAll('button')];
          const occupied = buttons.reduce((sum, button) => sum + button.getBoundingClientRect().width, 0);

          return element.getBoundingClientRect().width - occupied;
        });

        assert.ok(Math.abs(unusedWidth) < 1, 'В группе действий нет пустого места от палитры');

        await actions.locator('[data-context="connection-trigger"]').click();
        await page.locator('[data-connection-menu]').waitFor();
        await page.keyboard.press('Escape');
        await actions.locator('[data-context="alert-history"]').click();
        await page.locator('.alert-history').waitFor();
        await page.keyboard.press('Escape');

        if (route === '/chats') {
          const search = page.locator('.cl').getByRole('searchbox');

          await page.locator('.cl .row-hit').first().waitFor();
          await search.fill('no-such-chat-93013');
          await page.locator('.cl .none').waitFor();
          assert.equal(await page.locator('.cl .row-hit').count(), 0);
          await search.fill('');
          await page.locator('.cl .row-hit').first().waitFor();
        }

        await settings.click();
        await page.locator('[data-role="settings-modal"]').waitFor();

        const search = page.getByRole('searchbox', { name: /^(Поиск настроек|Search settings)$/ });

        if (!await search.isVisible()) {
          await page.getByRole('button', { name: /^(Разделы|Sections)$/ }).click();
        }

        await search.fill(locale === 'ru-RU' ? 'клавиши' : 'keyboard');
        await page.locator('[data-settings-result]').first().waitFor();
        assert.match(await page.locator('.settings-results').textContent(),
          /Сочетания клавиш|[Kk]eyboard|[Ss]hortcut/);
        await page.keyboard.press('Escape');
        await page.locator('[data-role="settings-modal"]').waitFor({ state: 'hidden' });
        assert.equal(await settings.evaluate((element) => document.activeElement === element), true);
      }
    }
  }
});

test('I18N-U03: открытые confirm/prompt/error/toast и история меняют перевод без повторных действий',
  async (t) => {
    const h = await i18nComponent(t);
    const title = await catalogMessage('core', 'Настройки');
    const ref = h.module.i18nCore.messageRef(title.key);
    const wrapper = h.mount({
      render: () => h.h('div', [h.h(h.module.UiDialogHost), h.h(h.module.UiToastHost),
        h.h(h.module.AlertHistoryPopover)]),
    }, { attachTo: document.body, global: { plugins: [h.pinia], stubs: { transition: false } } });

    t.after(() => {
      h.module.dismissAllAlerts();
      h.module.clearAlertHistory();
      wrapper.unmount();
    });

    let ran = 0;
    const raw = 'Ошибка сервера: core.settings {raw}';

    h.module.alertUser({
      id: 'language-toast',
      title: ref,
      body: raw,
      sticky: true,
      actions: [{ 
        id: 'once', 
        label: ref, 
        run: () => { 
        ran += 1; 
      } 
      }],
    });

    const confirming = h.module.confirmDialog(ref);

    await h.flushPromises();
    assert.match(document.querySelector('.ui-toast')?.textContent || '', new RegExp(title.ru));
    await h.module.localeAdapter.setUiLanguage('en');
    await h.flushPromises();
    assert.match(document.querySelector('.ui-toast')?.textContent || '', new RegExp(title.en));
    assert.match(document.querySelector('[role="dialog"]')?.textContent || '', new RegExp(title.en));
    assert.ok(document.body.textContent.includes(raw));
    assert.equal(ran, 0);

    const yes = [...document.querySelectorAll('[role="dialog"] button')]
      .find((button) => button.textContent.trim() === 'Yes');

    assert.equal(Boolean(yes), true);
    yes.click();
    assert.equal(await confirming, true);

    const prompt = h.module.promptDialog({ title: ref, value: 'Набранный текст' });

    await h.flushPromises();

    const input = document.querySelector('[role="dialog"] input, [role="dialog"] textarea');

    assert.equal(Boolean(input), true);
    input.value = 'Ввод человека';
    input.dispatchEvent(new h.win.Event('input', { bubbles: true }));
    await h.module.localeAdapter.setUiLanguage('ru');
    await h.flushPromises();
    assert.equal(document.querySelector('[role="dialog"] input, [role="dialog"] textarea') === input, true);
    assert.equal(input.value, 'Ввод человека');

    const cancel = [...document.querySelectorAll('[role="dialog"] button')]
      .find((button) => button.textContent.trim() === 'Отмена');

    cancel.click();
    assert.equal(await prompt, null);

    const alerting = h.module.alertDialog(raw);

    await h.flushPromises();
    await h.module.localeAdapter.setUiLanguage('en');
    await h.flushPromises();
    assert.ok(document.querySelector('[role="alertdialog"]').textContent.includes(raw));

    const understood = [...document.querySelectorAll('[role="alertdialog"] button')]
      .find((button) => /^(OK|Got it|Understood)$/.test(button.textContent.trim()));

    assert.equal(Boolean(understood), true);
    understood.click();
    await alerting;

    const action = document.querySelector('.ui-toast__actions button');

    assert.equal(Boolean(action), true);
    action.click();
    await h.flushPromises();
    assert.equal(ran, 1);
    await wrapper.find('[data-context="alert-history"]').trigger('click');
    await h.flushPromises();
    assert.match(document.querySelector('.alert-history-title')?.textContent || '', new RegExp(title.en));
    await h.module.localeAdapter.setUiLanguage('ru');
    await h.flushPromises();
    assert.match(document.querySelector('.alert-history-title')?.textContent || '', new RegExp(title.ru));
  });

test('I18N-U04: уже смонтированные spinner/search/password/file/inline-confirm меняют defaults',
  async (t) => {
  const h = await i18nComponent(t);
  const component = {
    render: () => h.h('div', [
      h.h(h.module.UiSpinner),
      h.h(h.module.UiSearchInput, { modelValue: 'запрос' }),
      h.h(h.module.UiPasswordInput),
      h.h(h.module.UiFilePicker),
      h.h(h.module.UiInlineConfirm, { modelValue: true, question: 'Raw вопрос' }),
    ]),
  };
  const wrapper = h.mount(component, { attachTo: document.body });

  t.after(() => wrapper.unmount());
  assert.match(wrapper.html(), /Загрузка/);
  await h.module.localeAdapter.setUiLanguage('en');
  await h.flushPromises();
  assert.equal(wrapper.find('[role="status"]').attributes('aria-label'), 'Loading');
  assert.equal(wrapper.find('[aria-label="Clear search"]').exists(), true);
  assert.equal(wrapper.find('[aria-label="Show password"]').exists(), true);
  assert.match(wrapper.text(), /Choose file|Select file/);
  assert.match(wrapper.text(), /Confirm/);
  assert.match(wrapper.text(), /Cancel/);
  assert.ok(wrapper.text().includes('Raw вопрос'));
  await h.module.localeAdapter.setUiLanguage('ru');
  await h.flushPromises();
  assert.equal(wrapper.find('[role="status"]').attributes('aria-label'), 'Загрузка');
});

test('I18N-U05: исходное имя local переводится только при показе, удалённое сохраняется побайтно',
  async (t) => {
  const h = await i18nComponent(t);
  const profiles = [
    { 
      id: 'local', 
      kind: 'local', 
      name: 'Этот компьютер', 
      status: 'online' 
    },
    { 
      id: 'remote', 
      kind: 'remote', 
      name: 'Домашний ПК', 
      status: 'offline' 
    },
  ];
  const shell = h.module.useShellStore(h.pinia);

  shell.apply({ 
    rev: 1, 
    profile: profiles[0], 
    profiles, 
    status: 'online', 
    localAvailable: true,
    capabilities: [] 
  });

  const wrapper = h.mount(h.module.ConnectionButton, {
    attachTo: document.body,
    global: { plugins: [h.pinia] },
  });

  t.after(() => wrapper.unmount());
  assert.equal(wrapper.find('.connection-label').text(), 'Этот компьютер');
  await h.module.localeAdapter.setUiLanguage('en');
  await h.flushPromises();

  const label = await catalogMessage('core', 'Этот компьютер');

  assert.equal(wrapper.find('.connection-label').text(), label.en);
  await wrapper.find('[data-context="connection-trigger"]').trigger('click');
  await h.flushPromises();
  assert.equal(Boolean(document.querySelector(`[aria-label="${label.en}"]`)), true);
  assert.equal(Boolean(document.querySelector('[aria-label="Домашний ПК"]')), true);
  assert.deepEqual(shell.profiles.map((profile) => profile.name), ['Этот компьютер', 'Домашний ПК']);
  await h.module.localeAdapter.setUiLanguage('ru');
  await h.flushPromises();
  assert.equal(wrapper.find('.connection-label').text(), 'Этот компьютер');
});

test('I18N-U01/gates: вход и блокировка переводятся, raw отказ сервера сохраняется', async (t) => {
  const raw = 'Ошибка сервера: доступ отклонён';
  const h = await i18nComponent(t, {
    fetch: async () => new Response(JSON.stringify({ error: 'test_error', message: raw }), { status: 400 }),
  });
  const wrapper = h.mount({
    render: () => h.h('div', [h.h(h.module.NoAccessView), h.h(h.module.LockOverlay)]),
  }, { attachTo: document.body, global: { plugins: [h.pinia], stubs: { transition: false } } });

  t.after(() => wrapper.unmount());
  await h.module.localeAdapter.setUiLanguage('en');
  await h.flushPromises();
  assert.match(wrapper.find('.no-access').text(), /GrigDesk/);
  assert.doesNotMatch(wrapper.find('.no-access').text(), /[А-Яа-яЁё]/);

  const dialog = document.querySelector('[role="dialog"]');

  assert.equal(Boolean(dialog), true);
  assert.doesNotMatch(dialog.textContent, /[А-Яа-яЁё]/);
  dialog.querySelector('button').click();
  await h.flushPromises();
  assert.ok(document.body.textContent.includes(raw));
});


test('RET-NAV: старая ссылка открывает маршруты без пункта библиотеки', {
  timeout: 120000,
}, async (t) => {
  const { browser, origin } = await i18nBrowser(t, {
    responses: { '/api/profiles': { profiles: [] } },
  });

  for (const locale of ['ru-RU', 'en-US']) {
    for (const touch of [false, true]) {
      await t.test(`${locale}: ${touch ? 'touch' : 'desktop'}`, async () => {
        const context = await browser.newContext({
          locale,
          viewport: { width: touch ? 390 : 1440, height: 900 },
          hasTouch: touch,
          isMobile: touch,
        });
        const page = await context.newPage();
        const errors = [];

        page.on('pageerror', (error) => errors.push(error.message));

        try {
          await page.goto(origin + '#/agents?from=bookmark');
          await page.getByRole('button', { name: /^(Настройки|Settings)$/ }).waitFor();
          await page.evaluate(async () => {
            const router = document.querySelector('#app').__vue_app__.config.globalProperties.$router;

            await router.isReady();
          });
          assert.equal(await page.locator('html').getAttribute('lang'), locale.slice(0, 2));
          assert.equal(new URL(page.url()).hash, '#/routes?from=bookmark');
          await page.locator('.routes-page').waitFor();
          await page.reload();
          await page.locator('.routes-page').waitFor();
          assert.equal(new URL(page.url()).hash, '#/routes?from=bookmark');
          assert.equal(await page.locator('[href="#/agents"]').count(), 0);
          assert.equal(await page.getByRole('link', { name: /^(Агенты|Agents)$/ }).count(), 0);
          assert.equal(await page.locator('[href="#/routes"]').count(), 1);

          await page.getByRole('link', { name: /^(Доска|Board)( ·.*)?$/ }).click();
          await page.waitForURL(origin + '#/board');

          if (touch) {
            await page.locator('.phone-nav').getByRole('button', { name: /^(Разделы|Sections)$/ }).click();
          }

          await page.getByRole('link', { name: /^(Маршруты|Routes)$/ }).click();
          await page.locator('.routes-page').waitFor();
          assert.equal(new URL(page.url()).hash, '#/routes');
          assert.deepEqual(errors, []);
        } finally {
          await context.close();
        }
      });
    }
  }
});
