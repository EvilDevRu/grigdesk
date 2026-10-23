import assert from 'node:assert/strict';
import test from 'node:test';

import { exitMain } from './helpers/exitMain.js';

/**
 * Проверка идёт через настоящий close main, без требования экспортов нового контроллера.
 * Исходная реализация доходит до assertion удержания окна, а не падает на импорте нового файла.
 */
async function held(t, options = {}) {
  const f = await exitMain(t, options);

  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 });
  assert.equal(f.window.close().defaultPrevented, true, 'К1: активный собственный main удержан');
  await f.settle();

  return f;
}

/**
 * Таймеры решения идут небольшими шагами, между ними исполняются микрозадачи.
 * Большой скачок сразу не имитирует несколько последовательных асинхронных опросов.
 */
async function advance(t, f, duration) {
  for (let elapsed = 0; elapsed < duration; elapsed += 500) {
    t.mock.timers.tick(Math.min(500, duration - elapsed));
    await f.settle();
  }
}

test('EX01: owned main и отдельные chat-only/pipeline-only вызывают вопрос', async (t) => {
  for (const snapshot of [
    { chats: [{ chatKey: 'one', title: 'Один чат' }], pipelines: [] },
    { chats: [], pipelines: [{ task: '7', title: 'Одна задача' }] },
  ]) {
    await t.test(snapshot.chats.length ? 'только чат' : 'только конвейер', async (sub) => {
      const f = await held(sub, { snapshot });

      assert.ok(f.calls.includes('prompt'));
      assert.equal(f.calls.includes('server-stop'), false);
    });
  }
});

for (const mode of [
  { ownership: 'external' },
  { ownership: 'none' },
  { selectedOrigin: 'http://127.0.0.1:29998' },
  { visible: false },
  { remote: true },
]) {
  test(`EX01/barrier: прежний close вне собственного видимого main ${JSON.stringify(mode)}`, async (t) => {
    const f = await exitMain(t, mode);

    assert.equal(f.window.close().defaultPrevented, false);
    await f.settle();
    assert.equal(f.commands.length, 0);
    assert.equal(f.calls.includes('pipelines-stopped'), false);
  });
}

test('EX02: Cancel с Remember оставляет окно, сервер, конвейеры и настройку', async (t) => {
  const f = await held(t, { decision: 'cancel', remember: true });

  await advance(t, f, 1000);
  assert.equal(f.window.isDestroyed(), false);
  assert.equal(f.calls.includes('server-stop'), false);
  assert.equal(f.calls.includes('stop-pipelines'), false);
  assert.equal(f.stored.skipExitConfirmation ?? false, false);
});

test('EX03: только confirm+Remember сохраняет согласие', async (t) => {
  const f = await held(t, { decision: 'confirm', remember: true });

  await advance(t, f, 1000);
  assert.equal(f.stored.skipExitConfirmation, true);
  assert.ok(f.calls.includes('save'));
  assert.ok(f.calls.includes('stopping'));


});

test('EX03/remembered: сохранённое согласие пропускает prompt, но сохраняет inspect и модал', async (t) => {
  const f = await held(t, { skipConfirmation: true });

  assert.ok(f.calls.includes('inspect'));
  assert.equal(f.calls.includes('prompt'), false);
  assert.ok(f.calls.includes('stopping'));
  assert.ok(f.calls.includes('server-stop'));
});

test('EX04: пустой snapshot закрывает окно без вопроса, спиннера и Stop', async (t) => {
  const f = await exitMain(t, { skipConfirmation: true, snapshot: { chats: [], pipelines: [] } });

  f.window.close();
  await f.settle();
  assert.ok(f.calls.includes('native-close'));
  assert.equal(f.calls.includes('prompt'), false);
  assert.equal(f.calls.includes('stopping'), false);
  assert.equal(f.calls.includes('stop-pipelines'), false);
});

test('EX05: render → Stop конвейеров → свой server.stop → native close → старый quit', async (t) => {
  const f = await held(t, {
    decision: 'confirm',
    blockServer: true,
    blockPipelines: true,
    blockRender: true,
  });

  await advance(t, f, 1000);
  assert.ok(f.calls.includes('stopping'));
  assert.equal(f.calls.includes('stop-pipelines'), false, 'Stop ждёт ACK отрисованного модала');
  f.render.resolve({ ok: true });
  await f.settle();
  assert.ok(f.calls.includes('stop-pipelines'));
  assert.equal(f.calls.includes('server-stop'), false);
  assert.equal(f.calls.includes('shell-close'), false);
  f.pipeline.resolve();
  await f.settle();
  assert.ok(f.calls.includes('server-stop'));
  assert.equal(f.calls.includes('native-close'), false);
  assert.equal(f.calls.includes('shell-close'), false);
  f.server.resolve();
  await f.settle();

  const ordered = ['stopping', 'pipelines-stopped', 'server-stop', 'server-stopped',
    'native-close', 'shell-close', 'cookies', 'exit:0'].map((entry) => f.calls.indexOf(entry));

  assert.ok(ordered.every((index) => index >= 0));
  assert.deepEqual(ordered, [...ordered].sort((left, right) => left - right));
});

for (const blocked of ['blockPipelines', 'blockServer', 'blockSave', 'blockCookies']) {
  test(`EX06: единый срок 90 секунд при ${blocked}`, async (t) => {
    const f = await held(t, { decision: 'confirm', [blocked]: true });

    await advance(t, f, 1000);
    assert.ok(f.calls.includes('stopping'));
    t.mock.timers.tick(10000);
    f.window.close();
    await f.settle();
    t.mock.timers.tick(80000);
    await f.settle();
    assert.ok(f.calls.includes('exit:0'), 'Повтор close не продлевает исходный deadline');
    assert.equal(f.commands.filter((command) => command.type === 'stop-pipelines').length, 1);
  });
}

test('EX06-grace: согласованный фиксированный срок остаётся 90 секунд при grace=100 секунд', async (t) => {
  const f = await held(t, {
    decision: 'confirm',
    graceMs: 100000,
    blockServer: true,
  });

  await advance(t, f, 1000);
  t.mock.timers.tick(90000);
  await f.settle();
  assert.ok(f.calls.includes('exit:0'));
});

test('EX07: живой pending не ограничивает время решения человека', async (t) => {
  const f = await held(t);

  await advance(t, f, 120000);
  assert.equal(f.calls.includes('native-close'), false);
  assert.equal(f.calls.includes('server-stop'), false);
  f.state.decision = 'cancel';
  await advance(t, f, 1000);
  assert.equal(f.window.isDestroyed(), false);
});

test('EX07/unavailable: отказ исполнения возвращает прежний путь без Stop', async (t) => {
  const f = await exitMain(t, { executeError: true });

  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 });
  f.window.close();
  await f.settle();
  t.mock.timers.tick(5000);
  await f.settle();
  assert.ok(f.calls.includes('native-close'));
  assert.equal(f.calls.includes('stop-pipelines'), false);
});

test('EX07/timeout: молчащий inspect ограничен пятью секундами', async (t) => {
  const f = await held(t, { blockInspect: true });

  t.mock.timers.tick(4999);
  await f.settle();
  assert.equal(f.calls.includes('native-close'), false);
  t.mock.timers.tick(1);
  await f.settle();
  assert.ok(f.calls.includes('native-close'));
  assert.equal(f.calls.includes('stop-pipelines'), false);
});

test('EX07-jank: один ответ через 2,5 секунды не означает согласие или выход', async (t) => {
  const f = await held(t);
  const frame = f.window.webContents.mainFrame;
  const original = frame.executeJavaScript;
  const late = Promise.withResolvers();
  let delayed = false;

  frame.executeJavaScript = (script) => {
    if (script.includes('decision') && !delayed) {
      delayed = true;

      return late.promise;
    }

    return original(script);
  };
  await advance(t, f, 3000);
  late.resolve({ decision: 'pending' });
  await f.settle();
  assert.equal(f.calls.includes('native-close'), false);
  assert.equal(f.calls.includes('server-stop'), false);
  f.state.decision = 'cancel';
  await advance(t, f, 1000);
  assert.equal(f.window.isDestroyed(), false);
});

test('EX08: повтор close single-flight; после Cancel допустим новый вопрос', async (t) => {
  const f = await held(t);

  f.window.close();
  f.window.close();
  await f.settle();
  assert.equal(f.commands.filter((command) => command.type === 'prompt').length, 1);
  f.state.decision = 'cancel';
  await advance(t, f, 1000);
  f.state.decision = 'pending';
  f.window.close();
  await f.settle();
  assert.equal(f.commands.filter((command) => command.type === 'prompt').length, 2);
});

for (const phase of ['inspect', 'prompt', 'stop-pipelines']) {
  test(`EX09: системный quit во время ${phase} не допускает поздних эффектов`, async (t) => {
    const f = await held(t, {
      decision: phase === 'stop-pipelines' ? 'confirm' : 'pending',
      blockInspect: phase === 'inspect',
      blockPipelines: phase === 'stop-pipelines',
    });

    await advance(t, f, 1000);
    f.signals.get('SIGTERM')();
    await f.settle();

    const stops = f.commands.filter((command) => command.type === 'stop-pipelines').length;

    f.inspect.resolve(f.state.snapshot);
    f.pipeline.resolve();
    f.state.decision = 'confirm';
    await advance(t, f, 10000);
    assert.equal(f.commands.filter((command) => command.type === 'stop-pipelines').length, stops);
    assert.ok(f.calls.includes('exit:0'));
  });
}

test('EX07-jank/destroyed: потеря frame при вопросе возвращает прежний выход', async (t) => {
  const f = await held(t);

  f.state.destroyed = true;
  f.window.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  await advance(t, f, 5000);
  assert.ok(f.calls.includes('native-close'));
  assert.equal(f.calls.includes('stop-pipelines'), false);
});
