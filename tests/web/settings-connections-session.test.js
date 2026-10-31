import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveLocaleText } from '../../shared/i18n/catalogs.ts';
import { compileModule, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';
import { assertSettingsFields } from './helpers/settings-consistency.js';

test('Подключения и система в общей сессии', async (t) => {
  await installUiBrowser(t);

  const [{ createPinia, setActivePinia }, { mount, flushPromises }, module] = await Promise.all([
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileModule(webFile('../tests/web/helpers/settings-pages.ts'), {
      stubs: {
        '../../../ui.ts': `
          export * from './src/ui.ts';
          export const confirmDialog = async (...args) => {
            globalThis.__connectionsConfirms.push(args);
            return globalThis.__connectionsAnswer;
          };
        `,
        '../../composables/useSse.ts': 'export const useSse = () => ({ connected: { value: false } });',
        '../router.ts': 'export const router = { push: async () => {} };',
        '../../../composables/useSse.ts': 'export const sseSubscribe = () => () => {};',
      },
    }),
  ]);
  const pinia = createPinia();

  setActivePinia(pinia);

  const settings = module.useSettingsStore(pinia);
  const calls = [];

  globalThis.__connectionsConfirms = [];
  globalThis.__connectionsAnswer = false;

  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, options = {}) => {
    const method = options.method ?? 'GET';
    const body = options.body ? JSON.parse(options.body) : undefined;

    calls.push({
      path: String(url),
      method,
      body,
    });

    if (String(url) === '/api/chat/active') {
      return new Response(JSON.stringify({ active: [{}, {}] }));
    }
    if (String(url) === '/api/auth/state') {
      return new Response(JSON.stringify({ authenticated: true }));
    }
    if (String(url) === '/api/system/restart') {
      return new Response(JSON.stringify({ ok: true }));
    }
    if (String(url) === '/api/mobile/status') {
      return new Response(JSON.stringify({
        server: { up: true },
        relays: [],
        devices: [],
      }));
    }
    if (String(url) === '/api/chat/sessions') {
      return new Response(JSON.stringify(method === 'DELETE' ? { closed: 1, skipped: 1 } : {
        maxSessions: 4,
        idleMs: 1800000,
        sessions: [{
          chatKey: 'free-chat',
          chatTitle: 'Свободный',
          running: false,
        },
          {
            chatKey: 'busy-chat',
            chatTitle: 'Занятой',
            running: true,
          }],
      }));
    }
    if (String(url).includes('/api/chat/sessions/')) {
      return new Response(JSON.stringify({ ok: true }));
    }
    if (String(url) === '/api/system/server') {
      return new Response(JSON.stringify({
        mode: 'desktop',
        systemd: false,
        pid: 42,
        uptimeSec: 120,
      }));
    }
    if (String(url) === '/api/system/launcher/autostart') {
      return new Response(JSON.stringify({ autostart: {
        unit: 'enabled',
        active: true,
        linger: true,
        mode: 'boot',
      } }));
    }
    if (String(url) === '/api/system/launcher') {
      return new Response(JSON.stringify({
        autostart: {
          unit: 'disabled',
          active: true,
          linger: true,
          mode: 'off',
        },
        shortcut: {
          desktop: false,
          menu: false,
          desktopDir: '/fixture/Desktop',
        },
      }));
    }

    throw new Error('Неизвестный API фикстуры подключений');
  };
  settings.setAuthenticated(true);
  settings.requestOpen({ pageId: 'connections.mobile' });

  const page = mount(module.ConnectionsPage, { props: { active: true }, global: { plugins: [pinia] } });

  t.after(() => {
    page.unmount();
    settings.dispose();
    globalThis.fetch = originalFetch;
    delete globalThis.__connectionsConfirms;
    delete globalThis.__connectionsAnswer;
  });
  await flushPromises();

  await t.test('SY01/02: автозапуск — черновик, режим приложения сохраняет правильную причину', async () => {
    page.unmount();
    settings.selectPage('system.startup');

    const startup = mount(module.SystemPage, { props: { active: true }, global: { plugins: [pinia] } });

    try {
      await flushPromises();
      assertSettingsFields(startup.element, module.SETTINGS_FIELDS, 'system.startup');
      assert.match(startup.text(), /Под управлением приложения/);
      await startup.find('[role="switch"]').setValue(true);
      assert.equal(calls.filter((call) => call.method === 'PUT').length, 0);
      await settings.apply();
      assert.equal(calls.filter((call) => call.method === 'PUT').length, 1);
      assert.equal(settings.snapshot.dirtyCount, 0);
    } finally {
      startup.unmount();
    }
  });
  await t.test('SY04: рестарт перечитывает процесс без смены документа', async () => {
    settings.selectPage('system.startup');
    globalThis.__connectionsAnswer = true;

    const system = mount(module.SystemPage, { props: { active: true }, global: { plugins: [pinia] } });

    try {
      await flushPromises();

      const href = location.href;
      const before = calls.filter((call) => call.path === '/api/system/server').length;

      await system.findAll('button').find((entry) => entry.text() === 'Перезапустить сервер')
        .trigger('click');
      await new Promise((resolve) => setTimeout(resolve, 1100));
      await flushPromises();

      assert.ok(calls.some((call) => call.path === '/api/system/restart' && call.method === 'POST'));
      assert.ok(calls.filter((call) => call.path === '/api/system/server').length > before);
      assert.match(system.text(), /Сервер снова доступен/);
      assert.equal(location.href, href);
      assert.match(resolveLocaleText(globalThis.__connectionsConfirms.at(-1)[0]), /ходы агентов: 2/);
      globalThis.__connectionsAnswer = false;
    } finally {
      system.unmount();
    }
  });

  await t.test('CN03/04: размеры окна и справка мобильного доступа', async () => {
    settings.selectPage('connections.mobile');

    const mobile = mount(module.ConnectionsPage, { props: { active: true }, global: { plugins: [pinia] } });

    try {
      await flushPromises();
      assertSettingsFields(mobile.element, module.SETTINGS_FIELDS, 'connections.mobile');
      assert.equal(mobile.find('.mobile-access').attributes('data-ui-touch'), undefined);
      assert.equal(mobile.get('[data-testid=mobile-open-add]').attributes('data-context'),
        'workspace-form-wrap');
      await mobile.findAll('button').find((entry) => entry.text().includes('Вход на этом компьютере'))
        .trigger('click');
      assert.match(mobile.text(), /Автоматический вход по локальному ключу/);
      assert.match(mobile.text(), /главное окно восстановит вход само/);
    } finally {
      mobile.unmount();
    }
  });

  await t.test('SY03/05: подтверждение погашения и остановка чтений', async () => {
    settings.selectPage('system.processes');

    const processes = mount(module.ProcessesPage, { props: { active: true }, global: { plugins: [pinia] } });

    try {
      await flushPromises();

      const confirmsBefore = globalThis.__connectionsConfirms.length;

      assertSettingsFields(processes.element, module.SETTINGS_FIELDS, 'system.processes');
      await processes.findAll('button').find((entry) => entry.text() === 'Погасить').trigger('click');
      await processes.findAll('button').find((entry) => entry.text() === 'Погасить свободные')
        .trigger('click');
      await flushPromises();

      assert.equal(globalThis.__connectionsConfirms.length, confirmsBefore + 2);
      assert.equal(calls.filter((call) => call.method === 'DELETE').length, 0);
      globalThis.__connectionsAnswer = true;
      await processes.findAll('button').filter((entry) => entry.text() === 'Погасить')[1].trigger('click');
      await flushPromises();
      assert.ok(calls.some((call) => call.path === '/api/chat/sessions/busy-chat?force=1'));
      await processes.setProps({ active: false });

      const reads = calls.length;

      await flushPromises();
      assert.equal(calls.length, reads);
    } finally {
      processes.unmount();
    }
  });

});
