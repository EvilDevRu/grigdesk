// Затишье сети — счёт молодых запросов, а не тишина в понимании Playwright.
//
// Проверяется на голом излучателе событий: важна логика счёта и пределов, а не
// браузер. Интервалы короткие, но с запасом относительно шага опроса в 50 мс.
import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';

import { trackNetwork } from '../../server/src/lib/showcase/render/networkQuiet.ts';

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

test('затишье наступает через quietMs после конца последнего молодого запроса', async () => {
  const page = new EventEmitter();
  const tracker = trackNetwork(page);
  const request = {};

  page.emit('request', request);

  const startedAt = Date.now();
  const pending = tracker.quiet({ quietMs: 150, capMs: 2000 });

  await sleep(250);
  assert.equal(tracker.inFlight(), 1);
  page.emit('requestfinished', request);

  assert.equal(await pending, true);
  assert.ok(
    Date.now() - startedAt >= 250 + 150 - 20,
    `отсчёт затишья обязан начаться после конца запроса: ${Date.now() - startedAt} мс`,
  );
});

test('новый запрос во время отсчёта сбрасывает его', async () => {
  const page = new EventEmitter();
  const tracker = trackNetwork(page);
  const startedAt = Date.now();
  const pending = tracker.quiet({ quietMs: 200, capMs: 2000 });

  await sleep(120);

  const late = {};

  page.emit('request', late);
  await sleep(60);
  page.emit('requestfailed', late);

  assert.equal(await pending, true);
  assert.ok(
    Date.now() - startedAt >= 180 + 200 - 20,
    `затишье наступило слишком рано: ${Date.now() - startedAt} мс`,
  );
});

test('предел ожидания возвращает false, если молодой запрос так и висит', async () => {
  const page = new EventEmitter();
  const tracker = trackNetwork(page);

  page.emit('request', {});

  const startedAt = Date.now();

  assert.equal(await tracker.quiet({ quietMs: 100, capMs: 300 }), false);
  assert.ok(Date.now() - startedAt >= 300 - 20, 'предел ожидания не должен срабатывать раньше срока');
  assert.ok(Date.now() - startedAt < 1000, 'предел ожидания обязан сработать вовремя');
});

test('запрос старше longRequestMs — поток событий — затишью не мешает', async () => {
  const page = new EventEmitter();
  const tracker = trackNetwork(page);

  page.emit('request', {});
  await sleep(120);

  assert.equal(await tracker.quiet({ quietMs: 100, capMs: 1000, longRequestMs: 100 }), true);
  assert.equal(tracker.inFlight(), 1, 'висящий запрос остаётся в счёте, но не среди молодых');
});

test('после dispose события страницы не учитываются', () => {
  const page = new EventEmitter();
  const tracker = trackNetwork(page);

  tracker.dispose();
  page.emit('request', {});

  assert.equal(tracker.inFlight(), 0);
  assert.equal(page.listenerCount('request'), 0);
  assert.equal(page.listenerCount('requestfinished'), 0);
  assert.equal(page.listenerCount('requestfailed'), 0);
});
