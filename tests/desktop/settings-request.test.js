import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  createSettingsRequest, OPEN_SETTINGS_SCRIPT, OPEN_HELP_SCRIPT,
} from '../../desktop/src/settingsRequest.ts';
import { applicationMenuTemplate } from '../../desktop/src/menu.ts';

const origin = 'http://127.0.0.1:8140';

/**
 * Фейковые события не требуют Electron и настоящей загрузки.
 * Любая попытка создать окно или загрузить URL провалит тест немедленно.
 */
function fixture(event = 'grigdesk:open-settings') {
  const calls = [];
  const state = {
    shown: true,
    dead: false,
    crashed: false,
    loading: false,
    detached: false,
    frameDead: false,
    url: origin + '/#/chats',
    result: Promise.resolve(),
  };
  const frame = {
    get url() { return state.url; },
    get detached() { return state.detached; },
    isDestroyed: () => state.frameDead,
    executeJavaScript(script) {
      calls.push(script);

      return state.result;
    },
  };
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: () => state.dead,
    isCrashed: () => state.crashed,
    isLoadingMainFrame: () => state.loading,
    mainFrame: frame,
  });
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => state.dead,
    webContents: contents,
  });
  const request = createSettingsRequest({
    origin,
    getWindow: () => window,
    revealed: () => state.shown,
  }, event);

  return {
    state,
    calls,
    contents,
    window,
    request,
  };
}

test('EL02/03 меню доставляет фиксированное событие без загрузки и второго окна', () => {
  const f = fixture();
  const template = applicationMenuTemplate({ openSettings: f.request.open });

  template[0].submenu[0].click();
  f.request.open();
  assert.deepEqual(f.calls, [OPEN_SETTINGS_SCRIPT, OPEN_SETTINGS_SCRIPT]);
  assert.match(OPEN_SETTINGS_SCRIPT, /grigdesk:open-settings/);
  assert.match(OPEN_SETTINGS_SCRIPT, /void 0;?$/);
  assert.doesNotMatch(readFileSync(new URL('../../desktop/src/settingsRequest.ts', import.meta.url), 'utf8'),
    /loadURL|new BrowserWindow|webContents\.executeJavaScript/);
});

test('EL04 только показанное живое окно и свой главный UI frame', async () => {
  for (const change of [
    { shown: false }, { dead: true }, { crashed: true }, { detached: true }, { frameDead: true },
    { url: 'data:text/html,offline' }, { url: 'http://example.org/' },
    { url: origin + '/vscode/' }, { url: origin + '/ui/invalid/' },
  ]) {
    const f = fixture();

    Object.assign(f.state, change);
    f.request.open();
    assert.equal(f.calls.length, 0, JSON.stringify(change));
  }

  const f = fixture();

  f.state.result = Promise.reject(new Error('Отказ renderer'));
  assert.doesNotThrow(() => f.request.open());
  await Promise.resolve();
  f.state.result = new Promise(() => {});
  f.request.open();
  f.request.open();
  assert.equal(f.calls.length, 3, 'Отправленные запросы не ждут старого Promise');
});

test('EL05 пачка при загрузке склеивается; finished/stop повторно проверяют frame', () => {
  for (const event of ['did-finish-load', 'did-stop-loading']) {
    const f = fixture();

    f.state.loading = true;
    f.request.open();
    f.request.open();
    assert.equal(f.calls.length, 0);
    f.contents.emit(event);
    assert.equal(f.calls.length, 0);
    f.state.loading = false;
    f.contents.emit(event);
    assert.equal(f.calls.length, 1);
    f.contents.emit(event);
    assert.equal(f.calls.length, 1);
    assert.equal(f.contents.listenerCount('did-finish-load'), 0);
  }
});

test('EL05 закрытие, уход на чужой документ и dispose очищают pending и listeners', () => {
  for (const cancel of ['closed', 'dispose', 'data:', 'external']) {
    const f = fixture();

    f.state.loading = true;
    f.request.open();

    if (cancel === 'closed') {
      f.window.emit('closed');
    } else if (cancel === 'dispose') {
      f.request.dispose();
    } else {
      const url = cancel === 'data:' ? 'data:text/html,offline' : 'https://example.org/';

      f.contents.emit('did-start-navigation', { url, isMainFrame: true });
    }

    f.state.loading = false;
    f.contents.emit('did-finish-load');
    assert.equal(f.calls.length, 0, cancel);
    assert.equal(f.contents.listenerCount('did-stop-loading'), 0);
    assert.equal(f.window.listenerCount('closed'), 0);
  }
});

test('EL05 исчезнувшее окно и синхронный отказ frame не выходят наружу', () => {
  const missing = createSettingsRequest({
    origin,
    getWindow: () => null,
    revealed: () => true,
  });
  const f = fixture();

  assert.doesNotThrow(missing.open);
  f.contents.mainFrame.executeJavaScript = () => {
    throw new Error('Frame уже уничтожен');
  };
  assert.doesNotThrow(f.request.open);
});

test('HELP-N3: фиксированное native help событие сохраняет проверку frame и dispose', () => {
  const f = fixture('grigdesk:open-help');

  f.request.open();
  assert.deepEqual(f.calls, [OPEN_HELP_SCRIPT]);
  f.state.url = 'https://example.org/';
  f.request.open();
  assert.equal(f.calls.length, 1);
  f.state.url = origin + '/#/chats';
  f.state.loading = true;
  f.request.open();
  f.request.dispose();
  f.state.loading = false;
  f.contents.emit('did-finish-load');
  assert.equal(f.calls.length, 1);
});
