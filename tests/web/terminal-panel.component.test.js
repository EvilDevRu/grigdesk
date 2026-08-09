import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.NODE_ENV = 'test';

const PANEL_PATH = fileURLToPath(new URL('../../web/src/views/terminal/TerminalPanel.vue', import.meta.url));
const VUE_URL = pathToFileURL(fileURLToPath(
  new URL('../../web/node_modules/vue/index.mjs', import.meta.url),
)).href;
let compileNonce = 0;

async function compilePanel() {
  const { parse, compileScript } = await import(
    '../../web/node_modules/@vue/compiler-sfc/dist/compiler-sfc.esm-browser.js'
  );
  const source = await readFile(PANEL_PATH, 'utf8');
  const { descriptor, errors } = parse(source, { filename: PANEL_PATH });
  assert.deepEqual(errors, []);
  let code = compileScript(descriptor, {
    id: `data-v-terminal-panel-test-${compileNonce}`,
    inlineTemplate: true,
  }).content;
  code = code
    .replaceAll('from "vue"', `from "${VUE_URL}"`)
    .replaceAll("from 'vue'", `from "${VUE_URL}"`)
    .replace("import { Terminal } from '@xterm/xterm';", 'const Terminal = globalThis.__terminalPanelTerminal;')
    .replace("import { FitAddon } from '@xterm/addon-fit';", 'const FitAddon = globalThis.__terminalPanelFitAddon;')
    .replace("import '@xterm/xterm/css/xterm.css';", '')
    .replace("import { api } from '../../shared/api-client.js';", 'const api = globalThis.__terminalPanelApi;');
  const nonce = compileNonce++;
  return (await import(
    `data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${nonce}`
  )).default;
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
