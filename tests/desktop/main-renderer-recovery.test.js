import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { attachMainRendererRecovery } from '../../desktop/src/mainRendererRecovery.ts';

/**
 * Двойник удерживает native-диалог независимо от закрытия и смены документа.
 * Поздний ответ проверяет настоящий lifecycle-контроллер без запуска Electron.
 */
function fixture(t) {
  const state = {
    origin: 'http://pipe.test',
    stopping: false,
    shown: true,
    dead: false,
  };
  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => state.dead });
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => state.dead,
    webContents: contents,
  });
  const lifetime = new AbortController();
  const prompts = [];
  const reloads = [];
  const logs = [];
  let invalidations = 0;
  let failures = 0;
  let reloadError = null;
  const dispose = attachMainRendererRecovery({
    window,
    signal: lifetime.signal,
    origin: () => state.origin,
    stopping: () => state.stopping,
    revealed: () => state.shown,
    invalidate: () => {
      invalidations += 1;
    },
    confirm: (signal) => {
      const response = Promise.withResolvers();

      prompts.push({ signal, ...response });

      return response.promise;
    },
    reload: async (origin) => {
      reloads.push(origin);

      if (reloadError) {
        throw reloadError;
      }

      contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    },
    failStartup: () => {
      failures += 1;
    },
    log: (value) => logs.push(value),
  });

  t.after(dispose);

  return {
    state,
    contents,
    window,
    lifetime,
    prompts,
    reloads,
    logs,
    dispose,
    invalidations: () => invalidations,
    failures: () => failures,
    failReload: (error) => {
      reloadError = error;
    },
    crash: () => contents.emit('render-process-gone', {}, {
      reason: 'crashed',
      exitCode: 5,
      unusedPrivateData: 'секрет',
    }),
  };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

test('падение инвалидирует browser и предлагает только ручную перезагрузку UI', async (t) => {
  const f = fixture(t);

  f.crash();
  f.crash();
  assert.equal(f.invalidations(), 2);
  assert.equal(f.prompts.length, 1, 'Один native-диалог на потерянный документ');
  assert.deepEqual(f.reloads, []);
  assert.deepEqual(f.logs[0], {
    event: 'renderer-gone',
    role: 'main',
    reason: 'crashed',
    exitCode: 5,
  });
  f.prompts[0].resolve(true);
  await settle();
  assert.deepEqual(f.reloads, [f.state.origin]);
  assert.equal(f.prompts[0].signal.aborted, false, 'Своя навигация не отменяет загрузку');
  f.crash();
  assert.equal(f.prompts.length, 2);
  assert.equal(f.reloads.length, 1, 'Повторное падение снова требует ответа человека');
});

test('отказ оставляет окно и не запускает автоматический повтор', async (t) => {
  const f = fixture(t);

  f.crash();
  f.prompts[0].resolve(false);
  await settle();
  assert.deepEqual(f.reloads, []);
  assert.equal(f.failures(), 0);
});

test('закрытие, навигация, смена машины и выход обезвреживают поздний ответ', async (t) => {
  for (const change of ['closed', 'destroyed', 'navigation', 'origin', 'stopping', 'abort']) {
    const f = fixture(t);

    f.crash();

    if (change === 'closed') {
      f.window.emit('closed');
    } else if (change === 'destroyed') {
      f.contents.emit('destroyed');
    } else if (change === 'navigation') {
      f.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    } else if (change === 'origin') {
      f.state.origin = 'http://other-pipe.test';
    } else if (change === 'stopping') {
      f.state.stopping = true;
    } else {
      f.lifetime.abort();
    }

    f.prompts[0].resolve(true);
    await settle();
    assert.deepEqual(f.reloads, [], change);
  }
});

test('подкадр и hash-навигация не отменяют вопрос потерянного main renderer', async (t) => {
  const f = fixture(t);

  f.crash();
  f.contents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
  f.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
  f.prompts[0].resolve(true);
  await settle();
  assert.equal(f.reloads.length, 1);
});

test('падение до показа проходит обычный отказ старта; выход не открывает диалог', (t) => {
  const f = fixture(t);

  f.state.shown = false;
  f.crash();
  assert.equal(f.failures(), 1);
  assert.equal(f.prompts.length, 0);
  f.state.stopping = true;
  f.crash();
  assert.equal(f.failures(), 1);
  assert.equal(f.invalidations(), 1);
});

test('отказы native-диалога и reload наблюдаемы без утечки текста исключения', async (t) => {
  for (const phase of ['prompt', 'reload']) {
    const f = fixture(t);
    const error = new Error('приватный адрес и текст');

    f.crash();

    if (phase === 'prompt') {
      f.prompts[0].reject(error);
    } else {
      f.failReload(error);
      f.prompts[0].resolve(true);
    }

    await settle();
    assert.deepEqual(f.logs.at(-1), {
      event: 'renderer-recovery-failed',
      role: 'main',
      phase,
    });
    assert.doesNotMatch(JSON.stringify(f.logs), /приватный|секрет/);
  }
});

test('dispose отменяет диалог и снимает все собственные listeners', async (t) => {
  const f = fixture(t);

  f.crash();
  f.dispose();
  f.dispose();
  assert.equal(f.prompts[0].signal.aborted, true);
  assert.equal(f.contents.listenerCount('render-process-gone'), 0);
  assert.equal(f.contents.listenerCount('did-start-navigation'), 0);
  assert.equal(f.contents.listenerCount('destroyed'), 0);
  assert.equal(f.window.listenerCount('closed'), 0);
  f.prompts[0].resolve(true);
  await settle();
  assert.deepEqual(f.reloads, []);
});
