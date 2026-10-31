import assert from 'node:assert/strict';
import test from 'node:test';

import { migrationHarness, webFile } from './helpers/compile-vue.js';
import {
  actionButton, mountTrackerBoard, openTrackerSettings, trackerCatalog,
} from './helpers/trackerBoard.js';

process.env.NODE_ENV = 'test';

/**
 * Настройки и общий UiDialogHost используют одну настоящую очередь подтверждений.
 * HTTP остаётся управляемым, а пользовательские cancel/accept нажимаются в реальном диалоге.
 */
async function removalCard(t, handlers = {}) {
  const catalog = trackerCatalog();

  catalog.externalId = 'grigdesk-b24-discript';
  catalog.activeIds.push('grigdesk-b24-discript');

  const card = await mountTrackerBoard(t, {
    configured: true,
    catalog,
    handlers,
    compilerStubs: {
      '../../ui.ts': `
        export * from ${JSON.stringify(webFile('src/ui.ts'))};
        import { UiDialogHost } from ${JSON.stringify(webFile('src/ui.ts'))};
        globalThis.__driverRemovalHost = UiDialogHost;
      `,
    },
  });
  const utils = webFile('node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs');
  const { mount } = await import(utils);
  const host = mount(globalThis.__driverRemovalHost, {
    attachTo: card.browser.document.body,
    global: { stubs: { teleport: true } },
  });

  t.after(() => {
    host.unmount();
    delete globalThis.__driverRemovalHost;
  });
  await openTrackerSettings(card);

  const install = actionButton(card.wrapper, /^\s*(?:установить|install)\s*$/iu);

  assert.ok(install, JSON.stringify(card.wrapper.findAll('button').map((button) => button.text())));
  await install.trigger('click');
  await card.flushPromises();

  const dialog = card.wrapper.findAll('[role="dialog"]').at(-1);
  const packageCard = dialog.findAll('.driver-package')
    .find((entry) => entry.text().includes('Кастомный Б24'));

  assert.ok(packageCard);

  return {
    ...card,
    dialog,
    host,
    packageCard,
  };
}

test('DRIVER-REMOVE-UI-01: кнопка открывает общий confirm, отмена не удаляет пакет', async (t) => {
  const card = await removalCard(t);

  assert.equal(card.wrapper.find('.tracker-setup-banner').exists(), false);
  await actionButton(card.packageCard, /^\s*Удалить\s*$/u).trigger('click');
  await card.flushPromises();
  assert.match(card.host.text(), /Удалить драйвер/u);
  assert.match(card.host.text(), /Кастомный Б24/u);
  assert.match(card.host.text(), /реквизиты сохранятся/u);
  assert.equal(card.apiCalls.some((call) => call.url.endsWith('/remove')), false);
  await actionButton(card.host, /отмена|отменить/iu).trigger('click');
  await card.flushPromises();
  assert.equal(card.apiCalls.some((call) => call.url.endsWith('/remove')), false);
  assert.equal(card.state.catalog.externalId, 'grigdesk-b24-discript');
});

test('DRIVER-REMOVE-UI-02: подтверждение показывает deleted, SSE возвращает own и баннер', async (t) => {
  const card = await removalCard(t);

  await actionButton(card.packageCard, /^\s*Удалить\s*$/u).trigger('click');
  await card.flushPromises();
  await actionButton(card.host, /^\s*Удалить\s*$/u).trigger('click');
  await card.flushPromises();

  const requests = card.apiCalls.filter((call) => call.url.endsWith('/remove'));

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/driver-installs/drivers/grigdesk-b24-discript/remove');
  assert.deepEqual(requests[0].payload, {});
  assert.match(card.dialog.text(), /Удалён, перезапустите сервер/u);
  assert.equal(card.state.catalog.externalId, null);
  assert.deepEqual(card.state.catalog.activeIds, ['own']);
  assert.equal(card.wrapper.find('.tracker-setup-banner').exists(), true);

  const deletedCard = card.dialog.findAll('.driver-package')
    .find((entry) => entry.text().includes('Кастомный Б24'));

  assert.ok(deletedCard);
  assert.equal(!!actionButton(deletedCard, /^\s*Удалить\s*$/u), false);

  card.state.catalog.drivers = card.state.catalog.drivers.filter((driver) => !driver.deleted);

  for (const listener of card.listeners) {
    listener('trackers-changed', { revision: card.state.catalog.revision });
  }

  await card.flushPromises();
  assert.equal(card.dialog.text().includes('Удалён, перезапустите сервер'), false);
  assert.equal(card.dialog.text().includes('Кастомный Б24'), false);
});

test('DRIVER-REMOVE-UI-03: отказ 409 сохраняет пакет, выбор и возможность повторить', async (t) => {
  const card = await removalCard(t, {
    post: async (url) => {
      if (url.endsWith('/remove')) {
        throw new migrationHarness.ApiError('Драйвер занят установкой', 409, { error: 'install_busy' });
      }
    },
  });

  await actionButton(card.packageCard, /^\s*Удалить\s*$/u).trigger('click');
  await card.flushPromises();
  await actionButton(card.host, /^\s*Удалить\s*$/u).trigger('click');
  await card.flushPromises();
  assert.match(card.dialog.text(), /Драйвер занят установкой/u);
  assert.equal(card.state.catalog.externalId, 'grigdesk-b24-discript');
  assert.equal(card.dialog.text().includes('Удалён, перезапустите сервер'), false);
  assert.equal(actionButton(card.packageCard, /^\s*Удалить\s*$/u).element.disabled, false);
});

test('DRIVER-REMOVE-UI-04: SSE показывает удаление managed-пакета при отказе повторного check', async (t) => {
  const card = await removalCard(t, {
    post: async (url, _payload, state) => {
      if (url.endsWith('/check') && state.catalog.drivers.some((driver) => driver.deleted)) {
        throw new Error('Не удалось перечитать установленные пакеты');
      }
    },
  });

  await card.dialog.find('[data-role="driver-custom-source"]').trigger('click');
  await card.dialog.find('input[name="url"]').setValue('https://git.fixture/driver.git');
  await card.dialog.find('input[name="tag"]').setValue('v1.0.0');
  await actionButton(card.dialog, /^\s*Проверить пакет\s*$/u).trigger('click');
  await card.flushPromises();
  await actionButton(card.dialog, /^\s*Применить\s*$/u).trigger('click');
  await card.flushPromises();

  const installed = card.dialog.findAll('.driver-package')
    .find((entry) => entry.text().includes('grigdesk-b24-discript'));

  assert.ok(installed);
  await actionButton(installed, /^\s*Удалить\s*$/u).trigger('click');
  await card.flushPromises();
  await actionButton(card.host, /^\s*Удалить\s*$/u).trigger('click');
  await card.flushPromises();
  assert.match(card.dialog.text(), /Не удалось перечитать установленные пакеты/u);
  assert.match(card.dialog.text(), /Удалён, перезапустите сервер/u);
  assert.equal(card.state.catalog.externalId, null);
  assert.equal(card.wrapper.find('.tracker-setup-banner').exists(), true);

  const deleted = card.dialog.findAll('.driver-package')
    .find((entry) => entry.text().includes('Кастомный Б24'));

  assert.ok(deleted);
  assert.equal(deleted.findAll('button').length, 0);
});
