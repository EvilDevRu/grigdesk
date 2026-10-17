import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createSettingsWindow } from '../../desktop/src/settingsWindowFactory.ts';

/**
 * Настоящая фабрика получает минимальные Electron-порты, сохраняя реальный controller.
 * Литеральные ожидания не вычисляются helpers геометрии или опций безопасности.
 */
function fixture({ shown = true, destroyed = false, authenticated = true, pinned, failLoad = false } = {}) {
  const calls = [];
  const session = {};
  const parent = {
    isDestroyed: () => destroyed,
    getBounds: () => ({ 
      x: 100, 
      y: 50, 
      width: 1280, 
      height: 860 
    }),
    focus: () => calls.push('focus-parent'),
  };
  const children = [];
  const controller = createSettingsWindow({
    parent,
    session,
    origin: 'http://127.0.0.1:8140',
    icon: '/fixture/icon.png',
    packaged: true,
    /**
     * Управляемое окно выдаёт события controller без запуска Electron.
     * UA и loadURL записываются отдельно для проверки порядка настройки.
     */
    createWindow(options) {
      const child = new EventEmitter();
      let closed = false;
      let ua = 'FixtureAgent';

      Object.assign(child, {
        options,
        isDestroyed: () => closed,
        isMinimized: () => false,
        show: () => calls.push('show'),
        focus: () => calls.push('focus'),
        restore: () => calls.push('restore'),
        removeMenu: () => calls.push('menu'),
        close() {
          closed = true;
          child.emit('closed');
        },
        webContents: {
          getUserAgent: () => ua,
          setUserAgent(value) {
            ua = value;
            calls.push('ua');
          },
        },
        async loadURL(url) {
          calls.push(['load', url, ua]);

          if (failLoad) {
            throw new Error('Отказ загрузки.');
          }
        },
      });
      children.push(child);

      return child;
    },
    workArea: () => ({ 
      x: 0, 
      y: 0, 
      width: 1920, 
      height: 1080 
    }),
    revealed: () => shown,
    sessionActive: async () => {
      calls.push('auth');

      return authenticated;
    },
    pinnedUrl: () => pinned,
    configureChild: (child) => calls.push(['configure', child]),
    installShortcut: (child) => calls.push(['shortcut', child]),
    showLoadError: () => calls.push('load-error'),
  });

  return { 
    controller, 
    calls, 
    children, 
    parent, 
    session 
  };
}

test('WF-01 session/геометрия/UA и configureChild устанавливаются до loadURL', async () => {
  const f = fixture();

  await f.controller.open();
  assert.equal(f.children.length, 1);

  const child = f.children[0];

  assert.equal(child.options.parent, f.parent);
  assert.equal(child.options.webPreferences.session, f.session);
  assert.equal(child.options.modal, true);
  assert.equal(child.options.icon, '/fixture/icon.png');
  assert.deepEqual({
    x: child.options.x,
    y: child.options.y,
    width: child.options.width,
    height: child.options.height,
    minWidth: child.options.minWidth,
    minHeight: child.options.minHeight,
  }, { 
    x: 180, 
    y: 70, 
    width: 1120, 
    height: 820, 
    minWidth: 800, 
    minHeight: 600 
  });

  const load = f.calls.findIndex((call) => Array.isArray(call) && call[0] === 'load');
  const configure = f.calls.findIndex((call) => Array.isArray(call) && call[0] === 'configure');

  assert.equal(f.calls[configure][1], child);
  assert.equal(configure < load, true);
  assert.equal(f.calls.indexOf('ua') < load, true);
  assert.deepEqual(f.calls[load], ['load', 'http://127.0.0.1:8140/?window=settings#/settings',
    'FixtureAgent CockpitSettings/1 CockpitWindow/settings']);
  assert.equal(f.calls.find((call) => Array.isArray(call) && call[0] === 'shortcut')[1], child);

  let prevented = 0;

  child.emit('page-title-updated', { preventDefault: () => {
    prevented += 1;
  } });
  assert.equal(prevented, 1);
});

test('WF-02 canOpen не создаёт окно, sessionActive имеет прежнее короткое замыкание', async () => {
  for (const [options, authCalls] of [
    [{ shown: false }, 0], [{ destroyed: true }, 0], [{ authenticated: false }, 1],
  ]) {
    const f = fixture(options);

    await f.controller.open();
    assert.equal(f.children.length, 0);
    assert.equal(f.calls.filter((call) => call === 'auth').length, authCalls);
  }
});

test('WF-03 закреплённый URL сохраняется в адресе настроек', async () => {
  const id = 'a'.repeat(64);
  const f = fixture({ pinned: `http://127.0.0.1:8140/ui/${id}/` });

  await f.controller.open();
  assert.equal(f.calls.find((call) => Array.isArray(call) && call[0] === 'load')[1],
    `http://127.0.0.1:8140/ui/${id}/?window=settings#/settings`);
});

test('WF-04 закрытие фокусирует живого родителя; отказ загрузки сообщает ошибку', async () => {
  const f = fixture();

  await f.controller.open();
  f.children[0].close();
  assert.equal(f.calls.filter((call) => call === 'focus-parent').length, 1);

  const dead = fixture();

  await dead.controller.open();
  dead.parent.isDestroyed = () => true;
  dead.children[0].close();
  assert.equal(dead.calls.includes('focus-parent'), false);

  const failed = fixture({ failLoad: true });

  await failed.controller.open();
  assert.equal(failed.calls.filter((call) => call === 'load-error').length, 1);
  assert.equal(failed.children[0].isDestroyed(), true);
});
