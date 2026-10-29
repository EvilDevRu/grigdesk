import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';

import { createWindowControls } from '../../desktop/src/windowControls.ts';

/**
 * Окно не уничтожается двойником: close остаётся запросом со штатной защитой страницы.
 * Смена документа и владельца управляется отдельно, чтобы проверить отложенный выход.
 */
function fixture() {
  const calls = [];
  const state = {
    origin: 'http://127.0.0.1:47101',
    url: 'http://127.0.0.1:47101/#/chats',
    maximized: false,
    destroyed: false,
    stopping: false,
  };
  const window = {
    isDestroyed: () => state.destroyed,
    isMaximized: () => state.maximized,
    webContents: {
      isDestroyed: () => state.destroyed,
      getURL: () => state.url,
    },
    minimize() {
      calls.push('minimize');
    },
    maximize() {
      state.maximized = true;
      calls.push('maximize');
    },
    unmaximize() {
      state.maximized = false;
      calls.push('unmaximize');
    },
    close() {
      calls.push('close');
    },
  };
  let current = window;
  const controls = createWindowControls({
    getWindow: () => current,
    origin: () => state.origin,
    stopping: () => state.stopping,
  });

  return {
    controls,
    state,
    calls,
    detach() {
      current = null;
    },
  };
}

test('кнопки меняют главное окно, состояние и подписки без выбранной машины', async () => {
  const f = fixture();
  let notifications = 0;
  const unsubscribe = f.controls.subscribe(() => {
    notifications += 1;
  });

  assert.deepEqual(f.controls.state(), { maximized: false });
  assert.equal(f.controls.control(f.state.origin, 'minimize'), true);
  assert.equal(f.controls.control(f.state.origin, 'toggle-maximize'), true);
  f.controls.changed();
  assert.deepEqual(f.controls.state(), { maximized: true });
  assert.equal(f.controls.control(f.state.origin, 'toggle-maximize'), true);
  assert.deepEqual(f.controls.state(), { maximized: false });
  assert.deepEqual(f.calls, ['minimize', 'maximize', 'unmaximize']);
  assert.equal(notifications, 1);
  unsubscribe();
  f.controls.changed();
  assert.equal(notifications, 1);

  assert.equal(f.controls.control(f.state.origin, 'close'), true);
  assert.equal(f.calls.includes('close'), false);
  await setImmediate();
  assert.equal(f.calls.at(-1), 'close');
});

test('чужой origin, документ, уничтоженное окно и завершение не получают управление', () => {
  const f = fixture();

  assert.equal(f.controls.control('http://127.0.0.1:47102', 'close'), false);

  for (const url of ['https://example.org/', `${f.state.origin}/shots/file.png`]) {
    f.state.url = url;
    assert.equal(f.controls.control(f.state.origin, 'minimize'), false);
  }

  f.state.url = f.state.origin + '/';
  f.state.destroyed = true;
  assert.equal(f.controls.control(f.state.origin, 'minimize'), false);
  f.state.destroyed = false;
  f.state.stopping = true;
  assert.equal(f.controls.control(f.state.origin, 'toggle-maximize'), false);
  assert.deepEqual(f.calls, []);
});

test('отложенный выход не закрывает окно после смены владельца или origin', async () => {
  for (const change of ['detach', 'origin', 'stopping']) {
    const f = fixture();

    assert.equal(f.controls.control(f.state.origin, 'close'), true);

    if (change === 'detach') {
      f.detach();
    } else if (change === 'origin') {
      f.state.origin = 'http://127.0.0.1:47102';
    } else {
      f.state.stopping = true;
    }

    await setImmediate();
    assert.deepEqual(f.calls, []);
  }
});
