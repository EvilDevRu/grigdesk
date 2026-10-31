import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { attachBrowserIpc } from '../../desktop/src/browser/browserIpc.ts';

import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';

/**
 * Fake IPC сохраняет настоящие handlers и вызывает их с независимыми sender/frame.
 * Same-origin URL намеренно одинаков, чтобы тест не прошёл по проверке другого origin.
 */
function fixture() {
  const emitter = new EventEmitter();
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const frame = { url: 'http://pipe.test/', isDestroyed: () => false };
  const contents = { mainFrame: frame };
  const window = { isDestroyed: () => false, webContents: contents } as unknown as BrowserWindow;
  const ipc = Object.assign(emitter, {
    handle: (channel: string, callback: (...args: unknown[]) => unknown) => handlers.set(channel, callback),
    removeHandler: (channel: string) => handlers.delete(channel),
  }) as unknown as IpcMain;
  let epoch = 2;
  let hidden = 0;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const remove = attachBrowserIpc({
    ipc,
    window: () => window,
    origin: () => 'http://pipe.test',
    epoch: () => epoch,
    execute: async (_request, valid) => {
      await gate;

      return valid();
    },
    hide: () => {
      hidden += 1;
    },
  });
  const invoke = (event: unknown, documentEpoch = epoch) => Promise.resolve().then(() =>
    handlers.get('grigdesk:browser')!(event, { epoch: documentEpoch, request: { operation: 'state' } }));

  return {
    invoke,
    release,
    remove,
    event: () => ({ sender: contents, senderFrame: frame }) as unknown as IpcMainInvokeEvent,
    surface: () => ({ sender: { mainFrame: frame }, senderFrame: frame }),
    iframe: () => ({ sender: contents, senderFrame: { url: 'http://pipe.test/', isDestroyed: () => false } }),
    change: () => {
      epoch += 1;
    },
    hide: (event: unknown, documentEpoch = epoch) => {
      const target = Object.assign(event as object, { returnValue: null as unknown });

      emitter.emit('grigdesk:browser:hide', target,
        { epoch: documentEpoch, request: {
          operation: 'hide',
          instance: 'fixture',
          revision: 1
        } });

      return target.returnValue;
    },
    hidden: () => hidden,
  };
}

test('BR-I01: main разрешён, same-origin surface/subframe/stale epoch запрещены', async () => {
  const f = fixture();

  f.release();
  assert.equal(await f.invoke(f.event()), true);
  await assert.rejects(() => f.invoke(f.surface()), /browser_sender_forbidden/u);
  await assert.rejects(() => f.invoke(f.iframe()), /browser_sender_forbidden/u);
  await assert.rejects(() => f.invoke(f.event(), 1), /browser_sender_forbidden/u);
  f.remove();
});

test('BR-I02: document epoch после await снимает прежний valid callback', async () => {
  const f = fixture();
  const pending = f.invoke(f.event());

  await Promise.resolve();
  f.change();
  f.release();
  assert.equal(await pending, false);
  f.remove();
});

test('BR-I03: synchronous hide завершён до возврата, surface не вызывает hide', () => {
  const f = fixture();

  assert.deepEqual(f.hide(f.event()), { ok: true });
  assert.equal(f.hidden(), 1);
  assert.deepEqual(f.hide(f.surface()), { ok: false, error: 'browser_sender_forbidden' });
  assert.equal(f.hidden(), 1);
  f.remove();
  f.release();
});
