import assert from 'node:assert/strict';
import test from 'node:test';
import { installUiBrowser } from './helpers/ui-components.js';
import { surfaceUrl, surfaceTargetFromUrl, } from '../../shared/desktop/surfaceContract.ts';

test('SC-04: настоящий hash history сохраняет канонический target до App.setup', async (t) => {
  const origin = 'http://127.0.0.1:47101';
  const target = { kind: 'task', id: '42' };
  const browser = await installUiBrowser(t, surfaceUrl(origin, target));
  const previousHistory = Object.getOwnPropertyDescriptor(globalThis, 'history');

  Object.defineProperty(globalThis, 'history', {
    value: browser.history,
    configurable: true,
    writable: true,
  });
  t.after(() => {
    if (previousHistory) {
      Object.defineProperty(globalThis, 'history', previousHistory);
    }
    else {
      Reflect.deleteProperty(globalThis, 'history');
    }
  });

  const { createRouter, createWebHashHistory } = await import(
    '../../web/node_modules/vue-router/dist/vue-router.mjs'
  );
  const history = createWebHashHistory();
  const router = createRouter({
    history,
    routes: [{ path: '/surface', component: { render: () => null } }],
  });

  t.after(() => history.destroy());
  await router.push('/surface');
  await router.isReady();
  assert.deepEqual(surfaceTargetFromUrl(browser.location.href, origin), target);
  assert.equal(browser.location.hash, '#/surface');
});
