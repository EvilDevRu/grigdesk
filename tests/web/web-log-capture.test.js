import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createMemoryHistory, createRouter }
  from '../../web/node_modules/vue-router/vue-router.node.mjs';

import { createWebLog } from '../../web/src/shared/webLog.ts';
import { installCapture } from '../../web/src/shared/webLogCapture.ts';

function makeLog() {
  return createWebLog({ now: () => new Date(), monotonicNow: () => 0,
    pageId: 'page-aaaaaaaaaaaaaaaa', tabId: 'tab-bbbbbbbbbbbbbbbb', version: 'dev',
    context: () => ({ route: '/chats/private', vis: 'visible', boot: null }) });
}

function fakeRouter(hooks) {
  return {
    beforeEach: (fn) => { hooks.beforeEach = fn; return () => { hooks.beforeEach = null; }; },
    afterEach: (fn) => { hooks.afterEach = fn; return () => { hooks.afterEach = null; }; },
    onError: (fn) => { hooks.onError = fn; return () => { hooks.onError = null; }; },
  };
}

// console.error подменяется на время теста: ловушка обязана печатать ошибку Vue сама.
function captureConsole(t) {
  const printed = [];
  const original = console.error;
  console.error = (...args) => printed.push(args);
  t.after(() => {
    console.error = original;
  });
  return printed;
}

test('ловушки пишут ошибки, не сохраняют message и снимаются при dispose', (t) => {
  const printed = captureConsole(t);
  const log = makeLog();
  const win = new EventTarget();
  let onResourceError;
  const addListener = win.addEventListener.bind(win);
  win.addEventListener = (name, listener, options) => {
    if (name === 'error') onResourceError = listener;
    addListener(name, listener, options);
  };
  const doc = new EventTarget();
  const app = { config: { errorHandler: null } };
  const hooks = {};
  const pinia = { use: (fn) => { hooks.plugin = fn; } };
  const off = installCapture({ app, router: fakeRouter(hooks), pinia, log, win, doc });

  const failure = new Error('secret-token');
  app.config.errorHandler(failure, { $options: { __name: 'ChatView' } }, 'render function');
  const rejection = new Event('unhandledrejection');
  Object.defineProperty(rejection, 'reason', { value: { password: 'secret-token' } });
  win.dispatchEvent(rejection);
  onResourceError({ target: { tagName: 'LINK', href: 'https://example.test/assets/site.css?token=secret' } });
  hooks.beforeEach({ path: '/projects/secret' }, { path: '/chats' });
  hooks.afterEach({ path: '/projects/secret' }, { path: '/chats' });
  const entries = log.snapshot().entries;
  const vue = entries.find((entry) => entry.ev === 'vue.error');
  assert.deepEqual([vue.data.info, vue.data.component], ['render', 'ChatView']);
  assert.deepEqual(printed, [[failure]], 'без прежнего обработчика ошибка Vue идёт в консоль');
  assert.ok(entries.some((entry) => entry.ev === 'js.rejection'));
  const resource = entries.find((entry) => entry.ev === 'res.error');
  assert.deepEqual([resource.data.tag, resource.data.category, resource.data.src],
    ['LINK', 'external', null]);
  assert.ok(entries.some((entry) => entry.ev === 'router.nav' && entry.data.to === '/projects/:id?'));
  assert.doesNotMatch(JSON.stringify(entries), /secret-token|password/u);
  off();
  assert.equal(app.config.errorHandler, null);
  assert.equal(hooks.beforeEach, null);
});

test('прежний errorHandler получает ошибку вместо повторной печати', (t) => {
  const printed = captureConsole(t);
  const seen = [];
  const app = { config: { errorHandler: (...args) => seen.push(args) } };
  const off = installCapture({ app, router: fakeRouter({}), pinia: { use: () => {} },
    log: makeLog(), win: new EventTarget(), doc: new EventTarget() });

  app.config.errorHandler(new Error('x'), null, 'https://vuejs.org/error-reference/#runtime-5');
  assert.equal(seen.length, 1);
  assert.equal(printed.length, 0);
  off();
});

test('store.error называет store и action и не дублирует записанный отказ API', () => {
  const log = makeLog();
  const hooks = {};
  const reported = new Error('api');
  const off = installCapture({ app: { config: { errorHandler: null } }, router: fakeRouter(hooks),
    pinia: { use: (fn) => { hooks.plugin = fn; } }, log, win: new EventTarget(),
    doc: new EventTarget(), isReportedError: (error) => error === reported });
  let onAction;
  hooks.plugin({ store: { $id: 'taskFavorites', $onAction: (fn) => { onAction = fn; return () => {}; } } });
  const fail = (name, error) => onAction({ name, onError: (handler) => handler(error) });

  fail('load', reported);
  fail('toggle', new TypeError('private'));
  const errors = log.snapshot().entries.filter((entry) => entry.ev === 'store.error');
  assert.equal(errors.length, 1);
  assert.deepEqual([errors[0].data.store, errors[0].data.action, errors[0].data.error.name],
    ['taskFavorites', 'toggle', 'TypeError']);
  off();
});

test('результат перехода различает успех и повтор того же адреса', async () => {
  const log = makeLog();
  const component = { render: () => null };
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component }, { path: '/projects/:id?', component }],
  });
  const off = installCapture({ app: { config: { errorHandler: null } }, router,
    pinia: { use: () => {} }, log, win: new EventTarget(), doc: new EventTarget() });

  await router.push('/projects/private-id');
  await router.push('/projects/private-id');
  const results = log.snapshot().entries.filter((entry) => entry.ev === 'router.nav')
    .map((entry) => [entry.data.to, entry.data.result]);
  assert.deepEqual(results, [['/projects/:id?', 'success'], ['/projects/:id?', 'duplicated']]);
  off();
});
