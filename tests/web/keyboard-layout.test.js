import assert from 'node:assert/strict';
import test from 'node:test';

import { observeKeyboardLayout } from '../../web/src/shared/keyboardLayout.ts';

/**
 * Управляемое окно воспроизводит фокус, видимость, сеть и таймеры без реального браузера.
 * В тесте нет клавиатурных событий: смена раскладки обязана обнаруживаться без набора.
 */
function fixture() {
  const win = new EventTarget();
  const document = new EventTarget();
  const timers = new Map();
  const calls = [];
  const values = [];
  let next = 0;

  document.focused = true;
  document.visibilityState = 'visible';
  document.hasFocus = () => document.focused;
  win.document = document;
  win.setTimeout = (callback, delay) => {
    const id = ++next;

    timers.set(id, { callback, delay });

    return id;
  };
  win.clearTimeout = (id) => timers.delete(id);
  win.fetch = (url, options) => new Promise((resolve, reject) => {
    calls.push({
      url,
      options,
      resolve,
      reject,
    });
  });

  const stop = observeKeyboardLayout(win, (value) => values.push(value));

  return {
    win,
    document,
    timers,
    calls,
    values,
    stop,
  };
}

async function answer(call, layout) {
  call.resolve({ ok: true, json: async () => ({ layout }) });

  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

test('опрос обновляет EN → RU без ввода и не создаёт параллельных запросов', async () => {
  const box = fixture();

  assert.equal(box.calls.length, 1);
  assert.equal(box.calls[0].url, '/__shell/keyboard-layout');
  assert.equal(box.calls[0].options.credentials, 'same-origin');
  await answer(box.calls[0], { code: 'us', variant: '' });
  assert.equal(box.values.at(-1).code, 'us');

  const poll = [...box.timers.values()].find((timer) => timer.delay === 500);

  poll.callback();
  poll.callback();
  assert.equal(box.calls.length, 2);
  await answer(box.calls[1], { code: 'ru', variant: '' });
  assert.equal(box.values.at(-1).code, 'ru');
  box.stop();
  assert.equal(box.timers.size, 0);
});

test('фон и размонтирование отменяют запрос; поздний ответ не меняет индикатор', async () => {
  const box = fixture();

  box.document.focused = false;
  box.win.dispatchEvent(new Event('blur'));
  assert.equal(box.calls[0].options.signal.aborted, true);
  await answer(box.calls[0], { code: 'ru', variant: '' });
  assert.equal(box.values.at(-1), null);
  assert.equal(box.timers.size, 0);
  box.document.focused = true;
  box.win.dispatchEvent(new Event('focus'));
  assert.equal(box.calls.length, 2);
  await answer(box.calls[1], { code: 'de', variant: '' });
  assert.equal(box.values.at(-1).code, 'de');
  box.document.visibilityState = 'hidden';
  box.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(box.timers.size, 0);
  assert.equal(box.values.at(-1), null);
  box.document.visibilityState = 'visible';
  box.document.dispatchEvent(new Event('visibilitychange'));
  box.stop();
  assert.equal(box.timers.size, 0);
  await answer(box.calls[2], { code: 'us', variant: '' });
  assert.equal(box.values.at(-1), null);
  box.win.dispatchEvent(new Event('focus'));
  assert.equal(box.calls.length, 3);
  assert.equal(box.timers.size, 0);
});

test('ошибка запроса сбрасывает прежнюю раскладку', async () => {
  const box = fixture();

  await answer(box.calls[0], { code: 'us', variant: '' });
  [...box.timers.values()].find((timer) => timer.delay === 500).callback();
  box.calls[1].reject(new Error('offline'));
  await answer(box.calls[1], null);
  assert.equal(box.values.at(-1), null);
  box.stop();
});
