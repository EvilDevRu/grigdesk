import assert from 'node:assert/strict';
import test from 'node:test';

import { migrationHarness } from './helpers/compile-vue.js';
import {
  actionButton, chooseExternal, driverInstallInfo, driverJob, liveTrackerDialog, mountTrackerBoard,
  openTrackerManager, prepareTracker,
} from './helpers/trackerBoard.js';

process.env.NODE_ENV = 'test';

/**
 * Открывает список и возвращает текущую единственную модальную оболочку.
 * Запросы остаются наблюдаемыми, реальные stores обслуживают весь маршрут.
 */
async function manager(t, options) {
  const card = await mountTrackerBoard(t, options);

  await openTrackerManager(card);

  return { ...card, dialog: liveTrackerDialog(card) };
}

/**
 * Возврат завершает показ результата и позволяет явно проверить обновления.
 * Доступная версия берётся из check, а не из предположений интерфейса.
 */
async function showUpdate(card) {
  await actionButton(card.dialog, /^К трекерам$/u).trigger('click');
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
    const card = await manager(t, {
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

test('WIZARD-02: открытие списка и подтверждения отката не обращается к Git и не меняет версию',
  async (t) => {
  const card = await manager(t, {
    handlers: {
      get: async (_url, state) => {
        state.installed ??= driverInstallInfo('1.1.0', 2, driverInstallInfo('1.0.0', 1));
      },
    },
  });

  assert.equal(card.apiCalls.some((call) =>
    call.url.endsWith('/check') || call.url.endsWith('/versions')), false);

  const entry = card.dialog.findAll('.driver-package').find((node) => node.text().includes('Кастомный Б24'));

  await actionButton(entry, /^Другие действия$/u).trigger('click');
  await actionButton(entry, /^Откатить$/u).trigger('click');
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
  const card = await manager(t, {
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
  const entry = card.dialog.findAll('.driver-package').find((node) => node.text().includes('Кастомный Б24'));

  await actionButton(entry, /^Другие действия$/u).trigger('click');
  await actionButton(entry, /^Откатить$/u).trigger('click');
  await card.flushPromises();
  await actionButton(card.dialog, /^Откатить$/u).trigger('click');
  await card.flushPromises();
  assert.match(card.dialog.text(), /Версия изменилась/u);
  assert.equal(Boolean(actionButton(card.dialog, /^Откатить$/u)), false);
  assert.ok(actionButton(card.dialog, /^Повторить проверку$/u));
  assert.equal(card.apiCalls.filter((call) => call.url.endsWith('/rollback')).length, 1);
});

test('WIZARD-04: потерянный ответ apply проверяется по job, успешная операция не повторяется', async (t) => {
  const card = await manager(t, {
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
  const card = await manager(t, {
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
  const card = await manager(t);

  await chooseExternal(card, 'grigdesk-b24');
  await card.wrapper.find('input[type="password"]').setValue('in-memory-draft');
  await actionButton(card.wrapper, /^Добавить трекер$/u).trigger('click');
  await card.flushPromises();
  assert.equal(card.wrapper.findAll('[role="dialog"]').length, 1);
  assert.equal(card.wrapper.find('input[type="password"]').exists(), false);
  await actionButton(card.dialog, /^К трекерам$/u).trigger('click');
  await actionButton(card.dialog, /^Подключение доски$/u).trigger('click');
  await card.flushPromises();
  assert.equal(card.wrapper.findAll('[role="dialog"]').length, 1);
  assert.equal(card.wrapper.find('input[type="password"]').element.value, 'in-memory-draft');
  assert.equal(card.state.catalog.externalId, null);
});

test('WIZARD-07: замена ручных правок требует отдельного выбора и подтверждения пакета', async (t) => {
  const card = await manager(t, {
    handlers: {
      get: async (_url, state) => {
        state.installed ??= driverInstallInfo('1.0.0', 1, null, { localChanges: true });
      },
    },
  });
  const entry = card.dialog.findAll('.driver-package').find((node) => node.text().includes('Кастомный Б24'));

  await actionButton(entry, /^Другие действия$/u).trigger('click');
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
  const card = await manager(t, {
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
  const entry = card.dialog.findAll('.driver-package').find((node) => node.text().includes('Кастомный Б24'));

  await actionButton(entry, /^Другие действия$/u).trigger('click');
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

test('WIZARD-09: сохранённый успешный update не подменяет список драйверов старым результатом', async (t) => {
  const card = await manager(t, {
    handlers: {
      get: async (_url, state) => {
        state.installed ??= driverInstallInfo('1.1.0', 2, driverInstallInfo('1.0.0', 1), {
          checkedAt: '2026-01-01T00:00:00.000Z',
        });
        state.job ??= driverJob('update', state.installed, 'done', state.installed.previous);
      },
    },
  });

  assert.equal(card.dialog.find('.driver-install__title').text(), 'Трекеры');
  assert.equal(card.dialog.find('.driver-job').exists(), false);
  assert.match(card.dialog.text(), /Установлена последняя версия/u);
  assert.equal(Boolean(actionButton(card.dialog, /^Обновить$/u)), false);
  assert.equal(card.state.job.status, 'done');
  assert.equal(card.apiCalls.some((call) => call.method === 'POST'), false);
  await actionButton(card.dialog, /^Добавить трекер$/u).trigger('click');
  await card.flushPromises();
  assert.equal(card.dialog.find('.driver-sources').exists(), true);
});

test('WIZARD-10: повторный вход восстанавливает неизвестный исход и показывает подтверждённый результат',
  async (t) => {
    const card = await manager(t, {
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
    await openTrackerManager(card);
    assert.equal(card.dialog.find('.driver-install__title').text(), 'Трекер установлен');
    assert.match(card.dialog.text(), /Установлена версия 1\.0\.0/u);
    assert.equal(card.dialog.find('.driver-steps').exists(), false);
    assert.equal(card.apiCalls.filter((call) => call.url.endsWith('/apply')).length, 1);
  });
