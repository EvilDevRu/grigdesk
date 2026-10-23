import assert from 'node:assert/strict';
import test from 'node:test';

import { exitMain } from './helpers/exitMain.js';

test('MAIN01: настоящий main удерживает close до остановки собственного сервера', async (t) => {
  const f = await exitMain(t, { decision: 'confirm', blockServer: true });
  const event = f.window.close();

  assert.equal(event.defaultPrevented, true, 'К1/К4: окно удержано до ответа и остановки');
  await f.settle();
  assert.ok(f.calls.includes('stopping'));
  assert.ok(f.calls.includes('server-stop'));
  assert.equal(f.calls.includes('native-close'), false);
  assert.equal(f.calls.includes('shell-close'), false, 'Труба жива до окончания предварительного слива');
  f.server.resolve();
  await f.settle();
  assert.ok(f.calls.includes('native-close'));
  assert.ok(f.calls.includes('exit:0'));
});

test('MAIN02: before-quit и зарегистрированные системные сигналы не спрашивают человека', async (t) => {
  for (const signal of ['before-quit', 'SIGTERM', 'SIGINT']) {
    await t.test(signal, async (sub) => {
      const f = await exitMain(sub);

      if (signal === 'before-quit') {
        f.app.emit(signal, { preventDefault() {} });
      } else {
        f.signals.get(signal)();
      }

      await f.settle();
      assert.equal(f.commands.length, 0);
      assert.equal(f.calls.includes('pipelines-stopped'), false);
      assert.ok(f.calls.includes('server-stop'));
      assert.ok(f.calls.includes('exit:0'));
    });
  }
});

test('MAIN03: настоящее дополнительное окно закрывается без вопроса и остановки', async (t) => {
  const f = await exitMain(t);
  const surface = f.module.createSurfaceWindow(f.origin + '/?surface=task', { task: '7' }, 0);

  assert.equal(surface.close().defaultPrevented, false);
  await f.settle();
  assert.equal(f.window.isDestroyed(), false);
  assert.equal(f.commands.length, 0);
  assert.equal(f.calls.includes('server-stop'), false);
  assert.equal(f.calls.includes('exit:0'), false);
});

test('MAIN04 unload-guard: согласованный выход преодолевает dirty beforeunload после слива', async (t) => {
  const f = await exitMain(t, { decision: 'confirm', dirtyPage: true });

  f.window.close();
  await f.settle();
  assert.ok(f.calls.includes('unload-overridden'), 'К4/B1: разрешённый finishing снимает beforeunload');
  assert.ok(f.calls.includes('exit:0'));
  assert.ok(f.calls.indexOf('server-stopped') < f.calls.indexOf('native-close'));
});

test('MAIN04 unload-guard: без активности защита несохранённых правок сохраняется', async (t) => {
  const f = await exitMain(t, { snapshot: { chats: [], pipelines: [] }, dirtyPage: true });

  f.window.close();
  await f.settle();
  assert.ok(f.calls.includes('unload-held'));
  assert.equal(f.calls.includes('unload-overridden'), false);
  assert.equal(f.calls.includes('server-stop'), false);
});

test('MAIN01/cookies: реальная уборка не снимает предельный срок finishing', async (t) => {
  const f = await exitMain(t, { decision: 'confirm', blockCookies: true });

  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 });
  f.window.close();
  await f.settle();
  assert.ok(f.calls.includes('stopping'), 'Остановка показана до настоящего cancelStartup');
  assert.ok(f.calls.includes('shell-close'));
  assert.ok(f.calls.includes('cookies'));
  assert.equal(f.calls.includes('exit:0'), false);
  t.mock.timers.tick(90000);
  await f.settle();
  assert.ok(f.calls.includes('exit:0'), 'К9: зависшие cookies не держат процесс после срока');
});

for (const options of [{ decision: 'cancel' }, { ownership: 'external' }]) {
  test(`MAIN04 unload-guard: прежняя защита правок при ${JSON.stringify(options)}`, async (t) => {
    const f = await exitMain(t, { ...options, dirtyPage: true });

    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 });
    f.window.close();
    await f.settle();
    t.mock.timers.tick(1000);
    await f.settle();
    assert.equal(f.calls.includes('unload-overridden'), false);
    assert.equal(f.calls.includes('server-stop'), false);
    assert.equal(f.window.isDestroyed(), false);
  });
}
