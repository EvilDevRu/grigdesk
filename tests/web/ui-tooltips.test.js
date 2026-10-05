process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, test } from 'node:test';

import {
  currentTooltip,
  forgetTooltipTarget,
  hideTooltip,
  releaseTooltip,
  requestTooltip,
  resetTooltips,
  subscribeTooltip,
  updateTooltip,
} from '../../web/src/services/tooltips.ts';
import { createUiBrowser } from './helpers/ui-components.js';

let browser;
let a;
let b;

before(async () => {
  browser = await createUiBrowser();
});

after(async () => {
  await browser.close();
});

beforeEach((t) => {
  resetTooltips();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  a = browser.document.createElement('button');
  b = browser.document.createElement('span');
  browser.document.body.append(a, b);
});

afterEach(() => {
  resetTooltips();
  a.remove();
  b.remove();
});

test('TIP-SVC-01: холодный показ и отмена ожидания', (t) => {
  requestTooltip(a, 'A');
  t.mock.timers.tick(299);
  assert.equal(Boolean(currentTooltip()), false);
  t.mock.timers.tick(1);
  assert.equal(currentTooltip()?.target === a, true);
  resetTooltips();
  requestTooltip(a, 'A');
  releaseTooltip(a);
  t.mock.timers.tick(400);
  assert.equal(Boolean(currentTooltip()), false);
});

test('TIP-SVC-02: скрытие через 80 мс и отмена скрытия', (t) => {
  requestTooltip(a, 'A');
  t.mock.timers.tick(300);
  releaseTooltip(a);
  t.mock.timers.tick(79);
  assert.equal(currentTooltip()?.text, 'A');
  requestTooltip(a, 'A');
  t.mock.timers.tick(1);
  assert.equal(currentTooltip()?.text, 'A');
  releaseTooltip(a);
  t.mock.timers.tick(80);
  assert.equal(Boolean(currentTooltip()), false);
});

test('TIP-SVC-03: соседняя цель и недавнее скрытие тёплые', (t) => {
  requestTooltip(a, 'A');
  t.mock.timers.tick(300);
  releaseTooltip(a);
  requestTooltip(b, 'B');
  assert.equal(currentTooltip()?.target === b, true);
  releaseTooltip(b);
  t.mock.timers.tick(80);
  t.mock.timers.tick(200);
  requestTooltip(a, 'A');
  assert.equal(currentTooltip()?.target === a, true);
  releaseTooltip(a);
  t.mock.timers.tick(80);
  t.mock.timers.tick(400);
  requestTooltip(b, 'B');
  assert.equal(Boolean(currentTooltip()), false);
  t.mock.timers.tick(300);
  assert.equal(currentTooltip()?.target === b, true);
});

test('TIP-SVC-04: самая глубокая цель побеждает в обоих порядках', (t) => {
  a.append(b);

  for (const targets of [[a, b], [b, a]]) {
    resetTooltips();

    for (const target of targets) {
      requestTooltip(target, target === a ? 'A' : 'B');
    }

    t.mock.timers.tick(300);
    assert.equal(currentTooltip()?.target === b, true);
    releaseTooltip(b);
    assert.equal(currentTooltip()?.target === a, true);
  }
});

test('TIP-SVC-05: фокус и наведение независимы, повтор не задерживает показ', (t) => {
  requestTooltip(a, 'A');
  t.mock.timers.tick(200);
  requestTooltip(a, 'A');
  requestTooltip(a, 'A', 'top', 'focus');
  releaseTooltip(a);
  t.mock.timers.tick(100);
  assert.equal(currentTooltip()?.target === a, true);
});

test('TIP-SVC-06: обновление видимой и ожидающей справки, пустой текст', (t) => {
  const snapshots = [];
  const unsubscribe = subscribeTooltip((value) => snapshots.push(value?.text ?? null));

  t.after(unsubscribe);
  updateTooltip(b, 'Неактивная');
  assert.equal(Boolean(currentTooltip()), false);
  requestTooltip(a, 'A');
  t.mock.timers.tick(200);
  updateTooltip(a, 'Свежая', 'left');
  t.mock.timers.tick(100);
  assert.equal(currentTooltip()?.text, 'Свежая');
  assert.equal(currentTooltip()?.placement, 'left');
  updateTooltip(a, 'Новая', 'right');
  assert.equal(currentTooltip()?.text, 'Новая');
  assert.deepEqual(snapshots, [null, 'Свежая', 'Новая']);
  updateTooltip(a, '');
  assert.equal(Boolean(currentTooltip()), false);
});

test('TIP-SVC-07: забытая цель исчезает и возвращает внешнюю', (t) => {
  requestTooltip(a, 'A');
  t.mock.timers.tick(300);
  forgetTooltipTarget(a);
  assert.equal(Boolean(currentTooltip()), false);
  resetTooltips();
  requestTooltip(a, 'A');
  forgetTooltipTarget(a);
  t.mock.timers.tick(400);
  assert.equal(Boolean(currentTooltip()), false);
  a.append(b);
  requestTooltip(a, 'A');
  requestTooltip(b, 'B');
  t.mock.timers.tick(300);
  forgetTooltipTarget(b);
  assert.equal(currentTooltip()?.target === a, true);
});

test('TIP-SVC-08: скрытие, холодный сброс и отписка', (t) => {
  const texts = [];
  const unsubscribe = subscribeTooltip((value) => texts.push(value?.text ?? null));

  t.after(unsubscribe);
  assert.deepEqual(texts, [null]);
  requestTooltip(a, 'A');
  hideTooltip();
  t.mock.timers.tick(500);
  assert.equal(Boolean(currentTooltip()), false);
  requestTooltip(a, 'A');
  t.mock.timers.tick(300);
  assert.equal(currentTooltip()?.text, 'A');
  hideTooltip();
  requestTooltip(b, 'B');
  assert.equal(currentTooltip()?.text, 'B');
  unsubscribe();
  resetTooltips();
  requestTooltip(a, 'A');
  assert.equal(Boolean(currentTooltip()), false);
  t.mock.timers.tick(300);
  assert.equal(currentTooltip()?.text, 'A');
  assert.deepEqual(texts, [null, 'A', null, 'B']);
});
