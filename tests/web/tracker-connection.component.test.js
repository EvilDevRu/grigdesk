import assert from 'node:assert/strict';
import test from 'node:test';

import { migrationHarness } from './helpers/compile-vue.js';
import {
  actionButton, mountTrackerBoard, openTrackerSettings, trackerCatalog,
} from './helpers/trackerBoard.js';

process.env.NODE_ENV = 'test';

/**
 * Jira редактируется при действующем подключении другого трекера.
 * Схема содержит скрытое поле, чтобы проверка не отправляла реквизиты чужого режима.
 */
function jiraCatalog() {
  const catalog = trackerCatalog();

  catalog.externalId = 'grigdesk-b24';
  catalog.activeIds.push('grigdesk-b24');
  catalog.drivers.push({
    id: 'fixture-jira',
    name: 'Jira Cloud',
    status: 'available',
    capabilities: {},
    schema: {
      email: { type: 'string', label: 'Email' },
      token: {
        type: 'string',
        label: 'Токен доступа',
        secret: true,
      },
      hidden: { type: 'string', visibleIf: { field: 'email', equals: 'hidden' } },
    },
  });

  return catalog;
}

test('Проверка Jira отправляет черновик без сохранения и блокирует повтор до результата', async (t) => {
  const held = Promise.withResolvers();
  const card = await mountTrackerBoard(t, {
    catalog: jiraCatalog(),
    handlers: {
      post: (url) => url === '/api/trackers/test-connection' ? held.promise : undefined,
    },
  });

  t.after(() => held.resolve({ ok: true }));
  await openTrackerSettings(card);
  await card.wrapper.get('[data-driver="fixture-jira"]').trigger('click');
  await card.wrapper.get('input[type="text"]').setValue('draft@fixture.invalid');
  await card.wrapper.get('input[type="password"]').setValue('draft-token');
  await card.wrapper.get('[data-role="tracker-test-connection"]').trigger('click');
  await card.flushPromises();

  const button = card.wrapper.get('[data-role="tracker-test-connection"]');

  assert.equal(button.element.disabled, true);
  assert.equal(actionButton(card.wrapper, /^Сохранить$/u).element.disabled, true);
  assert.equal(card.wrapper.get('input[type="password"]').element.disabled, true);
  assert.equal(card.wrapper.get('[data-driver="grigdesk-b24"]').element.disabled, true);
  assert.equal(card.wrapper.get('button[aria-label="Закрыть"]').element.disabled, true);
  await button.trigger('click');
  assert.deepEqual(card.apiCalls.filter((call) => call.method === 'POST'), [{
    method: 'POST',
    url: '/api/trackers/test-connection',
    payload: {
      driverId: 'fixture-jira',
      settings: { email: 'draft@fixture.invalid', token: 'draft-token' },
      expectedRevision: 1,
    },
  }]);
  assert.equal(card.state.catalog.externalId, 'grigdesk-b24');
  held.resolve({ ok: true });
  await card.flushPromises();
  assert.match(card.wrapper.get('[data-role="tracker-connection-result"]').text(),
    /Соединение с Jira Cloud установлено/u);
  assert.equal(card.wrapper.get('[data-role="tracker-test-connection"]').element.disabled, false);
  await card.wrapper.get('input[type="text"]').setValue('changed@fixture.invalid');
  assert.equal(card.wrapper.find('[data-role="tracker-connection-result"]').exists(), false);
});

test('Отказ подключения показывает причину и снимается при смене драйвера', async (t) => {
  const card = await mountTrackerBoard(t, {
    catalog: jiraCatalog(),
    handlers: {
      post: async (url) => {
        if (url === '/api/trackers/test-connection') {
          return { ok: false, error: 'Jira: HTTP 401' };
        }
      },
    },
  });

  await openTrackerSettings(card);
  await card.wrapper.get('[data-driver="fixture-jira"]').trigger('click');
  await card.wrapper.get('[data-role="tracker-test-connection"]').trigger('click');
  await card.flushPromises();

  const result = card.wrapper.get('[data-role="tracker-connection-result"]').text();

  assert.match(result, /Не удалось подключиться к Jira Cloud/u);
  assert.match(result, /Jira: HTTP 401/u);
  assert.doesNotMatch(result, /Б24|Битрикс/u);
  assert.equal(card.wrapper.get('input[type="password"]').element.value, '');
  await card.wrapper.get('[data-driver="grigdesk-b24"]').trigger('click');
  assert.equal(card.wrapper.find('[data-role="tracker-connection-result"]').exists(), false);
});

test('Ошибка API проверки сохраняет черновик и разрешает повтор', async (t) => {
  const card = await mountTrackerBoard(t, {
    catalog: jiraCatalog(),
    handlers: {
      post: async (url) => {
        if (url === '/api/trackers/test-connection') {
          throw new migrationHarness.ApiError('Подключение уже изменилось', 409, {});
        }
      },
    },
  });

  await openTrackerSettings(card);
  await card.wrapper.get('[data-driver="fixture-jira"]').trigger('click');
  await card.wrapper.get('input[type="password"]').setValue('keep-draft');
  await card.wrapper.get('[data-role="tracker-test-connection"]').trigger('click');
  await card.flushPromises();
  assert.match(card.wrapper.get('[data-role="tracker-connection-result"]').text(), /уже изменилось/u);
  assert.equal(card.wrapper.get('input[type="password"]').element.value, 'keep-draft');
  assert.equal(card.wrapper.get('[data-role="tracker-test-connection"]').element.disabled, false);
});

test('Ошибка доски называет выбранную Jira и показывает исходную причину в подробностях', async (t) => {
  const catalog = jiraCatalog();

  catalog.externalId = 'fixture-jira';
  catalog.activeIds = ['own', 'fixture-jira'];

  const card = await mountTrackerBoard(t, { catalog, configured: true });

  globalThis.__boardViewStores.board().error = 'Jira: HTTP 401';
  await card.flushPromises();
  assert.match(card.wrapper.get('.board-tracker-error').text(), /Не удалось обновить задачи Jira Cloud/u);
  assert.doesNotMatch(card.wrapper.get('.board-tracker-error').text(), /Б24|Битрикс/u);
  await card.wrapper.get('.board-tracker-error .ui-disclosure-button').trigger('click');
  await card.flushPromises();
  assert.equal(card.wrapper.get('.board-tracker-error-details').text(), 'Jira: HTTP 401');
});
