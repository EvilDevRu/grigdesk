import assert from 'node:assert/strict';
import test from 'node:test';

import { exitMain } from './helpers/exitMain.js';

/**
 * Порт updater записывает момент передачи выхода, не подменяя main и exit-controller.
 * Подготовку и ожидание drain тест удерживает отдельным обещанием.
 */
function installUpdate(f, { ready = true, applicable = true, result = 'applied', pending } = {}) {
  const state = { ready };

  f.module.setUpdateFixture({
    canApplyReadyOnQuit: () => state.ready && applicable,
    port: { state: () => ({ job: { stage: state.ready ? 'ready' : 'preparing' } }) },
    close: () => f.calls.push('updates-close'),
    async applyReadyOnQuit() {
      f.calls.push('update-apply');
      await pending;

      return result;
    },
  });

  return state;
}

test('MAIN-UPDATE: готовое обновление владеет остановкой и сроком до drain', async (t) => {
  const f = await exitMain(t, { decision: 'confirm' });
  const pending = Promise.withResolvers();

  t.after(() => pending.resolve());
  installUpdate(f, { pending: pending.promise });
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 });
  f.window.close();
  await f.settle();
  assert.ok(f.calls.includes('stopping'));
  assert.ok(f.calls.includes('update-apply'));
  assert.equal(f.calls.includes('stop-pipelines'), false);
  assert.equal(f.calls.includes('server-stop'), false);
  f.window.close();
  t.mock.timers.tick(90000);
  await f.settle();
  assert.equal(f.calls.includes('exit:0'), false, 'Обычный deadline не заменяет update-drain');
  assert.equal(f.calls.filter((call) => call === 'update-apply').length, 1);
});

test('MAIN-UPDATE: отказ применения возвращает обычный Stop без повторного обновления', async (t) => {
  const f = await exitMain(t, { decision: 'confirm', emitAllClosed: true });

  installUpdate(f, { result: 'idle' });
  f.window.close();
  await f.settle();
  assert.ok(f.calls.indexOf('update-apply') < f.calls.indexOf('stop-pipelines'));
  assert.ok(f.calls.indexOf('pipelines-stopped') < f.calls.indexOf('server-stop'));
  assert.equal(f.calls.filter((call) => call === 'update-apply').length, 1);
  assert.ok(f.calls.includes('exit:0'));
});

test('MAIN-UPDATE: позднее ready после начала обычного Stop не запускает применение', async (t) => {
  const f = await exitMain(t, {
    decision: 'confirm',
    blockServer: true,
    emitAllClosed: true,
  });
  const update = installUpdate(f, { ready: false });

  f.window.close();
  await f.settle();
  assert.ok(f.calls.includes('server-stop'));
  update.ready = true;
  f.server.resolve();
  await f.settle();
  assert.equal(f.calls.includes('update-apply'), false);
  assert.ok(f.calls.includes('exit:0'));
});

test('MAIN-UPDATE: ready другого профиля сохраняет обычную остановку конвейеров', async (t) => {
  const f = await exitMain(t, { decision: 'confirm' });

  installUpdate(f, { applicable: false });
  f.window.close();
  await f.settle();
  assert.equal(f.calls.includes('update-apply'), false);
  assert.ok(f.calls.indexOf('pipelines-stopped') < f.calls.indexOf('server-stop'));
  assert.ok(f.calls.includes('exit:0'));
});

for (const reason of ['failure', 'signal']) {
  test(`MAIN-UPDATE: ${reason} до main не применяет ready при закрытии заставки`, async (t) => {
    const f = await exitMain(t, {
      startupOnly: true,
      emitAllClosed: true,
      blockServer: true,
    });

    installUpdate(f);
    void f.module.quit.request({ reason, exitCode: reason === 'failure' ? 1 : 0 });
    await f.settle();
    assert.equal(f.window.isDestroyed(), true);
    assert.ok(f.calls.includes('updates-close'));
    assert.equal(f.calls.includes('update-apply'), false);
    f.server.resolve();
    await f.settle();
    assert.ok(f.calls.includes(`exit:${reason === 'failure' ? 1 : 0}`));
  });
}

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
