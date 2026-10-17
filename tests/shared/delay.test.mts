import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import test from 'node:test';

import { delayWithAbort } from '../../shared/lib/delay.ts';

test('пауза без отмены завершается без значения', async () => {
  assert.equal(await delayWithAbort(1), undefined);

  const controller = new AbortController();

  await delayWithAbort(1, controller.signal);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('ранняя отмена сохраняет идентичность reason без подписки', async () => {
  const controller = new AbortController();
  const reason = { cancelled: true };

  controller.abort(reason);
  await assert.rejects(delayWithAbort(1000, controller.signal), (error) => error === reason);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('отмена ожидания снимает обработчик и не оборачивает reason в AbortError', async () => {
  const controller = new AbortController();
  const reason = new Error('cancelled');
  const pending = delayWithAbort(60_000, controller.signal);
  const rejected = assert.rejects(pending, (error) => error === reason);

  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  controller.abort(reason);
  await rejected;
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});
