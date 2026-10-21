import assert from 'node:assert/strict';
import test from 'node:test';
import { compileModule, webFile } from './helpers/compile-vue.js';
import { mountDesktopEntry } from './helpers/desktop-entry.js';

test('TN-01: подтверждённая навигация закрывает карточку; unknown и false сохраняют её', async () => {
  const { leaveTaskForPipeline } = await compileModule(webFile('src/shared/taskWindowNavigation.ts'));
  const pending = Promise.withResolvers();
  const beforeConfirmation = [];
  const navigation = leaveTaskForPipeline({
    document: true,
    send: () => pending.promise,
    route: async () => beforeConfirmation.push('route'),
    close: () => beforeConfirmation.push('close'),
    failure: () => beforeConfirmation.push('failure'),
  });

  await Promise.resolve();
  assert.deepEqual(beforeConfirmation, []);
  pending.resolve({ opened: true });
  await navigation;
  assert.deepEqual(beforeConfirmation, ['close']);

  for (const [reply, expected] of [
    [{ opened: true }, true], [{ opened: false }, false], [{}, false], [new Error('Сеть'), false],
  ]) {
    const calls = [];

    await leaveTaskForPipeline({
      document: true,
      send: async () => {
        if (reply instanceof Error) {
          throw reply;
        }

        return reply;
      },
      route: async () => calls.push('route'),
      close: () => calls.push('close'),
      failure: () => calls.push('failure'),
    });
    assert.deepEqual(calls, expected ? ['close'] : ['failure']);
  }

  const calls = [];

  await leaveTaskForPipeline({
    document: false,
    send: async () => {
      throw new Error('Native вызван в вебе');
    },
    route: async () => calls.push('route'),
    close: () => calls.push('close'),
    failure: () => calls.push('failure'),
  });
  assert.deepEqual(calls, ['close', 'route']);
});

test('TN-02: main подтверждает переход после router и принимает диалог только у себя', async (t) => {
  const pending = Promise.withResolvers();
  const router = {
    onError: () => () => {},
    currentRoute: { value: { path: '/board' } },
    push(path) {
      assert.equal(path, '/pipeline');

      return pending.promise;
    },
  };
  const { win, ui } = await mountDesktopEntry(t, { mode: 'main', router });

  assert.equal(typeof win.grigdeskSurfaceMain, 'function');

  let confirmed = false;
  const request = win.grigdeskSurfaceMain({ destination: 'pipeline' }).then((value) => {
    confirmed = true;

    return value;
  });

  await Promise.resolve();
  assert.equal(confirmed, false);
  router.currentRoute.value.path = '/pipeline';
  pending.resolve();
  assert.equal(await request, true);
  assert.equal(await win.grigdeskSurfaceMain({
    destination: 'task-dialog', target: { kind: 'task', id: '42' },
  }), true);
  assert.deepEqual(ui.opened, ['42']);
  assert.equal(await win.grigdeskSurfaceMain({ destination: 'pipeline', url: 'http://foreign' }), false);
  router.push = async () => {
    throw new Error('Раздел не загрузился');
  };
  assert.equal(await win.grigdeskSurfaceMain({ destination: 'pipeline' }), false);
  router.push = async () => {};
  router.currentRoute.value.path = '/board';
  assert.equal(await win.grigdeskSurfaceMain({ destination: 'pipeline' }), false);
});

test('TN-02/surface: документ карточки не устанавливает обработчик main', async (t) => {
  const { win } = await mountDesktopEntry(t, { mode: 'surface' });

  assert.equal(win.grigdeskSurfaceMain, undefined);
});
