import assert from 'node:assert/strict';
import { compileModule, webFile } from './compile-vue.js';
import { installUiBrowser } from './ui-components.js';
import { featureModule, tick } from './tool-window-harness.js';

export const origin = 'http://grigdesk.test';
export const scope = 'test-client';
export const instance = 'tool-instance-aaaaaaaa';
export const snapshot = {

  project: 'demo',

  repo: 'demo',

  root: '/fixture/worktree',

  tab: 'files',

  file: 'src/a.ts',

  line: 7,

  commitMessage: 'Не потерять черновик',

};

/**
 * Канал не исполняет продуктовый протокол: он только переносит JSON и хранит историю.
 * Тест может повторить, задержать или потерять конкретное сообщение без настоящих окон.
 */
export function channelPair() {
  const make = () => ({

    posted: [],

    onmessage: null,

    closed: false,

    postMessage(data) {
      this.posted.push(structuredClone(data));
    },

    close() {
      this.closed = true;
      this.onmessage = null;
    },

  });
  const main = make();
  const child = make();
  const deliver = (from, to, index = from.posted.length - 1) => {
    if(!to.closed) {
      to.onmessage?.({ data: structuredClone(from.posted[index]) });
    }
  };

  return {

    main,

    child,

    deliver

  };
}

/**
 * Реальный координатор получает реальный dock и реестр контекста двух документов.
 * Native и lifecycle панелей — наблюдаемые порты; их ответы не исполняют переходов владения.
 */
export async function coordinatorFixture(t, options = {}) {
  if(!globalThis.document) {
    await installUiBrowser(t);
  }

  const { createPinia, disposePinia, setActivePinia } = await import(
    '../../../web/node_modules/pinia/dist/pinia.mjs'
  );
  const pinia = options.pinia || createPinia();

  setActivePinia(pinia);

  const [{ useDockStore }, { useUiContextStore }, product] = await Promise.all([
    compileModule(webFile('src/stores/dock.ts')),
    compileModule(webFile('src/stores/uiContext.ts')),
    featureModule('src/stores/toolWindows.ts'),
  ]);

  assert.equal(
    typeof product.createToolWindowCoordinator,
    'function',
    'Координатор передаёт владение панелью'
  );

  const dock = useDockStore(pinia);
  const context = useUiContextStore(pinia);
  const channels = channelPair();
  const events = [];
  const nativeCalls = [];
  const mounted = new Set(['code']);
  const native = {

    async open(id) {

      return { opened: true, instance };
    },

    async status() {

      return [{ id: 'code', instance }];
    },

    async focus(id, current) {

      return true;
    },

    async close(id, current) {

      return true;
    },

    ...options.native,

  };

  for(const [method, operation] of Object.entries(native)) {
    native[method] = async (...args) => {
      nativeCalls.push([method, ...args]);

      return operation(...args);
    };
  }

  const panels = {

    async exportState(id) {
      events.push('export:' + id);

      return structuredClone(snapshot);
    },

    /**
     * Фиксирует снятие прежнего владельца и ждёт отдельную микрозадачу.
     * Новый mount не может перескочить фактический unmount панели.
     */

    async unmount(id) {
      events.push('unmount:' + id);
      mounted.delete(id);
      dock.setMounted(id, false);
      await tick();
    },

    /**
     * Проверяет единственного владельца перед восстановлением панели.
     * В журнал попадает полный снимок, чтобы сравнить отказ и возврат.
     */

    async mount(id, state) {
      events.push(['mount:' + id, structuredClone(state)]);
      assert.equal(mounted.has(id), false, 'Нельзя создать второй экземпляр панели');
      mounted.add(id);
      dock.setMounted(id, true);
    },

    ...options.panels,

  };
  const coordinator = product.createToolWindowCoordinator({

    origin,

    scope,

    epoch: 'coordinator-aaaaaaaa',

    dock,

    context,

    channel: channels.main,

    native,

    panels,

    router: options.router || { push: async (path) => events.push(['route', path]) },

    canDock: options.canDock || (() => true),

    ...options.ports,

  });

  t.after(() => {
    coordinator.dispose();

    if(!options.pinia) {
      disposePinia(pinia);
    }
  });

  const message = (type, fields = {}) => ({

    version: 1,

    type,

    target: { kind: 'tool', id: 'code' },

    instance,

    scope,

    coordinatorEpoch: 'coordinator-aaaaaaaa',

    seq: 0,

    ...fields,

  });
  const receive = async (type, fields) => {
    channels.main.onmessage?.({ data: message(type, fields) });
    await tick();
  };
  const ready = async () => {
    await receive('ready');
    await receive('init-ack');
  };

  dock.open('code');

  return {

    coordinator,

    dock,

    context,

    channels,

    events,

    nativeCalls,

    panels,

    native,

    mounted,

    message,

    receive,

    ready,

  };
}
