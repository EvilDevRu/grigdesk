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
 * Реальный UI store работает с управляемыми ответами оболочки.
 * Запросы проходят без navigator.locks Node, чтобы тест сверял порядок ответов сам.
 */
async function surfaceFixture(t, {
  mode = 'main', capabilities = ['windows', 'taskSources'], replies = [],
} = {}) {
  const { createPinia, disposePinia, setActivePinia } = await import(
    '../../web/node_modules/pinia/dist/pinia.mjs'
  );
  const state = {
    mode,
    capabilities,
    calls: [],
    replies,
    toasts: [],
  };
  const pinia = createPinia();
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
  globalThis.__surfaceLauncher = state;
  t.after(() => {
    Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    disposePinia(pinia);
    setActivePinia(undefined);
    delete globalThis.__surfaceLauncher;
  });

  const module = await compileModule(webFile('src/stores/ui.ts'), { stubs: {
    './shell.ts': 'export const useShellStore = () => globalThis.__surfaceLauncher;',
    '../shared/desktopSettings.ts':
      'export const currentDesktopMode = () => globalThis.__surfaceLauncher.mode;',
    '../shared/shellClient.ts': `export const shellAction = async (method, path, body) => {
      const state = globalThis.__surfaceLauncher;
      state.calls.push({ path, body });
      return await state.replies.shift();
    };`,
    '../ui': 'export const showToast = (toast) => globalThis.__surfaceLauncher.toasts.push(toast);',
  } });

  setActivePinia(pinia);

  return { ui: module.useUiStore(), state };
}

test('SL-02: обычный выбор открывает диалог, явное отсоединение передаёт полную цель', async (t) => {
  const reply = Promise.withResolvers();
  const { ui, state } = await surfaceFixture(t, { replies: [reply.promise] });
  const source = `tracker@${'a'.repeat(64)}`;

  await ui.openTask('42', source);
  assert.equal(ui.taskId, '42');
  assert.equal(ui.taskSource, source);
  assert.deepEqual(state.calls, []);

  const detached = ui.moveTaskWindow();

  await ui.moveTaskWindow();
  assert.equal(ui.taskWindowMoving, true);
  assert.equal(ui.taskId, '42');
  assert.deepEqual(state.calls, [{
    path: '/surfaces/open',
    body: {
      kind: 'task',
      id: '42',
      source,
    },
  }]);
  reply.resolve({ opened: true });
  await detached;
  assert.equal(ui.taskId, null);
  assert.equal(ui.taskWindowMoving, false);
  assert.deepEqual(state.toasts, []);
});

test('SL-03: выбор из отдельного окна открывает диалог в main и сохраняет исходную задачу', async (t) => {
  const { ui, state } = await surfaceFixture(t, {
    mode: 'surface',
    replies: [{ opened: true }, {}, { opened: false }],
  });

  ui.openTaskInline('42');
  await ui.openTask('43');
  assert.equal(ui.taskId, '42');
  assert.deepEqual(state.calls, [{
    path: '/surfaces/main',
    body: { destination: 'task-dialog', target: { kind: 'task', id: '43' } },
  }]);
  assert.deepEqual(state.toasts, []);
  await ui.openTask('44');
  await ui.openTask('45');
  assert.equal(ui.taskId, '42');
  assert.equal(state.calls.length, 3);
  assert.equal(state.toasts.length, 2);
});

test('SL-04: ошибка сохраняет диалог, поздний успех не закрывает следующую задачу', async (t) => {
  const deferred = Promise.withResolvers();
  const { ui, state } = await surfaceFixture(t, { replies: [{ opened: false }, {}, deferred.promise] });

  await ui.openTask('grigdesk:100000000000');

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await ui.moveTaskWindow();
    assert.equal(ui.taskId, '100000000000');
    assert.equal(ui.taskUnavailable, 'legacy-own');
    assert.equal(ui.taskWindowMoving, false);
  }

  assert.equal(state.calls.length, 2);
  assert.equal(state.toasts.length, 2);
  assert.deepEqual(state.calls[0].body, {
    kind: 'task',
    id: '100000000000',
    unavailable: 'legacy-own',
  });

  const detached = ui.moveTaskWindow();

  await ui.openTask('43');
  deferred.resolve({ opened: true });
  await detached;
  assert.equal(ui.taskId, '43');
  assert.equal(ui.taskWindowMoving, false);
});

test('SL-05: прежняя оболочка оставляет адресные задачи и длинные номера в диалоге', async (t) => {
  const { ui, state } = await surfaceFixture(t, { capabilities: ['windows'] });
  const source = `tracker@${'a'.repeat(64)}`;

  await ui.openTask('42', source);
  assert.equal(ui.taskSource, source);
  assert.equal(ui.taskWindowTarget, null);
  await ui.moveTaskWindow();
  await ui.openTask('1000000000000000');
  assert.equal(ui.taskId, '1000000000000000');
  assert.equal(ui.taskWindowTarget, null);
  await ui.moveTaskWindow();
  await ui.openTask('не-задача');
  assert.equal(ui.taskId, '1000000000000000');
  assert.equal(state.toasts.length, 1);
  assert.deepEqual(state.calls, []);
});

test('SL-06: возврат передаёт источник и закрывает отдельную карточку после подтверждения', async (t) => {
  const reply = Promise.withResolvers();
  const { ui, state } = await surfaceFixture(t, {
    mode: 'surface',
    replies: [{ opened: false }, reply.promise],
  });
  const source = `tracker@${'a'.repeat(64)}`;

  ui.openTaskInline('42', source);
  await ui.moveTaskWindow();
  assert.equal(ui.taskId, '42');
  assert.equal(ui.taskWindowMoving, false);
  assert.match(state.toasts[0].title, /Присоединить обратно/);

  const attached = ui.moveTaskWindow();

  await ui.moveTaskWindow();
  assert.equal(ui.taskWindowMoving, true);
  assert.equal(ui.taskSource, source);
  assert.equal(ui.taskId, '42');
  assert.equal(state.calls.length, 2);
  assert.deepEqual(state.calls[1], {
    path: '/surfaces/main',
    body: {
      destination: 'task-dialog',
      target: {
        kind: 'task',
        id: '42',
        source,
      },
    },
  });
  reply.resolve({ opened: true });
  await attached;
  assert.equal(ui.taskId, null);
  assert.equal(ui.taskWindowMoving, false);
});

test('SL-07: выбор связанной задачи отменяет закрытие по позднему подтверждению возврата', async (t) => {
  const reply = Promise.withResolvers();
  const { ui } = await surfaceFixture(t, {
    mode: 'surface',
    replies: [reply.promise, { opened: true }],
  });

  ui.openTaskInline('42');

  const attached = ui.moveTaskWindow();

  await ui.openTask('43');
  reply.resolve({ opened: true });
  await attached;
  assert.equal(ui.taskId, '42');
  assert.equal(ui.taskWindowMoving, false);
});
