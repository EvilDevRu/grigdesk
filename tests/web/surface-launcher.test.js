import assert from 'node:assert/strict';
import test from 'node:test';
import { compileModule, webFile } from './helpers/compile-vue.js';

test('SL-01: inline без capability, native при подтверждении, unknown при потере ответа', async () => {
  const { resolveSurfaceOpening } = await compileModule(webFile('src/shared/surfaceLauncher.ts'));
  let calls = 0;
  const target = { kind: 'task', id: '42' };
  const send = async () => {
    calls += 1;

    return { opened: true };
  };

  assert.equal(await resolveSurfaceOpening(target, false, send), 'inline');
  assert.equal(calls, 0);
  assert.equal(await resolveSurfaceOpening(target, true, send), 'window');
  assert.equal(await resolveSurfaceOpening(target, true, async () => ({ opened: false })), 'inline');
  assert.equal(await resolveSurfaceOpening(target, true, async () => ({})), 'unknown');
  assert.equal(await resolveSurfaceOpening(target, true, async () => {
    throw new Error('Ответ потерян');
  }), 'unknown');
});

/**
 * Реальный UI store выбирает новое окно, а транспорт записывает только закрытые запросы.
 * Собственное назначение документа устанавливается единственным inline-входом.
 */
async function surfaceFixture(t, replies) {
  const { createPinia, disposePinia, setActivePinia } = await import(
    '../../web/node_modules/pinia/dist/pinia.mjs'
  );
  const state = {
    calls: [],
    replies,
    toasts: [],
  };
  const pinia = createPinia();

  globalThis.__surfaceLauncher = state;
  t.after(() => {
    disposePinia(pinia);
    setActivePinia(undefined);
    delete globalThis.__surfaceLauncher;
  });

  const module = await compileModule(webFile('src/stores/ui.ts'), { stubs: {
    './shell.ts': 'export const useShellStore = () => ({ capabilities: ["windows"] });',
    '../stores/shell.ts': 'export const useShellStore = () => ({ capabilities: ["windows"] });',
    '../shared/desktopSettings.ts': 'export const currentDesktopMode = () => "surface";',
    '../shared/shellClient.ts': `export const shellAction = async (method, path, body) => {
      const state = globalThis.__surfaceLauncher;
      state.calls.push({ path, body });
      return await state.replies.shift();
    };`,
    '../ui': 'export const showToast = (toast) => globalThis.__surfaceLauncher.toasts.push(toast);',
  } });

  setActivePinia(pinia);

  const ui = module.useUiStore();

  ui.openTaskInline('42');

  return { ui, state };
}

test('SL-03: другая задача получает окно, достоверный отказ доставляет диалог в main', async (t) => {
  const { ui, state } = await surfaceFixture(t, [
    { opened: true }, { opened: false }, { opened: true },
  ]);

  await ui.openTask('43');
  assert.equal(ui.taskId, '42');
  await ui.openTask('44');
  assert.equal(ui.taskId, '42');
  assert.deepEqual(state.calls.map((call) => call.body), [
    { kind: 'task', id: '43' },
    { kind: 'task', id: '44' },
    { destination: 'task-dialog', target: { kind: 'task', id: '44' } },
  ]);
  assert.equal(state.calls.at(-1).path.endsWith('/surfaces/main'), true);
  assert.deepEqual(state.toasts, []);
});

test('SL-04: unknown и неподтверждённый main сохраняют свою карточку без автоповтора', async (t) => {
  const { ui, state } = await surfaceFixture(t, [{}, { opened: false }, { opened: false }]);

  await ui.openTask('43');
  assert.equal(ui.taskId, '42');
  assert.equal(state.calls.length, 1);
  assert.equal(state.toasts.length, 1);
  await ui.openTask('44');
  assert.equal(ui.taskId, '42');
  assert.equal(state.calls.length, 3);
  assert.equal(state.toasts.length, 2);
});
test('SL-02: настоящий UI store не применяет поздний fallback и не дублирует unknown', async (t) => {
  // Node предоставляет собственный navigator.locks: эта фикстура проверяет ответы
  // транспорта без очереди браузера, чтобы удержанный ACK не блокировал второй вызов.
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
  t.after(() => {
    if (navigatorDescriptor) {
      Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    } else {
      delete globalThis.navigator;
    }
  });

  const { createPinia, disposePinia, setActivePinia } = await import(
    '../../web/node_modules/pinia/dist/pinia.mjs'
  );
  const deferred = Promise.withResolvers();
  const state = {
    supported: true, 
    replies: [deferred.promise, { opened: false }], 
    toasts: []
  };

  globalThis.__surfaceUiTest = state;
  t.after(() => delete globalThis.__surfaceUiTest);

  const module = await compileModule(webFile('src/stores/ui.ts'), { stubs: {
      '../stores/shell.ts': [
        'export const useShellStore = () => ({',
        '  capabilities: globalThis.__surfaceUiTest.supported ? ["windows"] : []',
        '});',
      ].join('\n'),
      './shell.ts': [
        'export const useShellStore = () => ({',
        '  capabilities: globalThis.__surfaceUiTest.supported ? ["windows"] : []',
        '});',
      ].join('\n'),
      '../shared/desktopSettings.ts': [
        'export const currentDesktopMode = () =>',
        '  globalThis.__surfaceUiTest.mode ?? "main";',
      ].join('\n'),
      '../shared/shellClient.ts': [
        'export const shellAction = async () =>',
        '  await globalThis.__surfaceUiTest.replies.shift();',
      ].join('\n'),
      '../ui': 'export const showToast = (value) => globalThis.__surfaceUiTest.toasts.push(value);',
    } });

  const pinia = createPinia();

  setActivePinia(pinia);
  t.after(() => {
    disposePinia(pinia);
    setActivePinia(undefined);
  });

  const ui = module.useUiStore();
  const first = ui.openTask('42');

  await ui.openTask('43');
  assert.equal(ui.taskId, '43');
  deferred.resolve({ opened: false });
  await first;
  assert.equal(ui.taskId, '43');
  state.replies.push({ then(_resolve, reject) {
    reject(new Error('Сеть'));
  } });
  await ui.openTask('44');
  assert.equal(ui.taskId, '43');
  assert.equal(state.toasts.length, 1);
  state.supported = false;
  await ui.openTask('45');
  assert.equal(ui.taskId, '45');
  state.supported = true;
  await ui.openTask('не-задача');
  assert.equal(ui.taskId, 'не-задача');
  assert.equal(state.toasts.length, 1);

  const closing = Promise.withResolvers();

  state.replies.push(closing.promise);

  const opened = ui.openTask('46');

  ui.close();
  closing.resolve({ opened: false });
  await opened;
  assert.equal(ui.taskId, null);
  delete globalThis.__surfaceUiTest;
});
