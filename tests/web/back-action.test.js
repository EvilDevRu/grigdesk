import assert from 'node:assert/strict';
import test from 'node:test';
import { installUiBrowser } from './helpers/ui-components.js';
import { compileModule, webFile } from './helpers/compile-vue.js';

test('Назад закрывает верхний слой, затем историю; корень возвращает false', async (t) => {
  await installUiBrowser(t);

  const stack = await import('../../web/src/services/layers/stack.ts');

  globalThis.__backStack = stack;

  const { installBackAction } = await compileModule(webFile('src/shared/backAction.ts'), {
    stubs: {
      '../ui.ts': 'export const closeTopLayer = (...args) => globalThis.__backStack.closeTopLayer(...args);',
    },
  });
  const router = {
    options: { history: { state: { back: null } } },
    back() {
      this.called = true;
    },
  };
  const dispose = installBackAction(router);
  let closed = false;
  const layer = stack.registerUiLayer('back-test', {
    name: 'dialog',
    close() {
      closed = true;
      layer.unregister();
    },
  });

  assert.equal(window.grigdeskBack(), true);
  assert.equal(closed, true);
  assert.equal(window.grigdeskBack(), false);
  router.options.history.state.back = '/board';
  assert.equal(window.grigdeskBack(), true);
  assert.equal(router.called, true);
  dispose();
  delete globalThis.__backStack;
  assert.equal(window.grigdeskBack, undefined);
});


test('W8: экран машин закрывается до перехода по истории', async (t) => {
  await installUiBrowser(t);

  const { installBackAction } = await compileModule(webFile('src/shared/backAction.ts'), {
    stubs: { '../ui.ts': 'export const closeTopLayer = () => false;' },
  });
  let machines = true;
  let backs = 0;
  const router = { options: { history: { state: { back: '/chats' } } }, back: () => backs += 1 };
  const dispose = installBackAction(router, () => {
    if (!machines) {
      return false;
    }

    machines = false;

    return true;
  });

  t.after(dispose);
  assert.equal(window.grigdeskBack(), true);
  assert.equal(machines, false);
  assert.equal(backs, 0);
  assert.equal(window.grigdeskBack(), true);
  assert.equal(backs, 1);
});
