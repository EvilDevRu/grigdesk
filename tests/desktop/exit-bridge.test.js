import assert from 'node:assert/strict';
import test from 'node:test';

import { exitMain } from './helpers/exitMain.js';

test('BR01: только главный frame получает inspect с requestId и сроком действия', async (t) => {
  const f = await exitMain(t);

  f.window.close();
  await f.settle();

  const inspect = f.commands.find((command) => command.type === 'inspect');

  assert.ok(inspect, 'К10: доставлен ограниченный запрос активности главному frame');
  assert.equal(typeof inspect.requestId, 'string');
  assert.ok(inspect.requestId.length > 0);
  assert.ok(inspect.expiresAt > Date.now() && inspect.expiresAt <= Date.now() + 5000);
});

for (const invalid of [
  'loading', 'crashed', 'destroyed', 'foreign', 'non-root', 'detached', 'subframe', 'missing',
]) {
  test(`BR01/barrier: ${invalid} не получает исполнения`, async (t) => {
    const f = await exitMain(t);

    if (['loading', 'crashed', 'destroyed'].includes(invalid)) {
      f.state[invalid] = true;
    } else if (invalid === 'foreign' || invalid === 'non-root') {
      f.state.url = invalid === 'foreign' ? 'https://foreign.invalid/' : f.origin + '/other';
      f.window.webContents.mainFrame.url = f.state.url;
    } else if (invalid === 'missing') {
      f.window.webContents.mainFrame = null;
    } else if (invalid === 'detached') {
      f.window.webContents.mainFrame.detached = true;
    } else {
      f.window.webContents.mainFrame.parent = {};
    }

    f.window.close();
    await f.settle();
    assert.equal(f.commands.length, 0);
    assert.equal(f.calls.includes('stop-pipelines'), false);
  });
}

for (const change of ['frame', 'origin', 'profile', 'generation']) {
  test(`BR02: смена ${change} инвалидирует уже запрошенный inspect`, async (t) => {
    const f = await exitMain(t, { blockInspect: true });

    f.window.close();
    await f.settle();
    assert.ok(f.calls.includes('inspect'), 'Запрос начался в исходном допустимом контексте');

    if (change === 'frame') {
      f.window.webContents.mainFrame = { ...f.window.webContents.mainFrame };
    } else if (change === 'origin') {
      f.state.url = 'https://foreign.invalid/';
      f.window.webContents.mainFrame.url = f.state.url;
    } else if (change === 'profile') {
      f.stored.selected = 'other-machine';
      f.stored.profiles[0].address = 'https://remote.invalid';
    } else {
      f.state.generation += 1;
    }

    f.inspect.resolve(f.state.snapshot);
    await f.settle();
    assert.equal(f.calls.includes('prompt'), false);
    assert.equal(f.calls.includes('stop-pipelines'), false);
  });
}

test('BR02: кавычки и код в названиях остаются данными фиксированной команды', async (t) => {
  const title = '\"); globalThis.injected = true; // <img src=x onerror=alert(1)>';
  const snapshot = { chats: [{ chatKey: 'chat-"\\', title }], pipelines: [{ task: '7', title }] };
  const f = await exitMain(t, { snapshot });

  f.window.close();
  await f.settle();

  const prompt = f.commands.find((command) => command.type === 'prompt');

  assert.ok(prompt, 'К1/К10: вопрос доставлен без ошибки исполнения имени');
  assert.deepEqual(prompt.snapshot, snapshot);
  assert.equal(f.calls.includes('server-stop'), false);
});
