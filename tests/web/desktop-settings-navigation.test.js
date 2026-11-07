import assert from 'node:assert/strict';
import test from 'node:test';
import { Window } from '../../web/node_modules/happy-dom/lib/index.js';
import { compileModule, webFile } from './helpers/compile-vue.js';

globalThis.__VUE_PROD_DEVTOOLS__ = false;

const browser = new Window({ url: 'http://127.0.0.1:8140/' });

for (const name of ['window', 'document', 'navigator', 'location', 'HTMLElement',
  'Element', 'SVGElement', 'Node', 'Event', 'MouseEvent', 'history']) {
  Object.defineProperty(globalThis, name, { configurable: true, value: browser[name] });
}

const { createApp, h, onMounted, onUnmounted, nextTick } = await import(
  '../../web/node_modules/vue/index.mjs'
);
const { createRouter, createMemoryHistory, RouterView, RouterLink } = await import(
  '../../web/node_modules/vue-router/dist/vue-router.mjs'
);

/**
 * Настоящий memory-router монтирует страницу с наблюдаемым lifecycle.
 * Отказ навигации должен сохранить и маршрут, и тот же экземпляр страницы.
 */
async function fixture(t, mode, initial = '/chats', open = null) {
  const module = await compileModule(webFile('src/shared/settingsNavigation.ts'));
  const state = {
    mounted: 0,
    unmounted: 0,
    opened: 0
  };
  const view = {
    setup() {
      onMounted(() => {
        state.mounted += 1;
      });
      onUnmounted(() => {
        state.unmounted += 1;
      });

      return () => h('input', { value: 'черновик' });
    },
  };
  const router = createRouter({
    history: createMemoryHistory(),
    routes: ['chats', 'board', 'settings'].map((name) => ({
      path: '/' + name,
      name,
      component: view
    })),
  });
  const remove = module.installSettingsRouteGuard(router, { requestOpen: open ?? (() => {
    state.opened += 1;
  }) });

  await router.push(initial);
  await router.isReady();

  const root = document.createElement('div');
  const app = createApp({
    render: () => h('div', [h(RouterView), h(RouterLink, { to: '/settings' }, () => 'Настройки')]),
  });

  document.body.append(root);
  app.use(router);
  app.mount(root);
  await nextTick();
  t.after(() => {
    remove();
    app.unmount();
    root.remove();
  });

  return {
    router,
    state,
    root,
    remove
  };
}

test('IN01 страница: модал вместо перехода', async (t) => {
  const f = await fixture(t, 'page');

  await f.router.push('/settings');
  assert.equal(f.router.currentRoute.value.path, '/chats');
  assert.equal(f.state.opened, 1);
});

test('IN01 main: модал вместо перехода', async (t) => {
  const f = await fixture(t, 'main');
  const mounted = f.state.mounted;
  const result = await f.router.push('/settings');

  assert.equal(Boolean(result), true);
  assert.equal(f.router.currentRoute.value.path, '/chats');
  assert.equal(f.state.opened, 1);
  assert.equal(f.state.mounted, mounted);
  assert.equal(f.state.unmounted, 0);
});

test('SW-R03 RouterLink ведёт так же', async (t) => {
  const f = await fixture(t, 'main');

  f.root.querySelector('a').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.state.opened, 1);
  assert.equal(f.router.currentRoute.value.path, '/chats');
  assert.equal(f.state.unmounted, 0);
});

test('SW-R04 первая навигация на /settings', async (t) => {
  const f = await fixture(t, 'main', '/settings');

  assert.equal(f.router.currentRoute.value.path, '/board');
  assert.equal(f.state.opened, 1);
});

test('SW-R05 другие разделы не затронуты', async (t) => {
  const f = await fixture(t, 'main');

  await f.router.push('/board');
  assert.equal(f.router.currentRoute.value.path, '/board');
  f.remove();
  await f.router.push('/settings');
  assert.equal(f.router.currentRoute.value.path, '/settings');
  assert.equal(f.state.opened, 0);
});

test('IN06 возвращённый null не меняет отмену навигации', async (t) => {
  let calls = 0;
  const f = await fixture(t, 'main', '/chats', () => {
    calls += 1;

    return null;
  });

  await f.router.push('/settings');
  assert.equal(f.router.currentRoute.value.path, '/chats');
  assert.equal(calls, 1);
});

test('SW-R07 режим из UA и адреса', async () => {
  for (const [role, search, expected] of [
    ['main', '', 'main'], ['settings', '?window=settings', 'page'],
    ['settings', '', 'page'], ['auxiliary', '?window=settings', 'page'],
  ]) {
    Object.defineProperty(browser.navigator, 'userAgent', {
      configurable: true,
      value: `Electron GrigDeskSettings/1 GrigDeskWindow/${role}`,
    });
    browser.location.search = search;

    const module = await compileModule(webFile('src/shared/desktopSettings.ts'));

    assert.equal(module.currentDesktopMode(), expected);
    browser.location.search = '?changed=1';
    assert.equal(module.currentDesktopMode(), expected);
  }
});


test('IN06/11: слушатель один, detail не читается, старый disposer не снимает новый', async () => {
  const module = await compileModule(webFile('src/shared/settingsNavigation.ts'));
  const calls = [];
  const first = module.installSettingsOpenListener(window, (request) => calls.push(request));
  const second = module.installSettingsOpenListener(window, (request) => calls.push(request));
  const event = new browser.Event('grigdesk:open-settings');

  Object.defineProperty(event, 'detail', {
    get() {
      throw new Error('Недоверенный detail прочитан');
    },
  });
  first();
  window.dispatchEvent(event);
  assert.deepEqual(calls, [{ source: 'shortcut' }]);
  second();
  window.dispatchEvent(event);
  assert.equal(calls.length, 1);
});
