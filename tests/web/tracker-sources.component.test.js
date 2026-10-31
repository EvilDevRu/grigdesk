import assert from 'node:assert/strict';
import test from 'node:test';

import {
  actionButton, driverSourceCatalog, mountTrackerBoard, openTrackerSettings,
} from './helpers/trackerBoard.js';

process.env.NODE_ENV = 'test';

/**
 * Диалог открывается обычным действием с доски, stores и controls остаются настоящими.
 * Подменён только HTTP; карточки источников не получают привилегий тестового preset.
 */
async function installDialog(t, options) {
  const card = await mountTrackerBoard(t, options);

  await openTrackerSettings(card);
  await actionButton(card.wrapper, /^\s*(?:установить|install)\s*$/iu).trigger('click');
  await card.flushPromises();

  const dialog = card.wrapper.findAll('[role="dialog"]').at(-1);

  assert.ok(dialog);

  return { ...card, dialog };
}

test('DRIVER-SOURCES-UI-01: официальный источник скрывает URL, выбор не запускает Git', async (t) => {
  const card = await installDialog(t);
  const section = card.dialog.find('section[aria-label="Источник"]');
  const tag = card.dialog.find('input[name="tag"]');

  assert.ok(section.exists());
  assert.equal(section.findAll('button').length, 3);
  assert.equal(card.dialog.find('input[name="url"]').exists(), false);
  assert.equal(card.apiCalls.filter((call) => call.url === '/api/trackers/sources').length, 1);
  await tag.setValue('v2.3.4');

  for (const source of driverSourceCatalog().sources) {
    const button = actionButton(section, new RegExp(source.title, 'u'));

    assert.ok(button);
    assert.match(button.text(), /github\.com/u);
    await button.trigger('click');
    assert.equal(card.dialog.find('input[name="url"]').exists(), false);
    assert.equal(button.attributes('aria-pressed'), 'true');
    assert.equal(tag.element.value, 'v2.3.4');
  }

  assert.equal(card.apiCalls.some((call) => call.url === '/api/driver-installs/versions'), false);
  assert.equal(card.apiCalls.some((call) => call.url === '/api/driver-installs/jobs'), false);
  await actionButton(card.dialog, /^\s*проверить пакет\s*$/iu).trigger('click');
  await card.flushPromises();

  const prepare = card.apiCalls.find((call) => call.url === '/api/driver-installs/jobs');

  assert.deepEqual(prepare.payload, {
    url: driverSourceCatalog().sources[1].url,
    version: '2.3.4',
  });
  assert.equal(card.dialog.find('input[name="url"]').exists(), false);
});

test('DRIVER-SOURCES-UI-02: отказ листинга виден, карточки и ручной ввод продолжают работать', async (t) => {
  const card = await installDialog(t, {
    handlers: {
      post: async (url) => {
        if (url === '/api/driver-installs/versions') {
          throw new Error('Репозиторий не найден или нет доступа');
        }
      },
    },
  });

  await actionButton(card.dialog, /Битрикс24/u).trigger('click');
  await actionButton(card.dialog, /^\s*версии\s*$/iu).trigger('click');
  await card.flushPromises();
  assert.match(card.dialog.text(), /Репозиторий не найден или нет доступа/u);
  assert.equal(card.dialog.findAll('.driver-source').length, 2);
  assert.equal(card.dialog.find('input[name="url"]').exists(), false);
  await card.dialog.find('[data-role="driver-custom-source"]').trigger('click');

  const repo = card.dialog.find('input[name="url"]');

  assert.equal(repo.element.disabled, false);
  await repo.setValue('https://git.fixture/manual.git');
  await card.dialog.find('input[name="tag"]').setValue('v1.0.0');
  await actionButton(card.dialog, /^\s*проверить пакет\s*$/iu).trigger('click');
  await card.flushPromises();
  assert.equal(card.dialog.text().includes('Репозиторий не найден или нет доступа'), false);
  assert.deepEqual(card.apiCalls.find((call) => call.url === '/api/driver-installs/jobs').payload, {
    url: 'https://git.fixture/manual.git',
    version: '1.0.0',
  });
});

test('DRIVER-SOURCES-UI-03: пустой каталог показывает пустое состояние, ручной ввод доступен', async (t) => {
  const card = await installDialog(t, {
    handlers: {
      get: async (url) => url === '/api/trackers/sources' ? { sources: [] } : undefined,
    },
  });

  assert.match(card.dialog.text(), /Пока нет опубликованных драйверов/u);
  assert.equal(card.dialog.findAll('.driver-source').length, 0);
  assert.equal(card.dialog.find('input[name="url"]').element.disabled, false);
});

test('DRIVER-SOURCES-UI-04: пустой список версий показывает читаемый отказ', async (t) => {
  const card = await installDialog(t, {
    handlers: {
      post: async (url, payload) => url === '/api/driver-installs/versions' ? {
        source: { kind: 'git', url: payload.url },
        versions: [],
      } : undefined,
    },
  });

  await actionButton(card.dialog, /Jira/u).trigger('click');
  await actionButton(card.dialog, /^\s*версии\s*$/iu).trigger('click');
  await card.flushPromises();
  assert.match(card.dialog.text(), /В репозитории пока нет версий для установки/u);
  assert.equal(card.dialog.findAll('.driver-source').length, 2);
  assert.equal(card.dialog.find('input[name="url"]').exists(), false);
  assert.equal(card.dialog.find('[data-role="driver-custom-source"]').element.disabled, false);
});

test('DRIVER-SOURCES-UI-05: отказ установки карточки не удаляет каталог или черновик', async (t) => {
  const card = await installDialog(t, {
    handlers: {
      post: async (url) => {
        if (url === '/api/driver-installs/jobs') {
          throw new Error('В репозитории нет выбранной версии');
        }
      },
    },
  });

  await actionButton(card.dialog, /Jira/u).trigger('click');
  await card.dialog.find('input[name="tag"]').setValue('v1.0.0');
  await actionButton(card.dialog, /^\s*проверить пакет\s*$/iu).trigger('click');
  await card.flushPromises();
  assert.match(card.dialog.text(), /В репозитории нет выбранной версии/u);
  assert.equal(card.dialog.findAll('.driver-source').length, 2);
  assert.equal(card.dialog.find('input[name="url"]').exists(), false);
  assert.equal(actionButton(card.dialog, /Jira/u).attributes('aria-pressed'), 'true');
  assert.equal(card.dialog.find('input[name="tag"]').element.value, 'v1.0.0');
  assert.equal(card.dialog.find('[data-role="driver-custom-source"]').element.disabled, false);
});

test('DRIVER-SOURCES-UI-06: ошибка чтения каталога не отклоняет lifecycle и сохраняет форму', async (t) => {
  const card = await installDialog(t, {
    handlers: {
      get: async (url) => {
        if (url === '/api/trackers/sources') {
          throw new Error('Каталог временно недоступен');
        }
      },
    },
  });

  assert.match(card.dialog.text(), /Каталог временно недоступен/u);
  assert.equal(card.dialog.find('input[name="url"]').element.disabled, false);
});

test('DRIVER-SOURCES-UI-07: черновик своего URL и сброс чужих версий', async (t) => {
  const card = await installDialog(t);
  const custom = card.dialog.find('[data-role="driver-custom-source"]');

  await custom.trigger('click');

  const repo = card.dialog.find('input[name="url"]');

  assert.equal(repo.element.value, '');
  await repo.setValue('https://github.com/example/custom-tracker');
  await card.dialog.find('input[name="tag"]').setValue('v1.0.0');
  await actionButton(card.dialog, /^\s*версии\s*$/iu).trigger('click');
  await card.flushPromises();
  assert.equal(card.dialog.findAll('select option[value="v1.0.0"]').length, 1);

  await actionButton(card.dialog, /Битрикс24/u).trigger('click');
  assert.equal(card.dialog.find('input[name="url"]').exists(), false);
  assert.equal(card.dialog.findAll('select').length, 0);
  await custom.trigger('click');

  const restored = card.dialog.find('input[name="url"]');

  assert.equal(restored.element.value, 'https://github.com/example/custom-tracker');
  await actionButton(card.dialog, /^\s*проверить пакет\s*$/iu).trigger('click');
  await card.flushPromises();
  assert.deepEqual(card.apiCalls.find((call) => call.url === '/api/driver-installs/jobs').payload, {
    url: 'https://github.com/example/custom-tracker',
    version: '1.0.0',
  });
  assert.equal(restored.element.disabled, true);
  assert.equal(custom.element.disabled, true);
});

test('DRIVER-SOURCES-UI-08: источник активного задания после открытия', async (t) => {
  const card = await installDialog(t);

  await card.dialog.find('[data-role="driver-custom-source"]').trigger('click');
  await card.dialog.find('input[name="url"]').setValue('https://git.fixture/driver.git');
  await card.dialog.find('input[name="tag"]').setValue('v1.0.0');
  await actionButton(card.dialog, /^\s*проверить пакет\s*$/iu).trigger('click');
  await card.flushPromises();
  await card.dialog.find('button[aria-label="Закрыть"]').trigger('click');
  await card.flushPromises();
  await actionButton(card.wrapper, /^\s*установить\s*$/iu).trigger('click');
  await card.flushPromises();

  const reopened = card.wrapper.findAll('[role="dialog"]').at(-1);
  const repo = reopened.find('input[name="url"]');

  assert.equal(repo.element.value, 'https://git.fixture/driver.git');
  assert.equal(repo.element.disabled, true);
  assert.equal(reopened.find('[data-role="driver-custom-source"]').attributes('aria-pressed'), 'true');
  assert.equal(card.apiCalls.filter((call) => call.url === '/api/driver-installs/jobs').length, 1);
});
