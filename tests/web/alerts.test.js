import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compileModule,
  webFile
} from './helpers/compile-vue.js';

const UI_STUB = [
  'const h = () => globalThis.__alertsHarness;',
  'export const showToast = (options) => {',
  '  h().shown.push(options);',
  '  h().ids.add(options.id);',
  '  h().listener?.([...h().ids].map((id) => ({ id })));',
  '  return true;',
  '};',
  'export const dismissToast = (id) => {',
  '  h().dismissed.push(id);',
  '  h().ids.delete(id);',
  '  h().listener?.([...h().ids].map((value) => ({ id: value })));',
  '  return true;',
  '};',
  'export const dismissToastScope = (scope) => {',
  '  h().scopes.push(scope);',
  '  return [];',
  '};',
  'export const dismissAllToasts = () => {',
  '  h().all += 1;',
  '  h().ids.clear();',
  '  h().listener?.([]);',
  '  return [];',
  '};',
  'export const subscribeToastDismissals = (listener) => {',
  '  h().dismissListener = listener;',
  '  return () => {};',
  '};',
  'export const subscribeToasts = (listener) => {',
  '  h().listener = listener;',
  '  listener([...h().ids].map((id) => ({ id })));',
  '  return () => {};',
  '};',
].join('\n');

const NOTIFY_STUB = [
  'export const notify = (...args) => {',
  '  globalThis.__alertsHarness.system.push(args);',
  '  return Promise.resolve(true);',
  '};',
  'export const closeSystemNotification = (tag) => {',
  '  globalThis.__alertsHarness.closed.push(tag);',
  '  return Promise.resolve();',
  '};',
].join('\n');

/**
 * Окно и документ задаются явно: правило «человек здесь» читает видимость и фокус,
 * а адрес системного оповещения строится от текущего адреса окна.
 */
async function alertsModule(t, {
  visibility = 'visible',
  focused = true
} = {}) {
  globalThis.__alertsHarness = {

    shown: [],

    dismissed: [],

    scopes: [],

    all: 0,

    system: [],

    closed: [],

    ids: new Set(),

    listener: null,

    dismissListener: null,

  };

  for (const [key, value] of Object.entries({
      window: {
        location: {
          href: 'https://cockpit.test/#/board',
        },
      },
      document: {
        visibilityState: visibility,
        hasFocus: () => focused,
      },
    })) {
    Object.defineProperty(globalThis, key, {

      value,

      configurable: true,

      writable: true,

    });
  }

  t.after(() => {
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.__alertsHarness;
  });

  return compileModule(webFile('src/shared/alerts.ts'), {
    stubs: {
      '../ui': (UI_STUB) +
        "\nexport { vTooltip } from \"./src/services/tooltipDirective.ts\";",
      './notify.ts': NOTIFY_STUB,
    },
  });
}

test('A1: неполное оповещение не вызывает каналы', async (t) => {
  const api = await alertsModule(t);

  assert.equal(api.alertUser({
    id: '',
    title: 'x'
  }), false);
  assert.equal(api.alertUser({
    id: 'a',
    title: ''
  }), false);
  assert.deepEqual(globalThis.__alertsHarness.shown, []);
  assert.deepEqual(globalThis.__alertsHarness.system, []);
});

test('A2/A5: перед человеком только тост, срочный без таймера', async (t) => {
  const api = await alertsModule(t);

  api.alertUser({
    id: 'a',
    title: 'Ответ',
    body: 'Готово'
  });
  api.alertUser({
    id: 'b',
    title: 'Вопрос',
    sticky: true
  });

  const h = globalThis.__alertsHarness;

  assert.equal(h.shown.length, 2);
  assert.equal(h.shown[0].durationMs, undefined);
  assert.equal(h.shown[1].durationMs, 0);
  assert.equal(h.shown[0].tone, 'accent');
  assert.equal(h.shown[0].body, 'Готово');
  assert.deepEqual(h.system, []);
});

test('A2: своё действие перед переходом к цели', async (t) => {
  const api = await alertsModule(t);

  api.alertUser({
    id: 'a',
    title: 'Ответ',
    target: {
      kind: 'chat',
      chatId: 'c1'
    },

    actions: [{
      id: 'allow',
      label: 'Разрешить',
      run() {}
    }]
  });

  const actions = globalThis.__alertsHarness.shown[0].actions;

  assert.deepEqual(actions.map((action) => action.id), ['allow', 'open']);
  assert.equal(actions[1].label, 'Открыть чат');
});

test('A2: переход читает открывалку в момент щелчка', async (t) => {
  const api = await alertsModule(t);
  const target = {
    kind: 'chat',
    chatId: 'c1'
  };
  const opened = [];

  api.alertUser({
    id: 'a',
    title: 'Ответ',
    target
  });

  const action = globalThis.__alertsHarness.shown[0].actions[0];

  action.run();
  api.setAlertTargetOpener((value) => opened.push(value));
  action.run();
  assert.deepEqual(opened, [target]);
});

test('A3/A4: скрытое окно получает оба канала и адрес чата', async (t) => {
  const api = await alertsModule(t, {
    visibility: 'hidden'
  });

  api.alertUser({
    id: 'a',
    title: 'Ответ',
    body: 'Готово',
    target: {
      kind: 'chat',
      chatId: 'c1'
    }
  });

  const h = globalThis.__alertsHarness;

  assert.equal(h.shown.length, 1);
  assert.deepEqual(h.system, [
    ['Ответ', 'Готово', 'a', 'https://cockpit.test/#/chats?openChat=c1']
  ]);
});

test('A3/A4: видимое окно без фокуса получает системное', async (t) => {
  const api = await alertsModule(t, {
    focused: false
  });

  api.alertUser({
    id: 'a',
    title: 'Ответ'
  });
  assert.equal(globalThis.__alertsHarness.shown.length, 1);
  assert.equal(globalThis.__alertsHarness.system.length, 1);
});

test('A6: исчезновение тоста гасит только показанное системное', async (t) => {
  const api = await alertsModule(t, {
    visibility: 'hidden'
  });

  api.alertUser({
    id: 'a',
    title: 'Ответ'
  });
  api.dismissAlert('a');
  assert.deepEqual(globalThis.__alertsHarness.closed, ['a']);
  globalThis.document.visibilityState = 'visible';
  api.alertUser({
    id: 'b',
    title: 'Вопрос'
  });
  api.dismissAlert('b');
  assert.deepEqual(globalThis.__alertsHarness.closed, ['a']);
});

test('A7: scope и скрыть все делегируются общему центру', async (t) => {
  const api = await alertsModule(t);

  api.dismissAlertScope('chat:c1');
  api.dismissAllAlerts();
  assert.deepEqual(globalThis.__alertsHarness.scopes, ['chat:c1']);
  assert.equal(globalThis.__alertsHarness.all, 1);
});

/**
 * Снимок истории модуля: подписка сразу отдаёт текущее состояние, так тест читает
 * историю тем же путём, что и колокольчик в верхней панели.
 */
function historyOf(api) {
  let entries = [];
  const stop = api.subscribeAlertHistory((snapshot) => {
    entries = snapshot;
  });

  stop();

  return entries.map((entry) => `${entry.id}:${entry.state}`);
}

test('история: тост, ушедший сам, становится пропущенным', async (t) => {
  const api = await alertsModule(t);

  api.alertUser({
    id: 'chat-c1',
    title: 'Агент ответил',
    target: {
      kind: 'chat',
      chatId: 'c1',
    },
  });
  assert.deepEqual(historyOf(api), ['chat-c1:live']);

  globalThis.__alertsHarness.dismissListener({ id: 'chat-c1' }, 'timeout');
  assert.deepEqual(historyOf(api), ['chat-c1:missed']);
});

test('история: крестик человека — просмотрено, снятие кодом — разобрано', async (t) => {
  const api = await alertsModule(t);

  api.alertUser({
    id: 'a',
    title: 'A',
  });
  api.alertUser({
    id: 'b',
    title: 'B',
    scope: 'chat:c1',
  });
  globalThis.__alertsHarness.dismissListener({ id: 'a' }, 'user');
  api.dismissAlertScope('chat:c1');

  assert.deepEqual(historyOf(api), ['b:resolved', 'a:seen']);
});

test('история: повод исчез уже после ухода тоста — запись разобрана', async (t) => {
  const api = await alertsModule(t);

  api.alertUser({
    id: 'chat-ask-p1',
    title: 'Нужен твой ответ',
  });
  globalThis.__alertsHarness.dismissListener({ id: 'chat-ask-p1' }, 'timeout');
  api.dismissAlert('chat-ask-p1');

  assert.deepEqual(historyOf(api), ['chat-ask-p1:resolved']);
});

test('история: переход из записи идёт открывалкой и гасит пропуск', async (t) => {
  const api = await alertsModule(t);
  const opened = [];

  api.setAlertTargetOpener((target) => {
    opened.push(target);
  });
  api.alertUser({
    id: 'chat-c1',
    title: 'Агент ответил',
    target: {
      kind: 'chat',
      chatId: 'c1',
    },
  });
  globalThis.__alertsHarness.dismissListener({ id: 'chat-c1' }, 'timeout');

  let key = '';
  const stop = api.subscribeAlertHistory((snapshot) => {
    key = snapshot[0]?.key || '';
  });

  stop();

  assert.equal(api.openAlertHistoryEntry(key), true);
  assert.deepEqual(opened, [{
    kind: 'chat',
    chatId: 'c1',
  }]);
  assert.deepEqual(historyOf(api), ['chat-c1:seen']);
});

test('история: просмотр и очистка', async (t) => {
  const api = await alertsModule(t);

  api.alertUser({
    id: 'a',
    title: 'A',
  });
  globalThis.__alertsHarness.dismissListener({ id: 'a' }, 'timeout');
  api.markAlertHistorySeen();
  assert.deepEqual(historyOf(api), ['a:seen']);

  api.clearAlertHistory();
  assert.deepEqual(historyOf(api), []);
});
