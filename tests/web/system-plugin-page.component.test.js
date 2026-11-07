import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { settingsHarness } from './helpers/settings-harness.js';
import { assertSettingsFields } from './helpers/settings-consistency.js';
import { searchSettings } from '../../web/src/features/settings/search.ts';
import { createUiBrowser } from './helpers/ui-components.js';

let browser;

after(() => browser?.close());

/**
 * Vue сохраняет document при импорте: все сценарии файла используют одно окно.
 * Каждый тест получает собственные Pinia и session, а предыдущая форма размонтируется.
 */
async function systemHarness(t, pageId, options = {}) {
  browser ||= await createUiBrowser();
  browser.document.body.innerHTML = '<div id="mount"></div>';

  return settingsHarness(t, pageId, 'PluginPage', {
    ...options,
    browser
  });
}

const ssh = {
  id: 'ssh',
  system: true,
  name: 'SSH',
  version: '0.1.0',
  description: 'Терминал и SFTP для человека, надзорное выполнение команд для агента.',
  enabled: false,
  needsRestart: true,
  category: 'dev',
  settings: [
    {
      key: 'outputLimitKiB',
      type: 'number',
      label: 'Лимит вывода, KiB',
      default: 64,
      min: 4,
      max: 1024,
      step: 4,
    },
    {
      key: 'echoToTerminal',
      type: 'checkbox',
      label: 'Эхо команд агента в терминал',
      default: true
    },
  ],
  values: {
    outputLimitKiB: 64,
    echoToTerminal: true
  },
};

const telegram = {
  id: 'telegram',
  system: true,
  name: 'Телеграм',
  version: '0.1.0',
  description: 'Подключение бота Telegram.',
  enabled: false,
  needsRestart: false,
  settings: [],
  values: {},
};

test('Telegram: настройка подключения доступна после сохранения включения', async (t) => {
  const h = await systemHarness(t, 'connections.telegram', {
    prepare({ plugins }) {
      plugins.list = [structuredClone(telegram)];
    },
  });
  const setup = () => h.wrapper.get('[data-telegram-setup]');

  assert.match(h.wrapper.text(), /токену, выбрать чаты и настроить пульт/u);
  assert.equal(setup().element.disabled, true);
  assert.match(h.wrapper.text(), /Включите Telegram и нажмите «Применить»/u);
  await h.wrapper.get('[role="switch"]').setValue(true);
  assert.equal(setup().element.disabled, true);
  assert.match(h.wrapper.text(), /Нажмите «Применить», чтобы сохранить включение/u);
  assert.equal(h.writes().length, 0);
  assert.deepEqual(h.control.navigations, []);

  await h.settings.apply();
  await h.flushPromises();
  assert.equal(setup().element.disabled, false);
  await setup().trigger('click');
  await h.flushPromises();
  assert.deepEqual(h.control.navigations, ['/telegram']);
  assert.equal(h.settings.isOpen, false);
  assert.deepEqual(h.writes().map((call) => call.path), ['/api/plugins/telegram/toggle']);
});

test('Telegram: ошибка включения оставляет переход недоступным', async (t) => {
  const h = await systemHarness(t, 'connections.telegram', {
    prepare({ plugins, control }) {
      plugins.list = [structuredClone(telegram)];
      control.handlers['/api/plugins/telegram/toggle'] = () =>
        Response.json({ error: 'Не удалось включить Telegram' }, { status: 503 });
    },
  });

  await h.wrapper.get('[role="switch"]').setValue(true);
  await h.settings.apply();
  await h.flushPromises();
  assert.equal(h.wrapper.get('[data-telegram-setup]').element.disabled, true);
  assert.equal(h.plugins.byId('telegram').enabled, false);
  assert.equal(h.settings.isOpen, true);
  assert.deepEqual(h.control.navigations, []);
});

test('Telegram: переход сохраняет выбор судьбы других неприменённых настроек', async (t) => {
  const h = await systemHarness(t, 'connections.telegram', {
    prepare({ plugins }) {
      plugins.list = [{ ...structuredClone(telegram), enabled: true }, structuredClone(ssh)];
    },
  });

  h.settings.selectPage('connections.ssh');
  await h.flushPromises();
  await h.wrapper.get('input[type="number"]').setValue('128');
  h.settings.selectPage('connections.telegram');
  await h.flushPromises();
  await h.wrapper.get('[data-telegram-setup]').trigger('click');
  assert.equal(h.settings.closeChoiceOpen, true);
  assert.deepEqual(h.control.navigations, []);
  await h.settings.chooseClose('continue');
  assert.equal(h.settings.isOpen, true);
  assert.equal(h.settings.snapshot.dirtyCount, 1);

  await h.wrapper.get('[data-telegram-setup]').trigger('click');
  await h.settings.chooseClose('discard');
  await h.flushPromises();
  assert.deepEqual(h.control.navigations, ['/telegram']);
  assert.equal(h.settings.isOpen, false);
  assert.equal(h.writes().length, 0);
});

test('Telegram: ошибка перехода сохраняет окно настроек', async (t) => {
  const h = await systemHarness(t, 'connections.telegram', {
    prepare({ plugins }) {
      plugins.list = [{ ...structuredClone(telegram), enabled: true }];
    },
    navigate: async () => {
      throw new Error('Переход недоступен');
    },
  });

  await h.wrapper.get('[data-telegram-setup]').trigger('click');
  await h.flushPromises();
  assert.deepEqual(h.control.navigations, ['/telegram']);
  assert.equal(h.settings.isOpen, true);
  assert.equal(h.wrapper.get('[data-telegram-setup]').element.disabled, false);
  assert.match(h.settings.navigationError, /Не удалось открыть/u);
});

test('Telegram: уже открытый раздел закрывает настройки без повторного перехода', async (t) => {
  const previousHistory = globalThis.history;

  globalThis.history = browser.history;
  t.after(() => {
    globalThis.history = previousHistory;
  });

  const { createMemoryHistory, createRouter } = await import(
    '../../web/node_modules/vue-router/dist/vue-router.mjs');
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/telegram', component: { template: '<div />' } }],
  });

  await router.push('/telegram');

  const h = await systemHarness(t, 'connections.telegram', {
    prepare({ plugins }) {
      plugins.list = [{ ...structuredClone(telegram), enabled: true }];
    },
    navigate: (target) => router.push(target),
  });

  await h.wrapper.get('[data-telegram-setup]').trigger('click');
  await h.flushPromises();
  assert.equal(h.settings.isOpen, false);
  assert.deepEqual(h.control.navigations, ['/telegram']);
});

test('Страница системного плагина: форма без списка магазина, Apply и тумблер', async (t) => {
  const h = await systemHarness(t, 'connections.ssh', {
    prepare({ plugins }) {
      plugins.list = [structuredClone(ssh)];
    },
  });

  assert.equal(h.settings.pageId, 'connections.ssh');
  assert.match(h.wrapper.text(), /SSH/);
  assert.equal(h.wrapper.find('[data-plugin-filter]').exists(), false);
  assert.equal(h.wrapper.find('[data-select-plugin]').exists(), false);
  assertSettingsFields(h.wrapper.element,
    [...h.module.SETTINGS_FIELDS, ...h.settings.dynamicFields], 'connections.ssh');

  await h.wrapper.get('input[type="number"]').setValue('128');
  await h.wrapper.get('[role="switch"]').setValue(true);
  assert.equal(h.writes().length, 0);
  assert.equal(h.plugins.byId('ssh').enabled, false);

  h.settings.selectPage('tools.showcase');
  await h.flushPromises();
  h.settings.selectPage('connections.ssh');
  await h.flushPromises();
  assert.equal(h.wrapper.get('input[type="number"]').element.value, '128');
  assert.equal(h.wrapper.get('[role="switch"]').element.checked, true);
  await h.settings.apply();
  await h.flushPromises();

  assert.deepEqual(h.writes().map((call) => call.path),
    ['/api/plugins/ssh/settings', '/api/plugins/ssh/toggle']);
  assert.deepEqual(h.writes()[0].body.values, {
    outputLimitKiB: 128,
    echoToTerminal: true
  });
  assert.equal(h.plugins.byId('ssh').enabled, true);
  assert.equal(h.plugins.restartPending.ssh, true);
  assert.match(h.wrapper.text(), /Ждёт перезапуска/u);
  assert.equal(h.wrapper.find('[data-plugin-page="ssh"]').exists(), true);
});

test('Страница системного плагина: исчезнувший плагин объясняет причину', async (t) => {
  const h = await systemHarness(t, 'tools.showcase');

  assert.match(h.wrapper.text(), /Плагин больше недоступен/u);
  assert.equal(h.wrapper.find('[data-plugin-filter]').exists(), false);
});

test('Системная страница: поиск открывает и фокусирует поле без entity', async (t) => {
  const h = await systemHarness(t, 'connections.ssh', {
    prepare({ plugins }) {
      plugins.list = [structuredClone(ssh)];
    },
  });
  const result = searchSettings('Лимит вывода', h.settings.dynamicFields).find((entry) =>
    entry.address?.pageId === 'connections.ssh'
    && entry.address.fieldPath[1] === 'outputLimitKiB');

  assert.equal(Boolean(result), true);
  h.settings.selectPage('tools.showcase');
  await h.flushPromises();
  h.settings.openSearchResult(result);
  await h.flushPromises();

  assert.equal(h.settings.pageId, 'connections.ssh');
  assert.equal(h.settings.entityId, undefined);
  assert.equal(h.settings.revealTarget, null);
  assert.equal(h.wrapper.find('[data-settings-field][data-revealed="true"]').exists(), true);
  assert.equal(h.browser.document.activeElement === h.wrapper.get('input[type="number"]').element, true);
  assert.equal(h.writes().length, 0);
});

test('Системная страница: ожидание, ошибка чтения, retry и успешная форма', async (t) => {
  const pending = Promise.withResolvers();
  let attempts = 0;
  const h = await systemHarness(t, 'connections.ssh', {
    prepare({ plugins, control }) {
      plugins.list = [];
      plugins.loaded = false;
      control.handlers['/api/plugins'] = () => {
        attempts += 1;

        return attempts === 1 ? pending.promise : Response.json({ plugins: [structuredClone(ssh)] });
      };
    },
  });

  assert.equal(h.wrapper.find('[data-plugin-loading]').exists(), true);
  assert.equal(h.wrapper.find('[data-plugin-missing]').exists(), false);
  pending.resolve(Response.json({ error: 'Каталог временно недоступен' }, { status: 503 }));
  await h.flushPromises();
  assert.equal(h.wrapper.find('[data-plugin-load-error]').exists(), true);
  assert.equal(h.wrapper.find('[data-plugin-missing]').exists(), false);
  assert.equal(h.wrapper.find('[data-plugin-loading]').exists(), false);

  await h.wrapper.get('[data-plugin-retry]').trigger('click');
  await h.flushPromises();
  assert.equal(attempts, 2);
  assert.equal(h.wrapper.find('[data-plugin-load-error]').exists(), false);
  assert.equal(h.wrapper.get('input[type="number"]').element.value, '64');
  assert.equal(h.writes().length, 0);
});

test('Системная страница: recovery объясняет недоступный тумблер', async (t) => {
  const h = await systemHarness(t, 'connections.ssh', {
    prepare({ plugins }) {
      plugins.list = [structuredClone(ssh)];
    },
  });
  const installer = h.module.usePluginInstallStore();

  installer.recoveryError = { message: 'Требуется восстановление' };
  await h.flushPromises();
  assert.match(h.wrapper.text(), /Требуется восстановление/u);
  assert.equal(h.wrapper.get('[role="switch"]').element.disabled, true);
  installer.recoveryError = null;
  await h.flushPromises();
  assert.equal(h.wrapper.get('[role="switch"]').element.disabled, false);
  assert.equal(h.writes().length, 0);
});

test('Системная страница: поздний каталог не регистрирует ресурсы в новом открытии', async (t) => {
  const pending = Promise.withResolvers();
  const h = await systemHarness(t, 'connections.ssh', {
    prepare({ plugins, control }) {
      plugins.loaded = false;
      plugins.list = [];
      control.handlers['/api/plugins'] = () => pending.promise;
    },
  });

  h.settings.dispose();
  h.settings.requestOpen({ pageId: 'interface.behavior' });
  await h.flushPromises();
  pending.resolve(Response.json({ plugins: [structuredClone(ssh)] }));
  await h.flushPromises();

  assert.equal(h.settings.pageId, 'interface.behavior');
  assert.equal(h.settings.dynamicFields.length, 0);
  assert.equal(h.settings.snapshot.resources.length, 0);
  assert.equal(h.writes().length, 0);
});

test('Системная страница: поздний каталог после ухода не возвращает старую страницу', async (t) => {
  const pending = Promise.withResolvers();
  const h = await systemHarness(t, 'connections.ssh', {
    prepare({ plugins, control }) {
      plugins.loaded = false;
      plugins.list = [];
      control.handlers['/api/plugins'] = () => pending.promise;
    },
  });

  h.settings.selectPage('interface.behavior');
  h.wrapper.unmount();
  pending.resolve(Response.json({ plugins: [structuredClone(ssh), {
    id: 'custom',
    name: 'Custom',
    system: false,
    enabled: false,
    settings: [],
    values: {},
  }] }));
  await h.flushPromises();

  assert.equal(h.settings.pageId, 'interface.behavior');
  assert.equal(h.settings.entityId, undefined);
  assert.equal(h.settings.snapshot.resources.length, 0);
  assert.equal(h.writes().length, 0);
});
