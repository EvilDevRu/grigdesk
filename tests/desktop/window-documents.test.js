import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import test from 'node:test';
import { loadDocument, loadPinnedDocument } from '../../desktop/src/windowDocuments.ts';
import { PermanentConnectionError } from '../../desktop/src/connectionLifecycle.ts';

/**
 * WebContents выдаёт события вручную; каждый исход обязан снять все свои listeners.
 * Исход loadURL управляется отдельно от abort, как обещание настоящего Electron.
 */
function fixture(t, current = 'http://127.0.0.1:8140/#/chats') {
  const contents = new EventEmitter();
  const controller = new AbortController();
  const calls = [];
  let destroyed = false;
  let loading = Promise.resolve();

  Object.assign(contents, {
    getURL: () => current,
    reload: () => calls.push('reload'),
    stop: () => calls.push('stop'),
  });

  const window = {
    webContents: contents,
    isDestroyed: () => destroyed,
    loadURL(url) {
      calls.push(['load', url]);

      return loading;
    },
  };

  t.after(() => {
    for (const event of ['did-finish-load', 'did-fail-load', 'destroyed']) {
      assert.equal(contents.listenerCount(event), 0, event);
    }

    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });

  return {
    window,
    contents,
    controller,
    calls,
    setDestroyed: () => {
      destroyed = true;
    },
    setLoading: (promise) => {
      loading = promise;
    },
  };
}

test('WD-01 точное равенство URL, с hash и без, вызывает reload нового документа', async (t) => {
  for (const url of ['http://127.0.0.1:8140/', 'http://127.0.0.1:8140/#/chats']) {
    const f = fixture(t, url);
    const work = loadDocument(f.window, url, f.controller.signal);

    assert.deepEqual(f.calls, ['reload']);
    f.contents.emit('did-finish-load');
    await work;
  }
});

test('WD-02 другой hash и новый адрес идут через loadURL', async (t) => {
  for (const url of ['http://127.0.0.1:8140/#/tasks', 'http://127.0.0.1:8140/second']) {
    const f = fixture(t);

    await loadDocument(f.window, url, f.controller.signal);
    assert.deepEqual(f.calls, [['load', url]]);
  }
});

test('WD-03 main-frame did-fail-load возвращает message и code, подфрейм продолжает ждать', async (t) => {
  for (const main of [true, false]) {
    const f = fixture(t);
    const work = loadDocument(f.window, 'http://127.0.0.1:8140/#/chats', f.controller.signal);

    f.contents.emit('did-fail-load', {}, -105, 'Имя не найдено.', 'url', main);

    if (main) {
      await assert.rejects(work, { message: 'Имя не найдено.', code: -105 });
    } else {
      let finished = false;

      void work.then(() => {
        finished = true;
      });
      await Promise.resolve();
      assert.equal(finished, false);
      f.contents.emit('did-finish-load');
      await work;
    }
  }
});

test('WD-04 destroyed и abort reload отклоняются ERR_ABORTED, stop только при abort', async (t) => {
  for (const event of ['destroyed', 'abort']) {
    const f = fixture(t);
    const work = loadDocument(f.window, 'http://127.0.0.1:8140/#/chats', f.controller.signal);

    if (event === 'abort') {
      f.controller.abort();
      f.controller.abort();
    } else {
      f.setDestroyed();
      f.contents.emit('destroyed');
    }

    await assert.rejects(work, { code: 'ERR_ABORTED', message: 'Загрузка документа отменена.' });
    assert.deepEqual(f.calls, event === 'abort' ? ['reload', 'stop'] : ['reload']);
  }
});

test('WD-05 отменённый сигнал или уничтоженное окно не начинают загрузку', async (t) => {
  for (const cancelled of [true, false]) {
    const f = fixture(t);

    if (cancelled) {
      f.controller.abort();
    } else {
      f.setDestroyed();
    }

    await loadDocument(f.window, 'http://127.0.0.1:8140/#/chats', f.controller.signal);
    assert.deepEqual(f.calls, []);
  }
});

test('WD-06 loadURL сохраняет собственный исход; abort останавливает только живое окно', async (t) => {
  for (const destroyed of [true, false]) {
    for (const failed of [true, false]) {
      const f = fixture(t);
      const response = Promise.withResolvers();
      const failure = new Error('Отказ loadURL.');

      f.setLoading(response.promise);

      const work = loadDocument(f.window, 'http://127.0.0.1:8140/#/tasks', f.controller.signal);

      if (destroyed) {
        f.setDestroyed();
      }

      f.controller.abort();

      if (failed) {
        response.reject(failure);
        await assert.rejects(work, (error) => error === failure);
      } else {
        response.resolve();
        await work;
      }

      assert.deepEqual(f.calls, [
        ['load', 'http://127.0.0.1:8140/#/tasks'], ...(!destroyed ? ['stop'] : []),
      ]);
    }
  }
});

test('WD-07 закреплённый release проверяется и сохраняет hash адреса', async (t) => {
  const f = fixture(t, '');
  const id = 'a'.repeat(64);
  const url = `http://127.0.0.1:8140/ui/${id}/`;
  const requests = [];

  await loadPinnedDocument({
    fetch: async (address, init) => {
      requests.push([address, init.cache, init.signal.aborted]);

      return new Response(JSON.stringify({ version: 1, id }));
    },
    pinned: { id, url },
    window: f.window,
    address: 'http://127.0.0.1:8140/#/chats',
    signal: f.controller.signal,
  });
  assert.deepEqual(requests, [[url + 'release.json', 'no-store', false]]);
  assert.deepEqual(f.calls, [['load', url + '#/chats']]);
});

test('WD-08 несовместимый release даёт прежний PermanentConnectionError без загрузки', async (t) => {
  const id = 'a'.repeat(64);
  const responses = [
    [true, JSON.stringify({ version: 2, id })],
    [true, JSON.stringify({ version: 1, id: 'b'.repeat(64) })],
    [false, JSON.stringify({ version: 1, id })],
    [true, 'битый JSON'],
  ];

  for (const [ok, body] of responses) {
    const f = fixture(t, '');

    await assert.rejects(loadPinnedDocument({
      fetch: async () => new Response(body, { status: ok ? 200 : 500 }),
      pinned: { id, url: `http://127.0.0.1:8140/ui/${id}/` },
      window: f.window,
      address: 'http://127.0.0.1:8140/#/chats',
      signal: f.controller.signal,
    }), (error) => {
      assert.equal(error instanceof PermanentConnectionError, true);
      assert.equal(error.message, 'Сервер не обслуживает интерфейс этого приложения. '
        + 'Обновите сервер GrigDesk и запустите приложение заново.');

      return true;
    });
    assert.deepEqual(f.calls, []);
  }
});

test('WD-09 без закрепления загружается исходный адрес без fetch', async (t) => {
  const f = fixture(t, '');

  await loadPinnedDocument({
    fetch: async () => assert.fail('Fetch без закрепления не нужен.'),
    pinned: null,
    window: f.window,
    address: 'http://127.0.0.1:8140/#/tasks',
    signal: f.controller.signal,
  });
  assert.deepEqual(f.calls, [['load', 'http://127.0.0.1:8140/#/tasks']]);
});
