import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { BrowserWindow, WebContentsView, WebContentsViewConstructorOptions } from 'electron';

import { createBrowserInputGuard } from '../../desktop/src/browser/browserInputGuard.ts';

/**
 * Двойник хранит native-слои в порядке наложения и отдельно моделирует фокус.
 * Проверка не запускает Electron и не подменяет продуктовую политику блокировки.
 */
function fixture() {
  const events = new EventEmitter();
  const creations: WebContentsViewConstructorOptions[] = [];
  const layers: unknown[] = [];
  let focus = 'guest';
  let visible = false;
  let closed = 0;
  const shield = {
    setBounds: () => {},
    setVisible: (value: boolean) => {
      visible = value;
    },
    setBackgroundColor: (color: string) => assert.equal(color, '#00000000'),
    webContents: Object.assign(events, {
      setWindowOpenHandler: () => {},
      loadURL: async (url: string) => assert.equal(url, 'about:blank'),
      isFocused: () => focus === 'shield',
      isDestroyed: () => closed > 0,
      close: () => {
        closed += 1;
      },
    }),
  } as unknown as WebContentsView;
  const window = {
    isDestroyed: () => false,
    isFocused: () => focus !== 'outside',
    webContents: {
      isFocused: () => focus === 'main',
      focus: () => {
        focus = 'main';
      },
    },
    contentView: {
      addChildView: (view: unknown) => {
        const index = layers.indexOf(view);

        if (index >= 0) {
          layers.splice(index, 1);
        }

        layers.push(view);
      },
      removeChildView: (view: unknown) => layers.splice(layers.indexOf(view), 1),
    },
  } as unknown as BrowserWindow;
  const guard = createBrowserInputGuard({
    create: (options) => {
      creations.push(options);

      return shield;
    },
    window: () => window,
  });

  return {
    guard,
    events,
    creations,
    layers,
    shield,
    visible: () => visible,
    closed: () => closed,
    focused: () => focus,
    focus: (value: string) => {
      focus = value;
    },
  };
}

test('BR-G01: один прозрачный shield остаётся выше guest и блокирует физический ввод', async (t) => {
  const f = fixture();
  const rect = {
    x: 0,
    y: 30,
    width: 800,
    height: 600
  };

  t.after(() => f.guard.dispose());
  await f.guard.ready();
  f.guard.show(rect);
  assert.equal(f.visible(), true);
  assert.equal(f.focused(), 'main');
  assert.equal(f.creations[0]!.webPreferences!.sandbox, true);
  assert.equal(f.creations[0]!.webPreferences!.preload, undefined);
  f.layers.push('guest');
  f.guard.show(rect);
  assert.equal(f.layers.at(-1), f.shield);
  assert.equal(f.creations.length, 1);

  for (const name of ['before-input-event', 'before-mouse-event', 'context-menu', 'will-navigate']) {
    let prevented = false;

    f.events.emit(name, { preventDefault: () => {
      prevented = true;
    } });
    assert.equal(prevented, true, name);
  }

  f.guard.hide();
  assert.equal(f.visible(), false);
  assert.deepEqual(f.layers, ['guest']);
  f.guard.dispose();
  f.guard.dispose();
  assert.equal(f.closed(), 1);
});

test('BR-G02: блокировка не активирует другое приложение и освобождает фокус shield', (t) => {
  const f = fixture();
  const rect = {
    x: 0,
    y: 0,
    width: 800,
    height: 600
  };

  t.after(() => f.guard.dispose());
  f.focus('outside');
  f.guard.show(rect);
  assert.equal(f.focused(), 'outside');
  f.focus('shield');
  f.guard.hide();
  assert.equal(f.focused(), 'main');
});
