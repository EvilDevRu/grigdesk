import assert from 'node:assert/strict';
import test from 'node:test';
import { compileVue, webFile } from './helpers/compile-vue.js';

process.env.NODE_ENV = 'test';

const PANEL_PATH = webFile('src/views/terminal/TerminalPanel.vue');

async function compilePanel() {
  return compileVue(PANEL_PATH, {
    stubs: {
      '@xterm/xterm': 'export const Terminal = globalThis.__terminalPanelTerminal;',
      '@xterm/addon-fit': 'export const FitAddon = globalThis.__terminalPanelFitAddon;',
      '../../shared/api-client.js': 'export const api = globalThis.__terminalPanelApi;',
    },
  });
}

let browser = null;
async function ensureBrowser() {
  if (browser) return browser;
  const { Window } = await import('../../web/node_modules/happy-dom/lib/index.js');
  browser = new Window({ url: 'http://cockpit.test/#/terminal' });
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    location: browser.location,
    localStorage: browser.localStorage,
    Node: browser.Node,
    Element: browser.Element,
    HTMLElement: browser.HTMLElement,
    SVGElement: browser.SVGElement,
    Event: browser.Event,
    CustomEvent: browser.CustomEvent,
    getComputedStyle: browser.getComputedStyle.bind(browser),
  })) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  return browser;
}

function runtimeHarness() {
  const state = { terminals: [], fits: [], sockets: [], observers: [] };
  class FakeTerminal {
    constructor() {
      this.cols = 80;
      this.rows = 24;
      this.writes = [];
      this.focusCalls = 0;
      this.disposed = false;
      state.terminals.push(this);
    }
    loadAddon(addon) { this.addon = addon; addon.term = this; }
    open(host) { this.host = host; }
    onData(callback) { this.onDataCallback = callback; return { dispose: () => { this.onDataCallback = null; } }; }
    write(value) { this.writes.push(value); }
    focus() { this.focusCalls += 1; }
    reset() { this.resetCalls = (this.resetCalls || 0) + 1; }
    dispose() { this.disposed = true; }
  }
  class FakeFitAddon {
    constructor() { this.calls = 0; state.fits.push(this); }
    fit() { this.calls += 1; }
  }
  class FakeSocket {
    static OPEN = 1;
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      this.closeCalls = 0;
      state.sockets.push(this);
    }
    send(value) { this.sent.push(JSON.parse(value)); }
    close() { this.closeCalls += 1; this.readyState = 3; }
    open() { this.readyState = FakeSocket.OPEN; this.onopen?.(); }
    message(value = '$ ') { this.onmessage?.({ data: value }); }
    serverClose() { this.readyState = 3; this.onclose?.(); }
  }
  class FakeResizeObserver {
    constructor(callback) { this.callback = callback; state.observers.push(this); }
    observe(target) { this.target = target; }
    disconnect() { this.disconnected = true; }
  }
  globalThis.__terminalPanelTerminal = FakeTerminal;
  globalThis.__terminalPanelFitAddon = FakeFitAddon;
  globalThis.__terminalPanelApi = { wsUrl: (path) => `ws://cockpit.test${path}` };
  Object.defineProperty(globalThis, 'WebSocket', { value: FakeSocket, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'ResizeObserver', { value: FakeResizeObserver, configurable: true, writable: true });
  let rafId = 0;
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    value: (callback) => {
      const id = ++rafId;
      queueMicrotask(() => callback(Date.now()));
      return id;
    },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', {
    value: () => {}, configurable: true, writable: true,
  });
  return state;
}

async function settle(flushPromises, cycles = 5) {
  for (let i = 0; i < cycles; i += 1) await flushPromises();
  await new Promise((resolve) => setImmediate(resolve));
}

async function mountPanel(t, props) {
  const ownBrowser = await ensureBrowser();
  ownBrowser.document.body.innerHTML = '<div id="mount"></div>';
  const state = runtimeHarness();
  const [{ mount, flushPromises }, Panel] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compilePanel(),
  ]);
  const wrapper = mount(Panel, {
    attachTo: ownBrowser.document.querySelector('#mount'),
    props,
  });
  t.after(() => wrapper.unmount());
  await settle(flushPromises);
  return { wrapper, state, flushPromises };
}

test('TerminalPanel не создаёт xterm/WS скрытым и переиспользует их после hide/show', async (t) => {
  const { wrapper, state, flushPromises } = await mountPanel(t, { active: false });
  assert.equal(state.terminals.length, 0);
  assert.equal(state.sockets.length, 0);

  await wrapper.setProps({ active: true });
  await settle(flushPromises);
  assert.equal(state.terminals.length, 1);
  assert.equal(state.sockets.length, 1);

  await wrapper.setProps({ active: false });
  await wrapper.setProps({ active: true });
  await settle(flushPromises);
  assert.equal(state.terminals.length, 1);
  assert.equal(state.sockets.length, 1, 'скрытие не создаёт второй PTY');
});

test('intent ждёт shell, вставляется без Enter ровно один раз, closed coalesce один reconnect', async (t) => {
  const firstIntent = { id: 1, type: 'insert', text: 'claude login' };
  const { wrapper, state, flushPromises } = await mountPanel(t, {
    active: true,
    intents: [firstIntent],
  });
  assert.equal(state.sockets.length, 1);
  const first = state.sockets[0];
  first.open();
  await settle(flushPromises);
  assert.equal(first.sent.filter((message) => message.t === 'in').length, 0, 'open ещё не означает готовый shell');

  first.message('$ ');
  await new Promise((resolve) => setTimeout(resolve, 230));
  await settle(flushPromises);
  assert.deepEqual(first.sent.filter((message) => message.t === 'in'), [
    { t: 'in', d: 'claude login' },
  ]);
  assert.deepEqual(wrapper.emitted('consume-intent'), [[1]]);

  await wrapper.setProps({ intents: [{ ...firstIntent }] });
  await settle(flushPromises);
  assert.equal(first.sent.filter((message) => message.t === 'in').length, 1, 'запаздывающий parent update не повторяет intent');

  state.terminals[0].cols = 123;
  state.terminals[0].rows = 47;
  state.observers[0].callback();
  await settle(flushPromises);
  assert.deepEqual(first.sent.filter((message) => message.t === 'resize').at(-1), {
    t: 'resize', cols: 123, rows: 47,
  });

  const lateClose = first.onclose;
  first.serverClose();
  await wrapper.setProps({ intents: [
    { id: 2, type: 'insert', text: 'second' },
    { id: 3, type: 'insert', text: 'third' },
  ] });
  await settle(flushPromises);
  assert.equal(state.sockets.length, 2, 'две параллельные команды используют один reconnect');

  const second = state.sockets[1];
  second.open();
  second.message('$ ');
  await new Promise((resolve) => setTimeout(resolve, 230));
  await settle(flushPromises);
  assert.deepEqual(second.sent.filter((message) => message.t === 'in'), [
    { t: 'in', d: 'second' },
    { t: 'in', d: 'third' },
  ]);
  assert.deepEqual(wrapper.emitted('consume-intent'), [[1], [2], [3]]);

  lateClose();
  await settle(flushPromises);
  assert.match(wrapper.text(), /подключено/);
  assert.doesNotMatch(second.sent.filter((message) => message.t === 'in').map((message) => message.d).join(''), /\n/);
});
