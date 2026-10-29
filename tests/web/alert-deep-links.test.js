import assert from 'node:assert/strict';
import test from 'node:test';

import {
  reactive
} from '../../web/node_modules/vue/index.mjs';
import {
  compileModule,
  webFile
} from './helpers/compile-vue.js';

const api = await compileModule(webFile('src/shared/alertDeepLinks.ts'));

/**
 * Поддельный маршрут ведёт себя как настоящий: replace меняет путь и query,
 * и watch модуля видит это изменение, как в браузере.
 */
function deps(reactive, path, query) {
  const route = reactive({
    path,
    query,
  });
  const calls = {

    push: [],

    replace: [],

    revealed: [],

    opened: [],

  };

  return {
    calls,
    deps: {

      route,

      router: {
        push(location) {
          calls.push.push(location);
        },
        replace(location) {
          calls.replace.push(location);
          route.path = location.path;
          route.query = location.query;
        },
      },

      chat: {
        async revealChat(id) {
          calls.revealed.push(id);

          return true;
        },
      },

      ui: {
        openTask(id) {
          calls.opened.push(id);
        },
      },

    },
  };
}

test('D1: чат и конвейер переходят, задача открывается поверх раздела', () => {
  const h = deps(reactive, '/board', {});

  api.openAlertTarget({
    kind: 'chat',
    chatId: 'c1'
  }, h.deps);
  api.openAlertTarget({
    kind: 'pipeline',
    taskId: '42'
  }, h.deps);
  api.openAlertTarget({
    kind: 'task',
    taskId: '42'
  }, h.deps);
  assert.deepEqual(h.calls.push, [{
      path: '/chats',
      query: {
        openChat: 'c1'
      }
    },
    {
      path: '/pipeline'
    },
  ]);
  assert.deepEqual(h.calls.opened, ['42']);
});

test('studio открывает /3d с точной моделью и версией', () => {
  const h = deps(reactive, '/chats', {});

  api.openAlertTarget({
    kind: 'studio',
    modelId: 'fixture-model',
    versionId: 'v01-model'
  }, h.deps);
  assert.deepEqual(h.calls.push, [{ path: '/3d', query: { model: 'fixture-model', version: 'v01-model' } }]);
});

test('D2: ссылка чата поглощается один раз', async (t) => {
  const h = deps(reactive, '/chats', {
    openChat: 'c1'
  });
  const stop = api.installAlertDeepLinks(h.deps);

  t.after(stop);
  await new Promise(setImmediate);
  assert.deepEqual(h.calls.revealed, ['c1']);
  assert.deepEqual(h.calls.replace, [{
    path: '/chats',
    query: {}
  }]);
});

test('D2: ссылка задачи открывает карточку', async (t) => {
  const h = deps(reactive, '/shelf', {
    openTask: '42'
  });
  const stop = api.installAlertDeepLinks(h.deps);

  t.after(stop);
  await new Promise(setImmediate);
  assert.deepEqual(h.calls.opened, ['42']);
  assert.deepEqual(h.calls.replace, [{
    path: '/shelf',
    query: {}
  }]);
});

test('D3: обычные query-параметры остаются в адресе', async (t) => {
  const h = deps(reactive, '/diff', {
    task: '7',
    openTask: '42'
  });
  const stop = api.installAlertDeepLinks(h.deps);

  t.after(stop);
  await new Promise(setImmediate);
  assert.deepEqual(h.calls.replace, [{
    path: '/diff',
    query: {
      task: '7'
    }
  }]);
});

test('D4: остановленная подписка не открывает новый чат', async () => {
  const h = deps(reactive, '/chats', {});
  const stop = api.installAlertDeepLinks(h.deps);

  stop();
  h.deps.route.query = {
    openChat: 'c2'
  };
  await new Promise(setImmediate);
  assert.deepEqual(h.calls.revealed, []);
});

test('PM-PLUGIN-OPEN: без открывалки plugin-цель не уходит в конвейер', () => {
  const h = deps(reactive, '/chats', {});

  api.openAlertTarget({ kind: 'plugin', pluginId: 'ui-module' }, h.deps);
  assert.deepEqual(h.calls.push, []);
});

test('PM-PLUGIN-OPEN: bridge открывает свой инструмент, cleanup не снимает чужой callback', () => {
  assert.equal(typeof api.setPluginAlertOpener, 'function', 'Не реализован bridge plugin-цели');

  const h = deps(reactive, '/chats', {});
  const opened = [];
  const old = api.setPluginAlertOpener((id) => opened.push(['old', id]));
  const current = api.setPluginAlertOpener((id) => {
    if (id === 'ui-module') {
      opened.push(['new', id]);

      return true;
    }

    return false;
  });

  old();
  api.openAlertTarget({ kind: 'plugin', pluginId: 'ui-module' }, h.deps);
  api.openAlertTarget({ kind: 'plugin', pluginId: 'disabled' }, h.deps);
  current();
  api.openAlertTarget({ kind: 'plugin', pluginId: 'ui-module' }, h.deps);
  assert.deepEqual(opened, [['new', 'ui-module']]);
  assert.deepEqual(h.calls.push, []);
});
