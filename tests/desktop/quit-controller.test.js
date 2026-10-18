import assert from 'node:assert/strict';
import test from 'node:test';

import { createQuitController } from '../../desktop/src/quitController.ts';

/**
 * Даёт отработать цепочкам обещаний контроллера без настоящих таймеров.
 * Число оборотов с запасом покрывает вложенные await уборки.
 */
async function flush() {
  for (let index = 0; index < 20; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * Адаптеры пишут вызовы в журнал; долгие шаги — обещания, которые тест разрешает сам.
 * По умолчанию главное окно показано, остановка сервера и диалог завершаются сразу.
 */
function fixture(overrides = {}) {
  const calls = [];
  const dialogSignals = [];
  const server = Promise.withResolvers();
  const dialog = Promise.withResolvers();
  const adapters = {
    cancelStartup: () => calls.push('cancelStartup'),
    closeSplash: () => calls.push('closeSplash'),
    showError: (message, signal) => {
      calls.push(`dialog:${message}`);
      dialogSignals.push(signal);

      return overrides.blockDialog ? dialog.promise : Promise.resolve();
    },
    stopOwnServer: () => {
      calls.push('stopServer');

      return overrides.blockServer ? server.promise : Promise.resolve();
    },
    revealed: () => overrides.revealed ?? true,
    saveWindow: () => {
      calls.push('saveWindow');

      return overrides.saveWindow?.() ?? Promise.resolve();
    },
    flushCookies: () => {
      calls.push('flushCookies');

      return overrides.flushCookies?.() ?? Promise.resolve();
    },
    log: (message) => calls.push(`log:${message}`),
    exit: (code) => calls.push(`exit:${code}`),
  };

  return {
    quit: createQuitController(adapters),
    calls,
    dialogSignals,
    server,
    dialog,
  };
}

test('QC-01: повторный request — то же обещание, код и сообщение первого', async () => {
  const f = fixture({ blockServer: true });
  const first = f.quit.request({
    reason: 'user',
    exitCode: 0,
  });
  const second = f.quit.request({
    reason: 'failure',
    exitCode: 1,
    message: 'поздний отказ',
  });

  assert.strictEqual(second, first);
  f.server.resolve();
  await first;
  assert.equal(f.calls.at(-1), 'exit:0');
  assert.equal(f.calls.some((call) => call.includes('поздний отказ')), false);
  assert.equal(f.calls.filter((call) => call.startsWith('exit')).length, 1);
});

test('QC-02: порядок уборки — старт, заставка, параллельные шаги, cookies, выход', async () => {
  const f = fixture();

  await f.quit.request({
    reason: 'user',
    exitCode: 0,
  });
  assert.deepEqual(f.calls, [
    'cancelStartup',
    'closeSplash',
    'stopServer',
    'saveWindow',
    'flushCookies',
    'exit:0',
  ]);
});

test('QC-03: ошибки сохранения окна и cookies не отменяют остановку и выход', async () => {
  const f = fixture({
    saveWindow: () => Promise.reject(new Error('диск')),
    flushCookies: () => Promise.reject(new Error('cookies')),
  });

  await f.quit.request({
    reason: 'main-closed',
    exitCode: 0,
  });
  assert.ok(f.calls.includes('stopServer'));
  assert.equal(f.calls.at(-1), 'exit:0');
});

test('QC-04: выход только после остановки своего сервера', async () => {
  const f = fixture({ blockServer: true });
  const finished = f.quit.request({
    reason: 'user',
    exitCode: 0,
  });

  await flush();
  assert.equal(f.calls.some((call) => call.startsWith('exit') || call === 'flushCookies'), false);
  f.server.resolve();
  await finished;
  assert.deepEqual(f.calls.slice(-2), ['flushCookies', 'exit:0']);
});

test('QC-05: до показа главного окна геометрия не сохраняется', async () => {
  const f = fixture({ revealed: false });

  await f.quit.request({
    reason: 'splash-closed',
    exitCode: 0,
  });
  assert.equal(f.calls.includes('saveWindow'), false);
  assert.equal(f.calls.at(-1), 'exit:0');
});

test('QC-06: отказ пишет строку в журнал и показывает диалог; без сообщения диалога нет', async () => {
  const failed = fixture();

  await failed.quit.request({
    reason: 'failure',
    exitCode: 1,
    message: 'Сервер не готов.',
  });
  assert.equal(failed.calls[0], 'log:GrigDesk: Сервер не готов.');
  assert.ok(failed.calls.includes('dialog:Сервер не готов.'));
  assert.equal(failed.calls.at(-1), 'exit:1');

  const quiet = fixture();

  await quiet.quit.request({
    reason: 'user',
    exitCode: 0,
  });
  assert.equal(quiet.calls.some((call) => call.startsWith('dialog') || call.startsWith('log')), false);
});

test('QC-07: диалог и остановка сервера идут параллельно, выход ждёт оба', async () => {
  const f = fixture({
    blockDialog: true,
    blockServer: true,
  });
  const finished = f.quit.request({
    reason: 'failure',
    exitCode: 1,
    message: 'отказ',
  });

  await flush();
  assert.ok(f.calls.includes('dialog:отказ'));
  assert.ok(f.calls.includes('stopServer'));
  f.server.resolve();
  await flush();
  assert.equal(f.calls.some((call) => call.startsWith('exit')), false);
  f.dialog.resolve();
  await finished;
  assert.equal(f.calls.at(-1), 'exit:1');
});

test('QC-08: stopping становится true синхронно при первом запросе', () => {
  const f = fixture({ blockServer: true });

  assert.equal(f.quit.stopping, false);
  void f.quit.request({
    reason: 'signal',
    exitCode: 0,
  });
  assert.equal(f.quit.stopping, true);
});

test('QC-09: внешний запрос выхода во время диалога закрывает диалог, код остаётся первым', async () => {
  for (const reason of ['signal', 'user']) {
    const f = fixture({ blockDialog: true });
    const finished = f.quit.request({
      reason: 'failure',
      exitCode: 1,
      message: 'отказ',
    });

    await flush();
    assert.equal(f.dialogSignals.length, 1, 'Диалог отказа показан.');
    assert.equal(f.dialogSignals[0].aborted, false);
    void f.quit.request({
      reason: 'main-closed',
      exitCode: 0,
    });
    assert.equal(f.dialogSignals[0].aborted, false, 'Закрытие окна диалог не закрывает.');
    void f.quit.request({
      reason,
      exitCode: 0,
    });
    assert.equal(f.dialogSignals[0].aborted, true, reason);
    f.dialog.resolve();
    await finished;
    assert.equal(f.calls.at(-1), 'exit:1', reason);
  }
});
