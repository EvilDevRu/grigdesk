// Карточка «Автозапуск и ярлык» («Настройки → Сервер»). Смысл проверки: человек решает,
// поднимется ли кокпит сам после включения машины, и ему должно быть видно, ЧТО именно
// случится — старт до входа в систему, только после входа или никогда. Плюс переключатель
// не вправе трогать живой процесс, а кнопка ярлыка обязана и ставить, и убирать.
import assert from 'node:assert/strict';
import test from 'node:test';
import { compileVue, webFile } from './helpers/compile-vue.js';

process.env.NODE_ENV = 'test';

const UI_STUB = `
export { default as UiButton } from '${webFile('src/components/primitives/UiButton.vue')}';
export { default as UiSwitch } from '${webFile('src/components/primitives/UiSwitch.vue')}';
`;

async function browserHarness(t) {
  const { Window } = await import('../../web/node_modules/happy-dom/lib/index.js');
  const browser = new Window({ url: 'http://cockpit.test/#/settings' });
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    location: browser.location,
    localStorage: browser.localStorage,
    Node: browser.Node,
    Element: browser.Element,
    HTMLElement: browser.HTMLElement,
    HTMLButtonElement: browser.HTMLButtonElement,
    HTMLInputElement: browser.HTMLInputElement,
    SVGElement: browser.SVGElement,
    Event: browser.Event,
    CustomEvent: browser.CustomEvent,
    getComputedStyle: browser.getComputedStyle.bind(browser),
  })) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  browser.document.body.innerHTML = '<div id="mount"></div>';
  t.after(() => browser.close());
  return browser;
}

const AUTOSTART = {
  boot: { unit: 'enabled', active: true, linger: true, mode: 'boot' },
  login: { unit: 'enabled', active: true, linger: false, mode: 'login' },
  off: { unit: 'disabled', active: true, linger: true, mode: 'off' },
  missing: { unit: 'missing', active: false, linger: null, mode: 'unavailable' },
};

// Сервер в объёме карточки: журнал запросов + подменяемые ответы.
function fakeApi(state) {
  const calls = [];
  return {
    calls,
    api: {
      async get(path) { calls.push(['GET', path]); return state.launcher; },
      async put(path, body) {
        calls.push(['PUT', path, body]);
        if (state.putError) throw new Error(state.putError);
        state.launcher = { ...state.launcher, autostart: state.nextAutostart };
        return { autostart: state.nextAutostart };
      },
      async post(path) {
        calls.push(['POST', path]);
        state.launcher = { ...state.launcher, shortcut: state.nextShortcut };
        return { shortcut: state.nextShortcut };
      },
      async del(path) {
        calls.push(['DELETE', path]);
        state.launcher = { ...state.launcher, shortcut: state.nextShortcut };
        return { shortcut: state.nextShortcut };
      },
    },
  };
}

async function mountCard(t, state, props = {}) {
  const browser = await browserHarness(t);
  const { api, calls } = fakeApi(state);
  globalThis.__serverLauncherApi = api;
  const [{ nextTick }, { mount }, Card] = await Promise.all([
    import('../../web/node_modules/vue/index.mjs'),
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(webFile('src/views/settings/ServerLauncher.vue'), {
      stubs: {
        '../../shared/apiClient.ts': 'export const api = globalThis.__serverLauncherApi;',
        '../../ui': UI_STUB,
      },
    }),
  ]);
  const wrapper = mount(Card, {
    props,
    attachTo: browser.document.querySelector('#mount'),
  });
  t.after(() => {
    wrapper.unmount();
    delete globalThis.__serverLauncherApi;
  });
  await nextTick();
  await nextTick();

  return { wrapper, calls, nextTick, text: () => wrapper.text() };
}

test('старт при включении машины назван прямо, переключатель включён', async (t) => {
  const card = await mountCard(t, {
    launcher: {
      autostart: AUTOSTART.boot,
      shortcut: { desktopDir: '/home/test/Desktop', desktop: true, menu: true },
    },
  });

  assert.equal(card.wrapper.get('[data-testid="launcher-mode"]').text(), 'При включении машины');
  assert.match(card.wrapper.get('[data-testid="autostart-note"]').text(), /до входа в систему/);
  assert.equal(card.wrapper.get('[data-testid="autostart-switch"]').element.checked, true);
  assert.match(card.wrapper.get('[data-testid="shortcut-state"]').text(), /на рабочем столе и в меню/);
  assert.equal(card.wrapper.get('[data-testid="shortcut-toggle"]').text(), 'Убрать ярлык');
});

test('enabled без linger — «Только при входе» и подсказка про enable-linger', async (t) => {
  const card = await mountCard(t, {
    launcher: {
      autostart: AUTOSTART.login,
      shortcut: { desktopDir: '/home/test/Desktop', desktop: false, menu: false },
    },
  });

  assert.equal(card.wrapper.get('[data-testid="launcher-mode"]').text(), 'Только при входе');
  assert.match(card.wrapper.get('[data-testid="autostart-note"]').text(), /loginctl enable-linger/);
  assert.equal(card.wrapper.get('[data-testid="shortcut-toggle"]').text(), 'Создать ярлык');
});

test('без юнита переключатель заблокирован и зовёт установщик', async (t) => {
  const card = await mountCard(t, {
    launcher: {
      autostart: AUTOSTART.missing,
      shortcut: { desktopDir: null, desktop: false, menu: false },
    },
  });

  assert.equal(card.wrapper.get('[data-testid="autostart-switch"]').element.disabled, true);
  assert.match(card.wrapper.get('[data-testid="autostart-note"]').text(), /deploy\/install\.sh/);
  assert.equal(
    card.wrapper.get('[data-testid="shortcut-toggle"]').element.disabled,
    true,
    'без каталога рабочего стола ставить ярлык некуда',
  );
});

test('выключение автозапуска идёт PUT-ом и обещает, что живой сервер не тронут', async (t) => {
  const state = {
    launcher: {
      autostart: AUTOSTART.boot,
      shortcut: { desktopDir: '/home/test/Desktop', desktop: false, menu: false },
    },
    nextAutostart: AUTOSTART.off,
  };
  const card = await mountCard(t, state);

  await card.wrapper.get('[data-testid="autostart-switch"]').setValue(false);
  await card.nextTick();
  await card.nextTick();

  assert.deepEqual(card.calls[1],
    ['PUT', '/api/system/launcher/autostart', { enabled: false }]);
  assert.equal(card.wrapper.get('[data-testid="launcher-mode"]').text(), 'Выключен');
  assert.match(card.wrapper.get('[data-testid="launcher-message"]').text(), /живой сервер не тронут/);
  assert.match(card.wrapper.get('[data-testid="autostart-note"]').text(),
    /ярлык «Кокпит»|systemctl --user start/);
});

test('отказ сервера показан человеку, состояние карточки не врёт', async (t) => {
  const card = await mountCard(t, {
    launcher: {
      autostart: AUTOSTART.off,
      shortcut: { desktopDir: '/home/test/Desktop', desktop: false, menu: false },
    },
    putError: 'Юнит systemd не установлен — выполни deploy/install.sh.',
  });

  await card.wrapper.get('[data-testid="autostart-switch"]').setValue(true);
  await card.nextTick();
  await card.nextTick();

  assert.match(card.wrapper.get('[data-testid="launcher-message"]').text(), /Юнит systemd не установлен/);
  assert.equal(card.wrapper.get('[data-testid="launcher-mode"]').text(), 'Выключен');
});

test('кнопка ставит ярлык и после этого предлагает его убрать', async (t) => {
  const state = {
    launcher: {
      autostart: AUTOSTART.boot,
      shortcut: { desktopDir: '/home/test/Desktop', desktop: false, menu: false },
    },
    nextShortcut: { desktopDir: '/home/test/Desktop', desktop: true, menu: true },
  };
  const card = await mountCard(t, state);

  await card.wrapper.get('[data-testid="shortcut-toggle"]').trigger('click');
  await card.nextTick();
  await card.nextTick();

  assert.deepEqual(card.calls[1], ['POST', '/api/system/launcher/shortcut']);
  assert.equal(card.wrapper.get('[data-testid="shortcut-toggle"]').text(), 'Убрать ярлык');
  assert.match(card.wrapper.get('[data-testid="launcher-message"]').text(),
    /\/home\/test\/Desktop\/cockpit\.desktop/);

  state.nextShortcut = { desktopDir: '/home/test/Desktop', desktop: false, menu: false };
  await card.wrapper.get('[data-testid="shortcut-toggle"]').trigger('click');
  await card.nextTick();
  await card.nextTick();

  assert.deepEqual(card.calls[2], ['DELETE', '/api/system/launcher/shortcut']);
  assert.equal(card.wrapper.get('[data-testid="shortcut-toggle"]').text(), 'Создать ярлык');
});

test('ручной запуск сервера оговаривается отдельно: тумблер про юнит, не про процесс', async (t) => {
  const card = await mountCard(t, {
    launcher: {
      autostart: AUTOSTART.off,
      shortcut: { desktopDir: '/home/test/Desktop', desktop: false, menu: false },
    },
  }, { systemd: false });

  assert.match(card.text(), /запущен вручную/);
});
