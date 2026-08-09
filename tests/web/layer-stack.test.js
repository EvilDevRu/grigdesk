import assert from 'node:assert/strict';
import test from 'node:test';

import { Window } from '../../web/node_modules/happy-dom/lib/index.js';

const browser = new Window({ url: 'http://cockpit.test/' });
for (const [key, value] of Object.entries({
  window: browser,
  document: browser.document,
  Element: browser.Element,
  HTMLElement: browser.HTMLElement,
  Event: browser.Event,
  KeyboardEvent: browser.KeyboardEvent,
})) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

const { activeLayerId, registerLayer } = await import('../../web/src/shared/ui/layer-stack.js');

function escape(target = document.body) {
  const event = new browser.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

test('один Escape закрывает только верхний слой, затем следующий', () => {
  const closed = [];
  const offDock = registerLayer('dock-test', { priority: 80, close: () => closed.push('dock') });
  const offTask = registerLayer('task-test', { priority: 100, close: () => closed.push('task') });
  assert.equal(activeLayerId(), 'task-test');

  assert.equal(escape().defaultPrevented, true);
  assert.deepEqual(closed, ['task']);
  offTask();
  assert.equal(activeLayerId(), 'dock-test');

  escape();
  assert.deepEqual(closed, ['task', 'dock']);
  offDock();
});

test('последний слой равного приоритета побеждает, disabled пропускается', () => {
  const closed = [];
  const offA = registerLayer('a-test', { priority: 50, close: () => closed.push('a') });
  const offDisabled = registerLayer('disabled-test', {
    priority: 500,
    enabled: () => false,
    close: () => closed.push('disabled'),
  });
  const offB = registerLayer('b-test', { priority: 50, close: () => closed.push('b') });
  escape();
  assert.deepEqual(closed, ['b']);
  offB(); offDisabled(); offA();
});

test('xterm и Monaco владеют Escape внутри своих областей', () => {
  document.body.innerHTML = '<div data-escape-owner="terminal"><textarea id="term"></textarea></div>';
  let closed = 0;
  const off = registerLayer('dock-owner-test', { priority: 80, close: () => { closed += 1; } });
  const event = escape(document.querySelector('#term'));
  assert.equal(event.defaultPrevented, false);
  assert.equal(closed, 0);
  off();
});
