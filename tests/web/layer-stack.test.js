import assert from 'node:assert/strict';
import test from 'node:test';

import { Window } from '../../web/node_modules/happy-dom/lib/index.js';
import { compileModule, webFile } from './helpers/compile-vue.js';

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

const { activeLayerId, registerUiLayer, getUiLayerDiagnostics } = await compileModule(
  webFile('src/services/layers/stack.ts'),
);

function escape(target = document.body) {
  const event = new browser.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

test('один Escape закрывает только верхний слой, затем следующий', () => {
  const closed = [];
  const dock = registerUiLayer('dock-test', {
    name: 'dock',
    close: () => closed.push('dock'),
  });
  const task = registerUiLayer('task-test', {
    name: 'dialog',
    close: () => closed.push('task'),
  });
  assert.equal(activeLayerId(), 'task-test');

  assert.equal(escape().defaultPrevented, true);
  assert.deepEqual(closed, ['task']);
  task.unregister();
  assert.equal(activeLayerId(), 'dock-test');

  escape();
  assert.deepEqual(closed, ['task', 'dock']);
  dock.unregister();
});

test('последний слой равного приоритета побеждает, disabled пропускается', () => {
  const closed = [];
  const first = registerUiLayer('a-test', {
    name: 'tools',
    close: () => closed.push('a'),
  });
  const disabled = registerUiLayer('disabled-test', {
    name: 'confirm',
    enabled: () => false,
    close: () => closed.push('disabled'),
  });
  const second = registerUiLayer('b-test', {
    name: 'tools',
    close: () => closed.push('b'),
  });
  escape();
  assert.deepEqual(closed, ['b']);
  second.unregister();
  disabled.unregister();
  first.unregister();
});

test('xterm и Monaco владеют Escape внутри своих областей', () => {
  document.body.innerHTML = '<div data-escape-owner="terminal"><textarea id="term"></textarea></div>';
  let closed = 0;
  const layer = registerUiLayer('dock-owner-test', {
    name: 'dock',
    close: () => { closed += 1; },
  });
  const event = escape(document.querySelector('#term'));
  assert.equal(event.defaultPrevented, false);
  assert.equal(closed, 0);
  layer.unregister();
});

test('TIP-LAYER-01: справка сохраняет верхний диалог и меню, получает Escape первой', (t) => {
  for (const name of ['dialog', 'popover']) {
    const closed = [];
    const layer = registerUiLayer(`tip-${name}`, { name, close: () => closed.push(name) });
    const tip = registerUiLayer('tip', { name: 'tooltip', close: () => closed.push('tooltip') });

    t.after(() => layer.unregister());
    t.after(() => tip.unregister());
    assert.equal(layer.isTop(), true);
    escape();
    assert.deepEqual(closed, ['tooltip']);
    tip.unregister();
    layer.unregister();
  }
});

test('TIP-LAYER-02: журнал окна не получает наведения', (t) => {
  const dialog = registerUiLayer('diagnostic-dialog', { name: 'dialog', close: () => true });
  const tip = registerUiLayer('diagnostic-tip', { name: 'tooltip', close: () => true });

  t.after(() => dialog.unregister());
  t.after(() => tip.unregister());
  assert.deepEqual(getUiLayerDiagnostics().map((layer) => layer.kind), ['dialog']);
});
