import assert from 'node:assert/strict';
import test from 'node:test';

import { i18nBrowser } from './helpers/i18nBrowser.js';
import { card, job, snapshot } from './helpers/providerInstallFixture.js';

/**
 * Два browser context разделяют серверный снимок, но не Pinia или localStorage.
 * Весь API установки и единственный EventSource синтетические, команды не исполняются.
 */
async function browserFixture(t, installed = false, viewport = {
  width: 1280,
  height: 800
}, locale = 'ru') {
  const cards = ['claude', 'codex', 'kimi'].map((id) => ({
    ...structuredClone(card),
    id,
    name: id.toUpperCase(),
    installed,
    version: installed ? '1.0.0' : '',
    latest: installed ? '2.0.0' : null,
    updateAvailable: installed,
    chatEnabled: true,
    settings: [{
      id: 'sample',
      kind: 'toggle',
      label: 'Черновое поле',
      value: false
    }],
    installation: {
      ...card.installation,
      installCommand: `${id} серверная установка`,
      updateCommand: `${id} серверное обновление`,
      loginCommand: `${id} login`,
    },
  }));
  const { browser, origin } = await i18nBrowser(t, {
    responses: { '/api/providers': {
      providers: cards,
      models: []
    } },
  });
  const contexts = [];
  const pages = [];
  const posts = [];
  const reads = [];
  let remote = snapshot();

  /**
   * Прогресс передаётся подписчикам общей шины, а не напрямую в store.
   * Так сценарий ловит пропущенное имя события и повторный EventSource компонента.
   */
  async function publish(value, event = 'provider-install') {
    remote = value;

    for (const page of pages) {
      await page.evaluate(({ event, value }) => {
        for (const source of window.__providerSources) {
          const payload = event === 'hello' ? { boot: 'fixture-reconnect' } : value;

          source.dispatchEvent(new MessageEvent(event, { data: JSON.stringify(payload) }));
        }
      }, {
        event,
        value
      });
    }
  }

  /**
   * Каждый документ получает независимый транспорт и общий ответ current.
   * На reload начальное hello заставляет продукт перечитать серверное состояние.
   */
  async function newPage() {
    const context = await browser.newContext({
      viewport,
      locale: locale === 'en' ? 'en-US' : 'ru-RU'
    });

    contexts.push(context);
    await context.addInitScript(({ locale }) => {
      localStorage.setItem('grigdesk-ui-language', locale);
      window.__providerSources = [];
      window.EventSource = class extends EventTarget {
        static OPEN = 1;
        readyState = 1;

        constructor(url) {
          super();
          this.url = url;
          window.__providerSources.push(this);
          setTimeout(() => {
            this.onopen?.(new Event('open'));
            this.dispatchEvent(new MessageEvent('hello', { data: '{"boot":"fixture"}' }));
          }, 0);
        }

        close() {
          this.readyState = 2;
        }
      };
    }, { locale });
    await context.route('**/api/providers/**', async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;

      if (pathname === '/api/providers/installations/current') {
        reads.push(pathname);
        await route.fulfill({ json: remote });

        return;
      }
      if (/\/(?:install|update)\/start$/u.test(pathname)) {
        posts.push({
          pathname,
          body: request.postDataJSON()
        });

        if (remote.active) {
          await route.fulfill({
            status: 409,
            json: remote
          });

          return;
        }

        const [, id, operation] = pathname.match(/providers\/([^/]+)\/(install|update)\/start/u);
        const provider = cards.find((item) => item.id === id);

        remote = snapshot(job({
          providerId: id,
          operation,
          command: provider.installation[`${operation}Command`],
          loginCommand: `${id} login`,
        }), remote.revision + 1);
        await route.fulfill({
          status: 202,
          json: remote
        });

        return;
      }

      if (/\/providers\/[^/]+\/update$/u.test(pathname)) {
        posts.push({
          pathname,
          body: request.postDataJSON()
        });
        await route.fulfill({ json: {
          ok: true,
          before: '1.0.0',
          after: '2.0.0',
          changed: true
        } });

        return;
      }

      await route.continue();
    });

    const page = await context.newPage();

    pages.push(page);
    page.setDefaultTimeout(2000);
    page.setDefaultNavigationTimeout(30000);
    await page.goto(origin + '#/chats', {
      timeout: 30000,
      waitUntil: 'domcontentloaded'
    });
    await page.getByRole('button', { name: /^(Настройки|Settings)$/u }).waitFor({ timeout: 15000 });

    return page;
  }

  t.after(async () => {
    for (const context of contexts) {
      await context.close();
    }
  });

  return {
    newPage,
    publish,
    posts,
    reads,
    cards,
    getRemote: () => remote
  };
}

/**
 * Выбор страницы использует обычный settings store, действия установки нажимаются в DOM.
 * Настройки остаются открытыми, чтобы обнаружить потерю черновика при показе нового окна.
 */
async function openEntry(page, id, entry) {
  if (entry === 'settings') {
    await page.getByRole('button', { name: /^(Настройки|Settings)$/u }).click();
    await page.evaluate((id) => {
      document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('settings')
        .selectPage('agents.providers', id, 'overview');
    }, id);

    return page.locator('[data-role="settings-modal"]');
  }

  await page.locator(`.prov-${id} [data-context="provider-status"]`).click();

  const title = page.locator('.ptip-name', { hasText: id.toUpperCase() });

  return page.locator('.ui-popover').filter({ has: title });
}

/**
 * До согласия нет POST; имя и команда подтверждения взяты из того же registry DTO.
 * После согласия серверный ACK должен открыть ровно одно глобальное окно.
 */
async function confirmStart(page, area, provider, operation, posts) {
  await area.getByRole('button', {
    name: operation === 'install' ? /Установить|Install/iu : /Обновить|Update/iu,
  }).first().click();

  const confirmation = page.getByRole('dialog').last();

  await confirmation.waitFor();
  assert.equal(posts.length, 0, 'Команда запущена раньше подтверждения');
  assert.ok((await confirmation.textContent()).includes(provider.name));
  assert.ok((await confirmation.textContent()).includes(provider.installation[`${operation}Command`]));

  const accept = /Установить|Обновить|Продолжить|Install|Update|Confirm/iu;

  await confirmation.getByRole('button').filter({ hasText: accept })
    .last().click();
  await page.locator('[data-role="provider-install-dialog"]').waitFor();
  assert.equal(await page.locator('[data-role="provider-install-dialog"]').count(), 1);
}

test('три исполнителя открывают одно окно из обоих мест', { timeout: 120000 }, async (t) => {
  for (const installed of [false, true]) {
    for (const entry of ['topbar', 'settings']) {
      for (const id of ['claude', 'codex', 'kimi']) {
        await t.test(`${id}/${entry}/${installed ? 'update' : 'install'}`, async (scenario) => {
          const fixture = await browserFixture(scenario, installed);
          const page = await fixture.newPage();
          const provider = fixture.cards.find((item) => item.id === id);
          const area = await openEntry(page, id, entry);

          await confirmStart(page, area, provider, installed ? 'update' : 'install', fixture.posts);
          assert.equal(fixture.posts.length, 1);
          assert.ok(fixture.posts[0].body == null || Object.keys(fixture.posts[0].body).length === 0);
          assert.equal(await page.evaluate(() => window.__providerSources.length), 1);
        });
      }
    }
  }
});

test('close/reload и второе окно показывают тот же job и блокируют чужие кнопки', {
  timeout: 60000,
}, async (t) => {
  const fixture = await browserFixture(t, true);
  const first = await fixture.newPage();
  const area = await openEntry(first, 'claude', 'settings');

  await first.evaluate(() => {
    const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
    const settings = pinia._s.get('settings');

    settings.selectPage('agents.providers', 'claude', 'parameters');
  });
  await first.getByRole('switch', {
    name: 'Черновое поле',
    exact: true
  }).check({ force: true });
  await first.evaluate(() => {
    document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('settings')
      .selectPage('agents.providers', 'claude', 'overview');
  });
  await confirmStart(first, area, fixture.cards[0], 'update', fixture.posts);

  const id = fixture.getRemote().active.id;

  await fixture.publish(fixture.getRemote());

  const dialog = first.locator('[data-role="provider-install-dialog"]');

  await dialog.getByRole('button', { name: 'Закрыть' }).click();
  assert.equal(await first.evaluate(() => document.querySelector('#app').__vue_app__
    .config.globalProperties.$pinia._s.get('settings').snapshot.dirtyCount), 1);

  const second = await fixture.newPage();
  const other = await openEntry(second, 'codex', 'topbar');

  assert.equal(await other.getByRole('button', { name: /Обновить/u }).isDisabled(), true);
  await second.reload();

  const own = await openEntry(second, 'claude', 'topbar');

  await own.getByRole('button', { name: /[Уу]станов|[Хх]од|[Пп]оказать|[Оо]бновл/u }).first().click();
  await second.locator('[data-role="provider-install-dialog"]').waitFor();
  assert.equal(await second.evaluate(() => document.querySelector('#app').__vue_app__
    .config.globalProperties.$pinia._s.get('provider-install').snapshot.active.id), id);
  assert.equal(fixture.posts.length, 1);

  const readsBefore = fixture.reads.length;

  await fixture.publish(fixture.getRemote(), 'hello');
  await second.waitForTimeout(100);
  assert.ok(fixture.reads.length > readsBefore, 'Hello/reconnect не перечитал снимок');
  assert.equal(fixture.posts.length, 1, 'Reconnect повторил POST');
  await second.locator('[data-role="provider-install-dialog"]')
    .getByRole('button', { name: 'Закрыть' }).click();

  const settingsArea = await openEntry(second, 'codex', 'settings');

  assert.equal(await settingsArea.getByRole('button', { name: /Обновить/u }).isDisabled(), true);
  await second.evaluate(() => {
    document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('settings')
      .selectPage('agents.providers', 'claude', 'overview');
  });
  await fixture.publish(snapshot(null, 8, {
    claude: job({
      status: 'succeeded',
      outcome: 'updated',
      after: '2.0.0',
      finishedAt: 1_700_000_001_000
    }),
  }));
  await settingsArea.getByRole('button', { name: /Показать результат/u }).click();
  await second.locator('[data-role="provider-install-dialog"]').waitFor();
  assert.equal(fixture.posts.length, 1, 'Просмотр результата повторно запустил установку');
});

test('телефон и окно сохраняют доступность действий', { timeout: 120000 }, async (t) => {
  for (const width of [390, 1280]) {
    for (const locale of ['ru', 'en']) {
      await t.test(`${width}/${locale}`, async (scenario) => {
        const fixture = await browserFixture(scenario, false, {
          width,
          height: 780
        }, locale);
        const page = await fixture.newPage();
        const area = await openEntry(page, 'claude', 'settings');

        await confirmStart(page, area, fixture.cards[0], 'install', fixture.posts);

        for (const status of ['succeeded', 'failed']) {
          const final = job({
            status,
            operation: 'install',
            outcome: status === 'succeeded' ? 'installed' : null,
            after: '2.0.0',
            outputTail: 'длинная строка '.repeat(900),
            error: status === 'failed' ? {
              code: 'EACCES',
              message: 'Нет прав'
            } : null,
            finishedAt: 1_700_000_001_000,
          });

          await fixture.publish(snapshot(null, status === 'succeeded' ? 5 : 6, { claude: final }));

          const dialog = page.locator('[data-role="provider-install-dialog"]');
          const action = dialog.getByRole('button', {
            name: status === 'succeeded' ? /^(Войти|Log in|Sign in)$/iu
              : /^(Открыть в терминале|Open in terminal)$/iu,
          });

          await action.waitFor();

          const controls = [action, dialog.getByRole('button', { name: /^(Закрыть|Close)$/iu })];

          if (status === 'failed') {
            controls.push(dialog.getByRole('button', { name: /^(Повторить|Retry)$/u }));
          }

          for (const control of controls) {
            const bounds = await control.boundingBox();

            assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0);
            assert.ok(bounds.x + bounds.width <= width);
            assert.ok(bounds.y + bounds.height <= 780);
          }

          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        }
      });
    }
  }
});

test('Повторить в окне ошибки Kimi заново запускает обновление', { timeout: 60000 }, async (t) => {
  const fixture = await browserFixture(t, true);
  const page = await fixture.newPage();
  const area = await openEntry(page, 'kimi', 'topbar');
  const provider = fixture.cards.find((item) => item.id === 'kimi');

  await confirmStart(page, area, provider, 'update', fixture.posts);
  await fixture.publish(snapshot(null, 5, {
    kimi: job({
      providerId: 'kimi',
      status: 'failed',
      command: provider.installation.updateCommand,
      error: { code: 'command_exit_failed', message: 'curl: (35) unexpected eof while reading' },
      finishedAt: 1_700_000_001_000,
    }),
  }));

  const dialog = page.locator('[data-role="provider-install-dialog"]');

  await dialog.getByRole('button', { name: 'Повторить', exact: true }).click();

  const confirmation = page.getByRole('dialog').last();

  await confirmation.getByRole('button', { name: 'Обновить', exact: true }).waitFor();
  assert.equal(fixture.posts.length, 1, 'Повтор запущен до подтверждения команды');
  assert.ok((await confirmation.textContent()).includes(provider.installation.updateCommand));
  await confirmation.getByRole('button', { name: 'Обновить', exact: true }).click();
  await dialog.getByRole('progressbar').waitFor();
  assert.deepEqual(fixture.posts.map((entry) => entry.pathname), [
    '/api/providers/kimi/update/start',
    '/api/providers/kimi/update/start',
  ]);
  assert.equal(await dialog.getByRole('button', { name: 'Повторить', exact: true }).count(), 0);
});
