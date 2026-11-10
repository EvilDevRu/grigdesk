import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { migrationHarness, webFile } from './helpers/compile-vue.js';
import {
  actionButton, chooseExternal, driverInstallInfo, driverJob, liveTrackerDialog, mountTrackerBoard,
  openTrackerDriverSettings, openTrackerInstaller, prepareTracker,
} from './helpers/trackerBoard.js';

process.env.NODE_ENV = 'test';

test('WIZARD-PHONE: подготовка компактна, показывает этап и сохраняет отмену', async (t) => {
  const card = await driverSettings(t, {
    handlers: {
      get: async (_url, state) => {
        if (!state.job) {
          state.job = driverJob('update', driverInstallInfo('1.1.0', 2), 'running');
          state.job.preview = null;
          state.job.stage = 'fetching';
          state.job.percent = 38;
        }
      },
    },
  });

  await openTrackerInstaller(card);

  const { compileStyle } = await import('../../web/node_modules/@vue/compiler-sfc/dist/compiler-sfc.cjs.js');
  const source = await readFile(webFile('src/views/board/TrackerInstallDialog.vue'), 'utf8');
  const style = card.browser.document.createElement('style');

  card.browser.happyDOM.setWindowSize({ width: 390, height: 844 });
  style.textContent = compileStyle({
    source: source.match(/<style scoped>([\s\S]*?)<\/style>/u)[1],
    id: 'data-v-tracker-phone',
    scoped: true,
  }).code.replaceAll('[data-v-tracker-phone]', '');
  card.browser.document.head.append(style);
  t.after(() => style.remove());

  const layout = card.browser.getComputedStyle(card.dialog.get('.driver-install').element);

  assert.equal(layout.alignContent, 'start');
  assert.notEqual(layout.minHeight, '300px');
  assert.equal(card.dialog.get('[role="progressbar"]').attributes('aria-valuenow'), '38');
  assert.match(card.dialog.get('.driver-job').text(), /38%/u);
  assert.doesNotMatch(card.dialog.text(), /Проверьте пакет и подтвердите изменение/u);
  assert.ok(actionButton(card.dialog, /^Отменить проверку$/u));
});

test('WIZARD-OFFICIAL: встроенный репозиторий скрывает общее предупреждение',
  async (t) => {
    const card = await driverSettings(t, {
      handlers: {
        post: async (url, payload, state) => {
          if (url === '/api/driver-installs/jobs') {
            const record = driverInstallInfo('1.0.0', 1);

            record.source = { kind: 'git', url: payload.url };
            state.job = driverJob('install', record);

            return { job: structuredClone(state.job) };
          }
        },
      },
    });

    await prepareTracker(card, 'git@github.com:EvilDevRu/grigdesk-b24.git');
    assert.doesNotMatch(card.dialog.text(), /правами GrigDesk/u);
    assert.ok(actionButton(card.dialog, /^Установить$/u));
    assert.equal(card.apiCalls.some((call) => call.url.endsWith('/apply')), false);
  });

/**
 * Открывает параметры драйвера и возвращает текущую единственную модальную оболочку.
 * Запросы остаются наблюдаемыми, реальные stores обслуживают весь маршрут.
 */
async function driverSettings(t, options) {
  const card = await mountTrackerBoard(t, options);

  await openTrackerDriverSettings(card);

  return { ...card, dialog: liveTrackerDialog(card) };
}

/**
 * Возврат завершает показ результата и позволяет явно проверить обновления.
 * Доступная версия берётся из check, а не из предположений интерфейса.
 */
async function showUpdate(card) {
  await actionButton(card.dialog, /^К настройкам$/u).trigger('click');
  card.state.installed.updateAvailable = true;
  card.state.installed.latest = {
    version: '1.1.0',
    tag: 'v1.1.0',
    sha: 'c'.repeat(40),
  };
  await actionButton(card.dialog, /^Проверить обновления$/u).trigger('click');
  await card.flushPromises();
}

test('WIZARD-01: подготовка, скрытые подробности, одно предупреждение, явное применение и обновление',
  async (t) => {
    const held = Promise.withResolvers();
    const card = await driverSettings(t, {
      handlers: {
        post: async (url) => {
          if (url.endsWith('/apply')) {
            await held.promise;
          }
        },
      },
    });

    t.after(() => held.resolve());
    await prepareTracker(card);
    assert.equal(card.dialog.findAll('.driver-package').length, 0);
    assert.equal(card.dialog.text().includes('b'.repeat(64)), false);
    assert.equal(card.dialog.findAll('.ui-inline-message')
      .filter((node) => /правами GrigDesk/u.test(node.text())).length, 1);
    assert.equal(card.apiCalls.some((call) => call.url.endsWith('/apply')), false);
    await actionButton(card.dialog, /^Технические сведения$/u).trigger('click');
    assert.match(card.dialog.text(), new RegExp('b'.repeat(64), 'u'));

    const apply = actionButton(card.dialog, /^Установить$/u);

    await apply.trigger('click');
    await apply.trigger('click');
    assert.equal(card.apiCalls.filter((call) => call.url.endsWith('/apply')).length, 1);
    held.resolve();
    await card.flushPromises();
    assert.equal(card.state.installed.version, '1.0.0');
    assert.match(card.dialog.text(), /перезапуск/iu);
    assert.equal(card.state.catalog.externalId, null);
    await showUpdate(card);
    await actionButton(card.dialog, /^Обновить$/u).trigger('click');
    await card.flushPromises();
    assert.match(card.dialog.text(), /1\.0\.0\s*→\s*1\.1\.0/u);
    assert.equal(card.state.installed.version, '1.0.0');
    await actionButton(card.dialog, /^Обновить$/u).trigger('click');
    await card.flushPromises();
    assert.equal(card.state.installed.version, '1.1.0');
    assert.equal(card.dialog.find('.driver-install__title').text(), 'Трекер обновлён');
    assert.match(card.dialog.text(), /Установлена версия 1\.1\.0/u);
    assert.match(card.dialog.text(), /Подключение и параметры трекера сохранены/u);
    assert.equal(card.dialog.find('.driver-steps').exists(), false);
    assert.doesNotMatch(card.dialog.text(), /Проверьте пакет и подтвердите изменение/u);
    assert.equal(card.apiCalls.some((call) => call.url.includes('plugin-installs')), false);
  });

test('WIZARD-02: открытие настроек и подтверждения отката не обращается к Git и не меняет версию',
  async (t) => {
  const card = await driverSettings(t, {
    handlers: {
      get: async (_url, state) => {
        state.installed ??= driverInstallInfo('1.1.0', 2, driverInstallInfo('1.0.0', 1));
      },
    },
  });

  assert.equal(card.apiCalls.some((call) =>
    call.url.endsWith('/check') || call.url.endsWith('/versions')), false);

  await actionButton(card.dialog, /^Откатить$/u).trigger('click');
  await card.flushPromises();
  assert.match(card.dialog.text(), /1\.1\.0 → 1\.0\.0/u);
  assert.equal(card.state.installed.version, '1.1.0');
  assert.equal(card.apiCalls.some((call) => call.url.endsWith('/rollback')), false);
  await actionButton(card.dialog, /^Откатить$/u).trigger('click');
  await card.flushPromises();

  const request = card.apiCalls.find((call) => call.url.endsWith('/rollback'));

  assert.equal(request.payload.expectedRevision, 2);
  assert.equal(request.payload.expectedPreviousDigest, 'b'.repeat(64));
  assert.equal(card.state.installed.version, '1.0.0');
});

test('WIZARD-03: сменившаяся previous отклоняет подтверждённый снимок, новый откат не отправляется',
  async (t) => {
  const card = await driverSettings(t, {
    handlers: {
      get: async (_url, state) => {
        state.installed ??= driverInstallInfo('1.1.0', 2, driverInstallInfo('1.0.0', 1));
      },
      post: async (url) => {
        if (url.endsWith('/rollback')) {
          throw new migrationHarness.ApiError('Версия изменилась после подтверждения', 409, {
            error: 'preview_stale',
          });
        }
      },
    },
  });

  await actionButton(card.dialog, /^Откатить$/u).trigger('click');
  await card.flushPromises();
  await actionButton(card.dialog, /^Откатить$/u).trigger('click');
  await card.flushPromises();
  assert.match(card.dialog.text(), /Версия изменилась/u);
  assert.equal(Boolean(actionButton(card.dialog, /^Откатить$/u)), false);
  assert.ok(actionButton(card.dialog, /^Повторить проверку$/u));
  assert.equal(card.apiCalls.filter((call) => call.url.endsWith('/rollback')).length, 1);
});

test('WIZARD-04: потерянный ответ apply проверяется по job, успешная операция не повторяется', async (t) => {
  const card = await driverSettings(t, {
    handlers: {
      post: async (url, _payload, state) => {
        if (url.endsWith('/apply')) {
          state.installed = driverInstallInfo('1.0.0', 1);
          state.job.status = 'done';
          state.job.finishedAt = '2026-01-01T00:00:01.000Z';
          state.job.updatedAt = state.job.finishedAt;
          state.job.revision += 1;

          throw new Error('Ответ потерян');
        }
      },
    },
  });

  await prepareTracker(card);
  await actionButton(card.dialog, /^Установить$/u).trigger('click');
  await card.flushPromises();
  assert.equal(Boolean(actionButton(card.dialog, /^Установить$/u)), false);
  await actionButton(card.dialog, /^Проверить результат операции$/u).trigger('click');
  await card.flushPromises();
  assert.match(card.dialog.text(), /Установлено/u);
  assert.equal(card.apiCalls.filter((call) => call.url.endsWith('/apply')).length, 1);
  assert.ok(card.apiCalls.some((call) => /\/jobs\/(?!current)/u.test(call.url) && call.method === 'GET'));
});

test('WIZARD-05: успех установки сохраняется при отказе последующего чтения каталога', async (t) => {
  const card = await driverSettings(t, {
    handlers: {
      get: async (url, state) => {
        if (url.endsWith('/installed') && state.installed) {
          throw new Error('Каталог недоступен');
        }
      },
    },
  });

  await prepareTracker(card);
  await actionButton(card.dialog, /^Установить$/u).trigger('click');
  await card.flushPromises();
  assert.match(card.dialog.text(), /Установлено/u);
  assert.match(card.dialog.text(), /Операция выполнена, но не удалось обновить сведения/u);
  assert.equal(card.state.installed.version, '1.0.0');
});

test('WIZARD-06: секретный черновик сохраняется между формой и мастером без вложенного модала', async (t) => {
  const card = await driverSettings(t);

  await chooseExternal(card, 'grigdesk-b24');
  await card.wrapper.find('input[type="password"]').setValue('in-memory-draft');
  await actionButton(card.wrapper, /^Добавить трекер$/u).trigger('click');
  await card.flushPromises();
  assert.equal(card.wrapper.findAll('[role="dialog"]').length, 1);
  assert.equal(card.wrapper.find('input[type="password"]').exists(), false);
  await actionButton(card.dialog, /^К настройкам$/u).trigger('click');
  await card.flushPromises();
  assert.equal(card.wrapper.findAll('[role="dialog"]').length, 1);
  assert.equal(card.wrapper.find('input[type="password"]').element.value, 'in-memory-draft');
  assert.equal(card.state.catalog.externalId, null);
});

test('WIZARD-07: замена ручных правок требует отдельного выбора и подтверждения пакета', async (t) => {
  const card = await driverSettings(t, {
    handlers: {
      get: async (_url, state) => {
        state.installed ??= driverInstallInfo('1.0.0', 1, null, { localChanges: true });
      },
    },
  });

  await actionButton(card.dialog, /^Восстановить из репозитория$/u).trigger('click');
  await card.flushPromises();
  assert.match(card.dialog.text(), /Ручные правки сохранятся в резервной копии/u);
  assert.equal(card.apiCalls.some((call) => call.url.endsWith('/update')), false);
  await actionButton(card.dialog, /^Проверить пакет$/u).trigger('click');
  await card.flushPromises();

  const request = card.apiCalls.find((call) => call.url.endsWith('/update'));

  assert.deepEqual(request.payload, { version: '1.0.0', replaceModified: true });
  assert.equal(card.apiCalls.some((call) => call.url.endsWith('/apply')), false);
});

test('WIZARD-08: потерянный ответ отката повторяет то же намерение и не меняет версии второй раз',
  async (t) => {
  let posted = false;
  const card = await driverSettings(t, {
    handlers: {
      get: async (_url, state) => {
        state.installed ??= driverInstallInfo('1.1.0', 2, driverInstallInfo('1.0.0', 1));
      },
      post: async (url, _payload, state) => {
        if (!url.endsWith('/rollback')) {
          return;
        }

        if (!posted) {
          posted = true;

          const previous = state.installed;

          state.installed = driverInstallInfo('1.0.0', 3);
          state.job = driverJob('rollback', state.installed, 'done', previous);

          throw new Error('Ответ отката потерян');
        }

        return { job: structuredClone(state.job) };
      },
    },
  });

  await actionButton(card.dialog, /^Откатить$/u).trigger('click');
  await card.flushPromises();
  await actionButton(card.dialog, /^Откатить$/u).trigger('click');
  await card.flushPromises();
  await actionButton(card.dialog, /^Проверить результат операции$/u).trigger('click');
  await card.flushPromises();

  const requests = card.apiCalls.filter((call) => call.url.endsWith('/rollback'));

  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].payload, requests[1].payload);
  assert.equal(card.state.installed.version, '1.0.0');
  assert.match(card.dialog.text(), /Сохранённая версия восстановлена/u);
});

test('WIZARD-09: завершённые попытки не подменяют новое добавление старым результатом', async (t) => {
  for (const status of ['done', 'failed', 'cancelled', 'interrupted']) {
    await t.test(status, async (subtest) => {
      const card = await driverSettings(subtest, {
        handlers: {
          get: async (_url, state) => {
            state.installed ??= driverInstallInfo('1.1.0', 2);
            state.job ??= driverJob('update', state.installed, status);
          },
        },
      });

      assert.equal(card.wrapper.find('[data-role="tracker-install"]').exists(), false);
      assert.equal(Boolean(actionButton(card.dialog, /^Другие действия$/u)), false);
      assert.equal(card.apiCalls.some((call) => call.url.endsWith('/jobs/current')), false);
      await actionButton(card.dialog, /^Добавить трекер$/u).trigger('click');
      await card.flushPromises();
      assert.equal(card.dialog.find('.driver-sources').exists(), true);
      assert.equal(card.dialog.find('.driver-job').exists(), false);
      assert.equal(card.state.job.status, status);
      assert.equal(card.apiCalls.some((call) => call.method === 'POST'), false);
    });
  }
});

test('WIZARD-10: повторный вход восстанавливает неизвестный исход и показывает подтверждённый результат',
  async (t) => {
    const card = await driverSettings(t, {
      handlers: {
        post: async (url, _payload, state) => {
          if (url.endsWith('/apply')) {
            state.installed = driverInstallInfo('1.0.0', 1);
            state.job.status = 'done';
            state.job.finishedAt = '2026-01-01T00:00:01.000Z';
            state.job.updatedAt = state.job.finishedAt;
            state.job.revision += 1;

            throw new Error('Ответ потерян');
          }
        },
      },
    });

    await prepareTracker(card);
    await actionButton(card.dialog, /^Установить$/u).trigger('click');
    await card.flushPromises();
    await card.dialog.find('button[aria-label="Закрыть"]').trigger('click');
    await card.flushPromises();
    await openTrackerDriverSettings(card);
    await actionButton(card.dialog, /^Проверить результат операции$/u).trigger('click');
    await card.flushPromises();
    assert.equal(card.dialog.find('.driver-install__title').text(), 'Трекер установлен');
    assert.match(card.dialog.text(), /Установлена версия 1\.0\.0/u);
    assert.equal(card.dialog.find('.driver-steps').exists(), false);
    assert.equal(card.apiCalls.filter((call) => call.url.endsWith('/apply')).length, 1);
  });

test('WIZARD-11: завершение возвращает в настройки драйвера без второго списка', async (t) => {
  const card = await driverSettings(t);

  await prepareTracker(card);
  await actionButton(card.dialog, /^Установить$/u).trigger('click');
  await card.flushPromises();
  await actionButton(card.dialog, /^Готово$/u).trigger('click');
  await card.flushPromises();
  assert.equal(card.wrapper.find('[data-role="tracker-install"]').exists(), false);
  assert.equal(card.wrapper.find('[data-role="tracker-settings"]').exists(), true);
  assert.match(card.wrapper.get('.tracker-settings__driver-heading').text(), /Кастомный Б24/u);
  assert.equal(Boolean(actionButton(card.dialog, /^Другие действия$/u)), false);
  assert.equal(card.apiCalls.filter((call) => call.url.endsWith('/apply')).length, 1);
  assert.equal(card.apiCalls.some((call) => call.url === '/api/trackers/settings'
    && call.method === 'POST'), false);
});

test('WIZARD-12: ошибка начального чтения оставляет повтор запрошенного добавления', async (t) => {
  let unavailable = true;
  const card = await driverSettings(t, {
    handlers: {
      get: async (url) => {
        if (unavailable && url.endsWith('/jobs/current')) {
          throw new Error('Состояние установки недоступно');
        }
      },
    },
  });

  await openTrackerInstaller(card);
  assert.match(card.dialog.text(), /Состояние установки недоступно/u);
  assert.equal(card.dialog.find('.driver-sources').exists(), false);
  unavailable = false;
  await actionButton(card.dialog, /^Повторить проверку$/u).trigger('click');
  await card.flushPromises();
  assert.equal(card.dialog.find('.driver-sources').exists(), true);
  assert.doesNotMatch(card.dialog.text(), /Состояние установки недоступно/u);
  assert.equal(card.apiCalls.some((call) => call.method === 'POST'), false);
});

test('WIZARD-13: обновление после старого отказа сохраняет цель и возвращается в её настройки', async (t) => {
  const card = await driverSettings(t, {
    handlers: {
      get: async (_url, state) => {
        state.installed ??= driverInstallInfo('1.0.0', 1, null, {
          updateAvailable: true,
          latest: {
            version: '1.1.0',
            tag: 'v1.1.0',
            sha: 'c'.repeat(40),
          },
        });
        state.job ??= driverJob('install', state.installed, 'failed');
      },
    },
  });

  await actionButton(card.dialog, /^Обновить$/u).trigger('click');
  await card.flushPromises();
  assert.match(card.dialog.text(), /1\.0\.0\s*→\s*1\.1\.0/u);
  assert.equal(card.apiCalls.filter((call) => call.url.endsWith('/update')).length, 1);
  assert.equal(card.apiCalls.some((call) => call.url.endsWith('/apply')), false);
  await actionButton(card.dialog, /^Назад$/u).trigger('click');
  await card.flushPromises();
  assert.equal(card.dialog.find('select').exists(), true);
  await actionButton(card.dialog, /^Назад$/u).trigger('click');
  await card.flushPromises();
  assert.equal(card.wrapper.find('[data-role="tracker-settings"]').exists(), true);
  assert.match(card.wrapper.get('.tracker-settings__driver-heading').text(), /Кастомный Б24/u);
});
