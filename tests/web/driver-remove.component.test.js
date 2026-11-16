import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiError } from '../../web/src/shared/apiClient.ts';
import { webFile } from './helpers/compile-vue.js';
import {
  actionButton, liveTrackerDialog, mountTrackerBoard, openTrackerSettings,
  prepareTracker, trackerCatalog,
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
  await card.wrapper.get('[data-driver="grigdesk-b24-discript"]').trigger('click');
  await card.flushPromises();

  return {
    ...card,
    dialog: liveTrackerDialog(card),
    host,
  };
}

test('DRIVER-REMOVE-UI-01: кнопка открывает общий confirm, отмена не удаляет пакет', async (t) => {
  const card = await removalCard(t);

  assert.equal(card.wrapper.find('.tracker-setup-banner').exists(), false);
  await actionButton(card.dialog, /^\s*Удалить\s*$/u).trigger('click');
  await card.flushPromises();
  assert.match(card.host.text(), /Удалить драйвер/u);
  assert.match(card.host.text(), /Кастомный Б24/u);
  assert.match(card.host.text(), /Реквизиты и данные подключения сохранятся/u);
  assert.equal(card.apiCalls.some((call) => call.url.endsWith('/remove')), false);
  await actionButton(card.host, /отмена|отменить/iu).trigger('click');
  await card.flushPromises();
  assert.equal(card.apiCalls.some((call) => call.url.endsWith('/remove')), false);
  assert.equal(card.state.catalog.externalId, 'grigdesk-b24-discript');
});

test('DRIVER-REMOVE-UI-02: подтверждение убирает драйвер, SSE возвращает own и баннер', async (t) => {
  const card = await removalCard(t);

  await actionButton(card.dialog, /^\s*Удалить\s*$/u).trigger('click');
  await card.flushPromises();
  await actionButton(card.host, /^\s*Удалить\s*$/u).trigger('click');
  await card.flushPromises();

  const requests = card.apiCalls.filter((call) => call.url.endsWith('/remove'));

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/driver-installs/drivers/grigdesk-b24-discript/remove');
  assert.deepEqual(requests[0].payload, {});
  assert.equal(card.state.catalog.externalId, null);
  assert.deepEqual(card.state.catalog.activeIds, ['own']);
  assert.equal(card.wrapper.find('.tracker-setup-banner').exists(), true);

  assert.equal(card.dialog.find('[data-driver="grigdesk-b24-discript"]').exists(), false);

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
        throw new ApiError('Драйвер занят установкой', 409, { error: 'install_busy' });
      }
    },
  });

  await actionButton(card.dialog, /^\s*Удалить\s*$/u).trigger('click');
  await card.flushPromises();
  await actionButton(card.host, /^\s*Удалить\s*$/u).trigger('click');
  await card.flushPromises();
  assert.match(card.dialog.text(), /Драйвер занят установкой/u);
  assert.equal(card.state.catalog.externalId, 'grigdesk-b24-discript');
  assert.equal(card.dialog.text().includes('Удалён, перезапустите сервер'), false);

  assert.equal(card.dialog.find('[data-driver="grigdesk-b24-discript"]').exists(), true);
  assert.equal(actionButton(card.dialog, /^Удалить$/u).element.disabled, false);
});

test('DRIVER-REMOVE-UI-04: SSE показывает удаление managed-пакета при отказе повторного check', async (t) => {
  const card = await removalCard(t, {
    get: async (url, state) => {
      if (url.endsWith('/installed') && state.catalog.drivers.some((driver) => driver.deleted)) {
        throw new Error('Не удалось перечитать установленные пакеты');
      }
    },
  });

  await prepareTracker(card);
  await actionButton(card.dialog, /^Установить$/u).trigger('click');
  await card.flushPromises();
  await actionButton(card.dialog, /^К настройкам$/u).trigger('click');
  await card.flushPromises();

  await actionButton(card.dialog, /^\s*Удалить\s*$/u).trigger('click');
  await card.flushPromises();
  await actionButton(card.host, /^\s*Удалить\s*$/u).trigger('click');
  await card.flushPromises();
  assert.match(card.dialog.text(), /Не удалось перечитать установленные пакеты/u);
  assert.equal(card.state.catalog.externalId, null);
  assert.equal(card.wrapper.find('.tracker-setup-banner').exists(), true);

  assert.equal(card.dialog.find('[data-driver="grigdesk-b24-discript"]').exists(), false);
});

test('DRIVER-REMOVE-UI-05: отмена в настройках сохраняет редактор и черновики', async (t) => {
  const card = await removalCard(t, {});

  await card.wrapper.get('[data-driver="grigdesk-b24"]').trigger('click');
  await card.wrapper.get('input[type="password"]').setValue('kept-draft');
  await card.wrapper.get('[data-driver="grigdesk-b24-discript"]').trigger('click');
  await actionButton(card.dialog, /^Удалить$/u).trigger('click');
  await card.flushPromises();
  assert.match(card.host.text(), /Удалить драйвер «Кастомный Б24»/u);
  assert.equal(card.wrapper.find('[data-role="tracker-install"]').exists(), false);
  assert.equal(card.apiCalls.some((call) => call.method === 'POST'), false);
  assert.equal(actionButton(card.dialog, /^Удалить$/u).element.disabled, true);
  assert.equal(actionButton(card.dialog, /^Сохранить$/u).element.disabled, true);
  await actionButton(card.host, /отмена|отменить/iu).trigger('click');
  await card.flushPromises();
  assert.equal(actionButton(card.dialog, /^Удалить$/u).element.disabled, false);
  assert.equal(card.apiCalls.some((call) => call.method === 'POST'), false);
  await card.wrapper.get('[data-driver="grigdesk-b24"]').trigger('click');
  assert.equal(card.wrapper.get('input[type="password"]').element.value, 'kept-draft');
});

test('DRIVER-REMOVE-UI-06: удаление дефолта обновляет включения и ревизию, сохраняя черновики',
  async (t) => {
    const card = await removalCard(t, {
      get: async (url, state) => {
        if (url === '/api/trackers/settings') {
          state.catalog.enabledIds ??= ['grigdesk-b24', 'grigdesk-b24-discript'];
          state.catalog.default = state.catalog.externalId;
          state.settings.drivers = [...state.catalog.enabledIds];
          state.settings.default = state.catalog.default;
          state.settings.externalId = state.catalog.default;
        }
      },
      post: async (url, _payload, state) => {
        if (url.endsWith('/remove')) {
          const driver = state.catalog.drivers.find((entry) => entry.id === 'grigdesk-b24-discript');

          driver.deleted = true;
          driver.status = 'restartRequired';
          state.catalog.enabledIds = ['grigdesk-b24'];
          state.catalog.default = 'grigdesk-b24';
          state.catalog.externalId = 'grigdesk-b24';
          state.catalog.activeIds = ['own', 'grigdesk-b24'];
          state.catalog.revision += 1;

          return { id: driver.id, restartRequired: true };
        }
      },
    });

    await card.wrapper.get('[data-driver="grigdesk-b24"]').trigger('click');
    await card.wrapper.get('input[type="password"]').setValue('kept-draft');
    await card.wrapper.get('[data-driver="grigdesk-b24-discript"]').trigger('click');
    await actionButton(card.dialog, /^Удалить$/u).trigger('click');
    await card.flushPromises();
    await actionButton(card.host, /^Удалить$/u).trigger('click');
    await card.flushPromises();
    assert.equal(card.apiCalls.filter((call) => call.url.endsWith('/remove')).length, 1);
    assert.equal(card.wrapper.find('[data-driver="grigdesk-b24-discript"]').exists(), false);
    assert.match(card.wrapper.get('.tracker-settings__driver-heading').text(), /Облачный Б24/u);
    assert.equal(card.wrapper.get('input[type="password"]').element.value, 'kept-draft');
    assert.equal(card.wrapper.get('[data-role="tracker-board-enabled"]').element.checked, true);
    assert.equal(card.apiCalls.some((call) => call.url === '/api/trackers/settings'
      && call.method === 'POST'), false);
    await actionButton(card.dialog, /^Сохранить$/u).trigger('click');
    await card.flushPromises();

    const write = card.apiCalls.find((call) => call.url === '/api/trackers/settings'
      && call.method === 'POST');

    assert.deepEqual(write.payload.drivers, ['grigdesk-b24']);
    assert.equal(write.payload.default, 'grigdesk-b24');
    assert.equal(write.payload.expectedRevision, 2);
    assert.equal(write.payload.settings['grigdesk-b24'].accessToken, 'kept-draft');
    assert.equal('grigdesk-b24-discript' in write.payload.settings, false);
  });

test('DRIVER-REMOVE-UI-07: отказ удаления остаётся в настройках и разрешает повторить', async (t) => {
  const held = Promise.withResolvers();
  const card = await removalCard(t, {
    post: async (url) => {
      if (url.endsWith('/remove')) {
        await held.promise;

        throw new ApiError('Драйвер занят установкой', 409, { error: 'install_busy' });
      }
    },
  });

  t.after(() => held.resolve());
  await actionButton(card.dialog, /^Удалить$/u).trigger('click');
  await card.flushPromises();
  await actionButton(card.host, /^Удалить$/u).trigger('click');
  await card.flushPromises();
  assert.equal(actionButton(card.dialog, /^Удалить$/u).element.disabled, true);
  assert.equal(actionButton(card.dialog, /^Сохранить$/u).element.disabled, true);
  assert.equal(card.apiCalls.filter((call) => call.url.endsWith('/remove')).length, 1);
  held.resolve();
  await card.flushPromises();
  assert.match(card.dialog.text(), /Драйвер занят установкой/u);
  assert.equal(card.wrapper.find('[data-role="tracker-install"]').exists(), false);
  assert.equal(card.wrapper.find('[data-driver="grigdesk-b24-discript"]').exists(), true);
  assert.equal(actionButton(card.dialog, /^Удалить$/u).element.disabled, false);
});

test('DRIVER-REMOVE-UI-08: неизвестный исход проверяется в настройках без повторного удаления', async (t) => {
  const card = await removalCard(t, {
    post: async (url, _payload, state) => {
      if (url.endsWith('/remove')) {
        const driver = state.catalog.drivers.find((entry) => entry.id === 'grigdesk-b24-discript');

        driver.deleted = true;
        driver.status = 'restartRequired';
        state.catalog.externalId = null;
        state.catalog.activeIds = ['own'];
        state.catalog.revision += 1;

        throw new Error('Ответ потерян');
      }
    },
  });

  await actionButton(card.dialog, /^Удалить$/u).trigger('click');
  await card.flushPromises();
  await actionButton(card.host, /^Удалить$/u).trigger('click');
  await card.flushPromises();
  assert.equal(card.apiCalls.filter((call) => call.url.endsWith('/remove')).length, 1);
  assert.equal(card.wrapper.find('[data-role="tracker-install"]').exists(), false);
  assert.equal(actionButton(card.dialog, /^Сохранить$/u).element.disabled, true);
  await actionButton(card.dialog, /^Повторить проверку$/u).trigger('click');
  await card.flushPromises();
  assert.equal(card.dialog.find('[data-driver="grigdesk-b24-discript"]').exists(), false);
  assert.equal(actionButton(card.dialog, /^Сохранить$/u).element.disabled, false);
  assert.equal(card.apiCalls.filter((call) => call.url.endsWith('/remove')).length, 1);
});

test('DRIVER-REMOVE-UI-09: отказ чтения после удаления оставляет повтор в настройках', async (t) => {
  let unavailable = true;
  const card = await removalCard(t, {
    get: async (url, state) => {
      if (url === '/api/trackers' && unavailable
        && state.catalog.drivers.some((driver) => driver.deleted)) {
        throw new Error('Каталог временно недоступен');
      }
    },
  });

  await actionButton(card.dialog, /^Удалить$/u).trigger('click');
  await card.flushPromises();
  await actionButton(card.host, /^Удалить$/u).trigger('click');
  await card.flushPromises();
  assert.equal(card.wrapper.find('[data-role="tracker-settings"]').exists(), true);
  assert.match(liveTrackerDialog(card).text(), /Каталог временно недоступен/u);
  unavailable = false;
  await actionButton(liveTrackerDialog(card), /^Повторить проверку$/u).trigger('click');
  await card.flushPromises();
  assert.doesNotMatch(liveTrackerDialog(card).text(), /Каталог временно недоступен/u);
  assert.equal(card.dialog.find('[data-driver="grigdesk-b24-discript"]').exists(), false);
  assert.equal(card.apiCalls.filter((call) => call.url.endsWith('/remove')).length, 1);
});
