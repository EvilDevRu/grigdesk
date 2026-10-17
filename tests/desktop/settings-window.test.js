import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';

import {
  settingsWindowGeometry,
  createSettingsWindowController,
} from '../../desktop/src/settingsWindowController.ts';

const parent = {
  x: 100,
  y: 50,
  width: 1280,
  height: 860
};
const area = {
  x: 0,
  y: 0,
  width: 1920,
  height: 1080
};

/**
 * Окно показывает только события, явно испущенные тестом.
 * Счётчики отделяют фокус живого окна от повторного создания и загрузки.
 */
function fixture(overrides = {}) {
  const windows = [];
  const calls = {
    auth: 0,
    load: 0,
    closed: 0,
    failed: 0
  };
  const controller = createSettingsWindowController({
    async canOpen() {
      calls.auth += 1;

      return true;
    },
    /**
     * Создаёт управляемое событиями окно без Electron.
     * Тест вручную определяет готовность, закрытие и состояние фокуса.
     */
    create() {
      const window = new EventEmitter();

      Object.assign(window, {
        destroyed: false,
        minimized: false,
        shown: 0,
        focused: 0,
        restored: 0,
        isDestroyed: () => window.destroyed,
        isMinimized: () => window.minimized,
        restore() {
          window.restored += 1;
          window.minimized = false;
        },
        show() {
          window.shown += 1;
        },
        focus() {
          window.focused += 1;
        },
        close() {
          window.destroyed = true;
          window.emit('closed');
        },
      });
      windows.push(window);

      return window;
    },
    async load() {
      calls.load += 1;
    },
    onClosed() {
      calls.closed += 1;
    },
    onLoadFailed() {
      calls.failed += 1;
    },
    ...overrides,
  });

  return {
    controller,
    windows,
    calls
  };
}

test('SW-W01 геометрия по центру главного', () => {
  assert.deepEqual(settingsWindowGeometry(parent, area), {
    x: 180,
    y: 70,
    width: 1120,
    height: 820,
    minWidth: 800,
    minHeight: 600,
  });
});

test('SW-W02 геометрия в тесной области', () => {
  for (const [width, height] of [[1024, 700], [640, 480]]) {
    const result = settingsWindowGeometry(parent, {
      ...area,
      width,
      height
    });

    assert.equal(result.width, width);
    assert.equal(result.height, height);
    assert.equal(result.minWidth, Math.min(800, width));
    assert.equal(result.minHeight, Math.min(600, height));
    assert.equal(result.x >= 0 && result.x + width <= width, true);
  }

  const second = settingsWindowGeometry({ ...parent, x: 3500 }, { ...area, x: 1920 });

  assert.equal(second.x >= 1920 && second.x + second.width <= 3840, true);
});

test('SW-W03 одно окно на параллельные запросы', async () => {
  const auth = Promise.withResolvers();
  const load = Promise.withResolvers();
  let authCalls = 0;
  const f = fixture({
    canOpen() {
      authCalls += 1;

      return auth.promise;
    },
    load: () => load.promise,
  });
  const first = f.controller.open();
  const second = f.controller.open();

  assert.equal(first === second, true);
  assert.equal(authCalls, 1);
  auth.resolve(true);
  await new Promise((resolve) => setImmediate(resolve));
  await f.controller.open();
  assert.equal(f.windows.length, 1);
  assert.equal(f.windows[0].shown, 0);
  f.windows[0].emit('ready-to-show');
  assert.equal(f.windows[0].shown, 1);
  assert.equal(f.windows[0].focused, 1);
  load.resolve();
  await first;
});

test('SW-W04 повтор при открытом окне', async () => {
  const f = fixture();

  await f.controller.open();
  assert.equal(f.windows.length, 1);
  f.windows[0].emit('ready-to-show');
  f.windows[0].minimized = true;
  await f.controller.open();
  assert.equal(f.windows[0].restored, 1);
  assert.equal(f.windows[0].shown, 2);
  assert.equal(f.calls.load, 1);
  assert.equal(f.controller.focusOpen(), true);
  assert.equal(f.controller.isOpen(), true);
});

test('SW-W05 нет входа — нет окна', async () => {
  for (const failure of [false, new Error('отказ')]) {
    let allow = false;
    const f = fixture({
      /**
       * Первый запрос воспроизводит отказ проверки входа.
       * Следующий проверяет возможность открыть окно после отказа.
       */
      async canOpen() {
        if (allow) {
          return true;
        }

        if (failure instanceof Error) {
          throw failure;
        }

        return failure;
      },
    });

    await f.controller.open();
    assert.equal(f.windows.length, 0);
    allow = true;
    await f.controller.open();
    assert.equal(f.windows.length, 1);
  }
});

test('SW-W06 закрытие освобождает', async () => {
  const f = fixture();

  await f.controller.open();
  assert.equal(f.windows.length, 1);
  f.windows[0].close();
  f.windows[0].emit('closed');
  assert.equal(f.calls.closed, 1);
  assert.equal(f.controller.isOpen(), false);
  await f.controller.open();
  f.windows[0].emit('ready-to-show');
  assert.equal(f.windows[0].shown, 0);
  assert.equal(f.windows.length, 2);
});

test('SW-W07 отказ загрузки', async () => {
  const f = fixture({
    async load() {
      throw new Error('загрузка');
    },
  });

  await f.controller.open();
  assert.equal(f.calls.failed, 1);
  assert.equal(f.windows[0]?.destroyed, true);
  assert.equal(f.controller.isOpen(), false);
  await f.controller.open();
  assert.equal(f.windows.length, 2);
});

test('SW-W08 поздний отказ старой загрузки', async () => {
  const old = Promise.withResolvers();
  let loads = 0;
  const f = fixture({
    load() {
      loads += 1;

      return loads === 1 ? old.promise : Promise.resolve();
    },
  });
  const pending = f.controller.open();

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.windows.length, 1);
  f.windows[0].close();
  await f.controller.open();
  old.reject(new Error('поздний отказ'));
  await pending;
  assert.equal(f.windows.length, 2);
  assert.equal(f.windows[1].destroyed, false);
  assert.equal(f.calls.failed, 0);
});

test('SW-W09 create вернул null', async () => {
  let creates = 0;
  const f = fixture({
    /**
     * Создаёт управляемое событиями окно без Electron.
     * Тест вручную определяет готовность, закрытие и состояние фокуса.
     */
    create() {
      creates += 1;

      return null;
    },
  });

  await f.controller.open();
  await f.controller.open();
  assert.equal(creates, 2);
  assert.equal(f.calls.load, 0);
});
