import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

import { Window } from '../../web/node_modules/happy-dom/lib/index.js';

import { createBrowserDriver } from '../../desktop/src/browser/browserDriver.ts';
import { createBrowserProtocol } from '../../desktop/src/browser/browserProtocol.ts';
import { DOM_ACT_SOURCE } from '../../desktop/src/browser/pageSnapshot.ts';

const unexpectedDomInput = async () => assert.fail('native-сценарий не должен вызывать DOM-ввод');

test('BR12-D: клик в скрытой вкладке активирует SVG-узел графа', async (t) => {
  const window = new Window();

  t.after(() => window.happyDOM.close());

  const svg = window.document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const gate = window.document.createElementNS('http://www.w3.org/2000/svg', 'g');
  const targets: unknown[] = [];

  gate.setAttribute('role', 'button');
  svg.appendChild(gate);
  window.document.body.appendChild(svg);
  svg.addEventListener('click', (event) => {
    targets.push(event.target);
  });

  assert.equal('click' in gate, false);

  const act = runInNewContext(`(${DOM_ACT_SOURCE})`, {
    __grigdeskBrowserNodes: new Map([['e1', gate]]),
    MouseEvent: window.MouseEvent,
  });

  const outcome = act({ action: 'click', ref: 'e1' });

  assert.equal(outcome.ok, true);
  assert.equal(targets.length, 1);
  assert.equal(targets[0] === gate, true);
});

test('BR12-E: исключение DOM-клика возвращает ошибку команды', async () => {
  const replies = [
    { frameTree: { frame: { id: 'frame' } } },
    { executionContextId: 1 },
    { result: { objectId: 'world' } },
    { result: { value: { elements: [] } } },
    { exceptionDetails: { text: 'Uncaught' } },
  ];
  const protocol = createBrowserProtocol({
    allowed: () => true,
    epoch: () => 4,
    send: async (method) => {
      const reply = replies.shift();

      assert.ok(reply, method);

      return reply;
    },
  });
  const driver = createBrowserDriver({
    act: protocol.act,
    allowed: () => true,
    epoch: () => 4,
    resolve: async () => null,
    send: async () => assert.fail('DOM-клик выполняется без системного ввода'),
  });

  await protocol.snapshot();
  await assert.rejects(() => driver.domInput({
    action: 'click',
    ref: 'e1',
    pageEpoch: 4,
  }), /stale_page/u);
});

test('BR12: stale refs и отзыв не отправляют click; fill получает text как данные', async () => {
  const calls: unknown[] = [];
  let valid = true;
  const driver = createBrowserDriver({
    act: unexpectedDomInput,
    allowed: () => valid,
    epoch: () => 4,
    resolve: async (ref: string) => ref === 'e1' ? {
      x: 20,
      y: 30,
      editable: true
    } : null,
    send: async (name: string, value: unknown) => {
      calls.push([name, value]);
    },
  });

  await assert.rejects(() => driver.input({
    action: 'click',
    ref: 'e1',
    pageEpoch: 3
  }), /stale_page/u);
  assert.equal(calls.length, 0);
  await driver.input({
    action: 'fill',
    ref: 'e1',
    pageEpoch: 4,
    text: 'hello'
  });
  assert.ok(calls.some((call) => JSON.stringify(call)
    === '["Input.insertText",{"text":"hello"}]'));

  const before = calls.length;

  valid = false;
  await assert.rejects(() => driver.input({
    action: 'click',
    ref: 'e1',
    pageEpoch: 4
  }), /access_revoked/u);
  assert.equal(calls.length, before);
});

test('BR12-B: revoke между press/release запрещает следующий эффект', async () => {
  const calls: string[] = [];
  let allowed = true;
  const driver = createBrowserDriver({
    act: unexpectedDomInput,
    allowed: () => allowed,
    epoch: () => 1,
    resolve: async () => ({
      x: 1,
      y: 1,
      editable: true
    }),
    send: async (name, value) => {
      calls.push(name);

      if ((value as { type?: string }).type === 'mousePressed') {
        allowed = false;
      }
    },
  });

  await assert.rejects(() => driver.input({
    action: 'click',
    pageEpoch: 1,
    ref: 'e1'
  }), /access_revoked/u);
  assert.deepEqual(calls, ['Input.dispatchMouseEvent']);
});

test('BR12-C: navigation during resolve и noneditable target не вводят текст', async () => {
  let epoch = 1;
  let calls = 0;
  const driver = createBrowserDriver({
    act: unexpectedDomInput,
    allowed: () => true,
    epoch: () => epoch,
    resolve: async () => {
      epoch += 1;

      return {
        x: 1,
        y: 1,
        editable: true
      };
    },
    send: async () => {
      calls += 1;
    },
  });

  await assert.rejects(() => driver.input({
    action: 'click',
    pageEpoch: 1,
    ref: 'e1'
  }), /stale_page/u);

  const readonly = createBrowserDriver({
    act: unexpectedDomInput,
    allowed: () => true,
    epoch: () => epoch,
    resolve: async () => ({
      x: 1,
      y: 1,
      editable: false
    }),
    send: async () => {
      calls += 1;
    },
  });

  await assert.rejects(() => readonly.input({
    action: 'fill',
    pageEpoch: epoch,
    ref: 'e1',
    text: 'x'
  }),
    /invalid_fill/u);
  assert.equal(calls, 0);
});
