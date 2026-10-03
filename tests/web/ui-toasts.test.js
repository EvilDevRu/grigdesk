import assert from 'node:assert/strict';
import test from 'node:test';
import {
  pathToFileURL
} from 'node:url';

import {
  webFile
} from './helpers/compile-vue.js';

const TOASTS_URL = pathToFileURL(webFile('src/services/toasts.ts')).href;

/**
 * Ручные таймеры дают сценарию самому выбирать момент истечения.
 * Проверяется взвод и отмена, без зависимости от скорости машины.
 */
function fakeTimers() {
  let sequence = 0;
  const active = new Map();

  return {

    active,

    set(callback, ms) {
      sequence += 1;
      active.set(sequence, {
        callback,
        ms
      });

      return sequence;
    },

    clear(handle) {
      active.delete(handle);
    },

    fireAll() {
      const due = [...active.values()];

      active.clear();
      due.forEach((timer) => timer.callback());
    },

  };
}

async function center() {
  const {
    createToastCenter
  } = await import(TOASTS_URL);
  const timers = fakeTimers();

  return {
    toasts: createToastCenter(timers),
    timers
  };
}

test('T1: пустые id и заголовок не меняют центр', async () => {
  const {
    toasts
  } = await center();

  assert.equal(toasts.show({
    id: '',
    title: 'x'
  }), false);
  assert.equal(toasts.show({
    id: 'a',
    title: ''
  }), false);
  assert.equal(toasts.show({
    id: 1,
    title: 'x'
  }), false);
  assert.deepEqual(toasts.list(), []);
});

test('T2: нормализация и замороженные данные', async () => {
  const {
    toasts
  } = await center();
  const actions = ['a', 'b', 'c', 'd'].map((id) => ({
    id,
    label: id,
    run() {}
  }));

  toasts.show({
    id: 'a',
    title: 'A',
    tone: 'unknown',
    actions: [{
      id: 'bad',
      label: 'x'
    }, ...actions]
  });

  const [toast] = toasts.list();

  assert.equal(toast?.tone, 'accent');
  assert.deepEqual(toast.actions.map((action) => action.id), ['a', 'b', 'c']);
  assert.equal(Object.isFrozen(toast), true);
  assert.equal(Object.isFrozen(toast.actions), true);
  assert.equal(toast.scope, '');
  assert.equal(toast.body, '');
  assert.equal(toast.detail, '');
});

test('T3/T4: замена делает тост самым новым', async () => {
  const {
    toasts
  } = await center();

  toasts.show({
    id: 'a',
    title: 'A'
  });
  toasts.show({
    id: 'b',
    title: 'B'
  });
  toasts.show({
    id: 'a',
    title: 'Новый A'
  });

  assert.deepEqual(toasts.list().map((toast) => toast.id), ['b', 'a']);
});

test('T5: центр хранит двадцать новейших', async () => {
  const {
    toasts
  } = await center();

  for (let index = 0; index < 21; index += 1) {
    toasts.show({
      id: String(index),
      title: 'Тост'
    });
  }

  assert.equal(toasts.list().length, 20);
  assert.equal(toasts.list()[0].id, '1');
});

test('T6: подписка немедленная, снимки заморожены, отписка работает', async () => {
  const {
    toasts
  } = await center();
  const snapshots = [];
  const stop = toasts.subscribe((snapshot) => snapshots.push(snapshot));

  assert.equal(snapshots.length, 1);
  toasts.show({
    id: 'a',
    title: 'A'
  });
  assert.equal(snapshots.length, 2);
  assert.equal(Object.isFrozen(snapshots[1]), true);
  stop();
  toasts.show({
    id: 'b',
    title: 'B'
  });
  assert.equal(snapshots.length, 2);
});

test('T7: обычный тост истекает, срочный остаётся', async () => {
  const {
    toasts,
    timers
  } = await center();

  toasts.show({
    id: 'a',
    title: 'A'
  });
  assert.equal(timers.active.size, 1);
  assert.equal([...timers.active.values()][0].ms, 8000);
  timers.fireAll();
  assert.equal(toasts.list().length, 0);
  toasts.show({
    id: 'b',
    title: 'B',
    durationMs: 0
  });
  assert.equal(timers.active.size, 0);
});

test('T8: скрытый документ останавливает время', async () => {
  const {
    toasts,
    timers
  } = await center();

  toasts.show({
    id: 'a',
    title: 'A'
  });
  toasts.setDocumentVisible(false);
  assert.equal(timers.active.size, 0);
  timers.fireAll();
  assert.equal(toasts.list().length, 1);
  toasts.setDocumentVisible(true);
  assert.equal(timers.active.size, 1);
  assert.equal([...timers.active.values()][0].ms, 8000);
});

test('T9: пауза переживает смену видимости до resume', async () => {
  const {
    toasts,
    timers
  } = await center();

  toasts.show({
    id: 'a',
    title: 'A'
  });
  toasts.pause('a');
  assert.equal(timers.active.size, 0);
  toasts.setDocumentVisible(false);
  toasts.setDocumentVisible(true);
  assert.equal(timers.active.size, 0);
  toasts.resume('a');
  assert.equal(timers.active.size, 1);
});

test('T10: гашение по scope и всех очищает таймеры', async () => {
  const {
    toasts,
    timers
  } = await center();

  toasts.show({
    id: 'a',
    title: 'A',
    scope: 'chat:c1'
  });
  toasts.show({
    id: 'b',
    title: 'B',
    scope: 'chat:c2'
  });
  assert.deepEqual(toasts.dismissScope(''), []);
  assert.deepEqual(toasts.dismissScope('chat:c1'), ['a']);
  assert.equal(toasts.dismiss('missing'), false);
  assert.deepEqual(toasts.dismissAll(), ['b']);
  assert.equal(timers.active.size, 0);
});

test('T11: действие снимает тост до вызова и ловит ошибку', async (t) => {
  const {
    toasts
  } = await center();
  const errors = [];
  const original = console.error;

  console.error = (...args) => errors.push(args);
  t.after(() => {
    console.error = original;
  });
  toasts.show({
    id: 'a',
    title: 'A',
    actions: [{

      id: 'go',

      label: 'Действие',

      run() {
        assert.equal(toasts.list().length, 0);

        throw new Error('проверка отказа');
      },

    }]
  });

  assert.equal(await toasts.runAction('a', 'missing'), false);
  assert.equal(await toasts.runAction('a', 'go'), true);
  assert.equal(await toasts.runAction('a', 'go'), false);
  assert.equal(errors[0][0], 'Действие оповещения не выполнено');
});

test('причина ухода: таймер, человек, действие, код и лимит различаются', async () => {
  const {
    toasts,
    timers,
  } = await center();
  const reasons = [];

  toasts.subscribeDismissals((toast, reason) => {
    reasons.push(`${toast.id}:${reason}`);
  });
  toasts.show({
    id: 'timer',
    title: 'Таймер',
  });
  timers.fireAll();
  toasts.show({
    id: 'user',
    title: 'Человек',
  });
  toasts.dismiss('user', 'user');
  toasts.show({
    id: 'action',
    title: 'Действие',
    actions: [{
      id: 'go',
      label: 'Перейти',
      run() {},
    }],
  });
  await toasts.runAction('action', 'go');
  toasts.show({
    id: 'code',
    title: 'Код',
    scope: 'chat:c1',
  });
  toasts.dismissScope('chat:c1');

  for (let index = 0; index <= 20; index += 1) {
    toasts.show({
      id: `fill-${index}`,
      title: 'Заполнение',
      durationMs: 0,
    });
  }

  assert.deepEqual(reasons, [
    'timer:timeout',
    'user:user',
    'action:action',
    'code:program',
    'fill-0:overflow',
  ]);
});
