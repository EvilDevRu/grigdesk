import assert from 'node:assert/strict';
import test from 'node:test';

import {
  actionButton, driverSourceCatalog, mountTrackerBoard, openTrackerInstaller, openTrackerSettings,
} from './helpers/trackerBoard.js';

process.env.NODE_ENV = 'test';

/**
 * Мастер открывается из настоящей доски; подменяется только HTTP.
 * Каждый шаг проверяется через доступные действия, без доступа к внутреннему состоянию Vue.
 */
async function installDialog(t, options) {
  const card = await mountTrackerBoard(t, options);

  await openTrackerSettings(card);

  const dialog = await openTrackerInstaller(card);

  return { ...card, dialog };
}

/**
 * Переход к версиям читает список, но не готовит и не применяет пакет.
 * Проверки используют тот же модал после обновления содержимого.
 */
async function nextVersion(card) {
  const button = actionButton(card.dialog, /^Далее$/u);

  assert.equal(button.element.disabled, false, JSON.stringify(card.apiCalls));
  await button.trigger('click');
  await card.flushPromises();
}

test('DRIVER-SOURCES-UI-01: источник, версия и подтверждение разделены, Git запускается по Далее',
  async (t) => {
  const card = await installDialog(t);
  const section = card.dialog.find('section[aria-label="Источник"]');

  assert.equal(card.wrapper.findAll('[role="dialog"]').length, 1);
  assert.equal(card.dialog.find('input[name="tag"]').exists(), false);
  assert.equal(card.dialog.find('input[name="url"]').exists(), false);

  for (const source of driverSourceCatalog().sources) {
    const button = actionButton(section, new RegExp(source.title, 'u'));

    await button.trigger('click');
    assert.equal(button.attributes('aria-pressed'), 'true');
    assert.match(button.text(), /github\.com/u);
  }

  assert.equal(card.apiCalls.some((call) => call.url.endsWith('/versions')), false);
  assert.equal(card.apiCalls.some((call) => call.url === '/api/driver-installs/jobs'), false);
  await nextVersion(card);
  assert.equal(card.dialog.find('.driver-sources').exists(), false);
  assert.equal(card.dialog.find('select').element.value, 'v1.0.0');
  assert.equal(card.apiCalls.some((call) => call.url === '/api/driver-installs/jobs'), false);
  await actionButton(card.dialog, /^Проверить пакет$/u).trigger('click');
  await card.flushPromises();
  assert.deepEqual(card.apiCalls.find((call) => call.url === '/api/driver-installs/jobs').payload, {
    url: driverSourceCatalog().sources[1].url,
    version: '1.0.0',
  });
  assert.equal(card.dialog.find('select').exists(), false);
  assert.equal(card.dialog.findAll('.driver-package').length, 0);
  assert.equal(card.apiCalls.some((call) => call.url.endsWith('/apply')), false);
});

test('DRIVER-SOURCES-UI-02: отказ листинга допускает повтор, другой источник и ручную стабильную версию',
  async (t) => {
    const card = await installDialog(t, {
      handlers: {
        post: async (url) => {
          if (url.endsWith('/versions')) {
            throw new Error('Репозиторий не найден или нет доступа');
          }
        },
      },
    });

    await nextVersion(card);
    assert.match(card.dialog.text(), /Репозиторий не найден или нет доступа/u);
    await actionButton(card.dialog, /^Указать версию вручную$/u).trigger('click');
    await card.dialog.find('input[name="tag"]').setValue('main');
    assert.equal(actionButton(card.dialog, /^Проверить пакет$/u).element.disabled, true);
    await card.dialog.find('input[name="tag"]').setValue('v1.0.0');
    await actionButton(card.dialog, /^Проверить пакет$/u).trigger('click');
    await card.flushPromises();
    assert.equal(card.apiCalls.filter((call) => call.url === '/api/driver-installs/jobs').length, 1);
  });

test('DRIVER-SOURCES-UI-03: пустой каталог и ошибка чтения оставляют собственный адрес', async (t) => {
  for (const fail of [false, true]) {
    await t.test(String(fail), async (subtest) => {
      const card = await installDialog(subtest, {
        handlers: {
          get: async (url) => {
            if (url === '/api/trackers/sources') {
              if (fail) {
                throw new Error('Каталог временно недоступен');
              }

              return { sources: [] };
            }
          },
        },
      });

      assert.match(card.dialog.text(), fail ? /Каталог временно недоступен/u : /Пока нет опубликованных/u);
      assert.equal(card.dialog.find('input[name="url"]').element.disabled, false);
    });
  }
});

test('DRIVER-SOURCES-UI-04: пустые версии блокируют продолжение и разрешают сменить источник', async (t) => {
  const card = await installDialog(t, {
    handlers: {
      post: async (url, payload) => url.endsWith('/versions') ? {
        source: { kind: 'git', url: payload.url },
        versions: [],
      } : undefined,
    },
  });

  await nextVersion(card);
  assert.match(card.dialog.text(), /В репозитории пока нет версий/u);
  assert.equal(actionButton(card.dialog, /^Проверить пакет$/u).element.disabled, true);
  await actionButton(card.dialog, /^Назад$/u).trigger('click');
  assert.equal(card.dialog.findAll('.driver-source').length, 2);
});

test('DRIVER-SOURCES-UI-05: подтверждённый отказ подготовки сохраняет версию и выбранный адрес',
  async (t) => {
  const card = await installDialog(t, {
    handlers: {
      post: async (url) => {
        if (url === '/api/driver-installs/jobs') {
          const { migrationHarness } = await import('./helpers/compile-vue.js');

          throw new migrationHarness.ApiError('В репозитории нет выбранной версии', 404, {
            error: 'version_not_found',
          });
        }
      },
    },
  });

  await actionButton(card.dialog, /Jira/u).trigger('click');
  await nextVersion(card);
  await actionButton(card.dialog, /^Проверить пакет$/u).trigger('click');
  await card.flushPromises();
  assert.match(card.dialog.text(), /В репозитории нет выбранной версии/u);
  assert.equal(card.dialog.find('select').element.value, 'v1.0.0');
  await actionButton(card.dialog, /^Назад$/u).trigger('click');
  assert.equal(actionButton(card.dialog, /Jira/u).attributes('aria-pressed'), 'true');
});

test('DRIVER-SOURCES-UI-06: свой адрес восстанавливается, чужие версии сбрасываются', async (t) => {
  const card = await installDialog(t);

  await card.dialog.find('[data-role="driver-custom-source"]').trigger('click');
  await card.dialog.find('input[name="url"]').setValue('ssh://git@example.org/custom.git');
  await nextVersion(card);
  await actionButton(card.dialog, /^Назад$/u).trigger('click');
  await actionButton(card.dialog, /Битрикс24/u).trigger('click');
  await card.dialog.find('[data-role="driver-custom-source"]').trigger('click');
  assert.equal(card.dialog.find('input[name="url"]').element.value, 'ssh://git@example.org/custom.git');
  assert.equal(card.dialog.find('select').exists(), false);
});

test('DRIVER-SOURCES-UI-07: повторное открытие восстанавливает подтверждение без новой подготовки',
  async (t) => {
  const card = await installDialog(t);

  await nextVersion(card);
  await actionButton(card.dialog, /^Проверить пакет$/u).trigger('click');
  await card.flushPromises();
  await card.dialog.find('button[aria-label="Закрыть"]').trigger('click');
  await card.flushPromises();
  await openTrackerSettings(card);
  await openTrackerInstaller(card);

  const reopened = card.wrapper.find('[data-role="tracker-install"]');

  assert.equal(reopened.find('.driver-sources').exists(), false);
  assert.equal(reopened.find('select').exists(), false);
  assert.ok(actionButton(reopened, /^Установить$/u));
  assert.equal(card.apiCalls.filter((call) => call.url === '/api/driver-installs/jobs').length, 1);
  assert.equal(card.apiCalls.some((call) => call.url.endsWith('/cancel')), false);
});

test('DRIVER-SOURCES-UI-08: назад отменяет prepared кандидат до нового выбора', async (t) => {
  const card = await installDialog(t);

  await nextVersion(card);
  await actionButton(card.dialog, /^Проверить пакет$/u).trigger('click');
  await card.flushPromises();
  await actionButton(card.dialog, /^Назад$/u).trigger('click');
  await card.flushPromises();
  assert.equal(card.state.job.status, 'cancelled');
  assert.equal(card.apiCalls.filter((call) => call.url.endsWith('/cancel')).length, 1);
  assert.equal(card.dialog.find('select').exists(), true);
});
