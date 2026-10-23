import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { compileVue, webFile } from './helpers/compile-vue.js';
import { createUiBrowser, installUiBrowser } from './helpers/ui-components.js';
import { featureModule, tick } from './helpers/tool-window-harness.js';
import { shelfFixture, installChannels } from './helpers/tool-window-shelf.js';
import { shelfNavBadge } from '../../web/src/shared/navBadges.ts';

const runtimeBrowser = await createUiBrowser();

after(() => runtimeBrowser.close());

/**
 * Два настоящих стора общаются через настоящий продуктовый relay на тестовом канале.
 * Подмена канала не строит rows и не вызывает reconcile или alert вместо продукта.
 */
async function pairedShelf(t) {
  const channels = installChannels(t);
  const main = await shelfFixture(t);
  const mirror = await shelfFixture(t);

  assert.equal(typeof mirror.store.setViewMirror, 'function', 'У Полки нет режима проекции полных строк');
  mirror.store.setViewMirror(true);
  await main.store.load(true, { silent: true });
  await tick();

  const { startToolShelfRelay } = await featureModule('src/shared/tools/toolWindowRelay.ts');
  const mainChannel = new BroadcastChannel('test-tool-shelf');
  const childChannel = new BroadcastChannel('test-tool-shelf');
  const stopMain = startToolShelfRelay({

    role: 'source',
    channel: mainChannel,
    store: main.store,
    instance: 'tool-instance-aaaaaaaa',

  });
  const stopChild = startToolShelfRelay({

    role: 'mirror',
    channel: childChannel,
    store: mirror.store,
    instance: 'tool-instance-aaaaaaaa',

  });

  t.after(stopMain);
  t.after(stopChild);
  await tick();
  await tick();

  return {
    main,
    mirror,
    channels,
    mainChannel,
    childChannel

  };
}

/**
 * Панель использует реальные remove/acknowledge стора, а не успешные заглушки действий.
 * UI-store подменяет только открытие карточки, которое в этих тестах не требуется.
 */
async function shelfPanel(t, store) {
  await installUiBrowser(t);
  globalThis.__toolShelfPanel = store;

  const component = await compileVue(webFile('src/views/shelf/TaskShelfPanel.vue'), {
    stubs: {
      '../../stores/taskShelf.ts':
        'export const useTaskShelfStore = () => globalThis.__toolShelfPanel;',
      '../../stores/ui.ts':
        'export const useUiStore = () => ({ openTask() {} });',
    }
  });
  const { mount } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  const wrapper = mount(component, {
    props: {
      active: true,
      compact: false,
      presentation: 'page'

    }
  });

  t.after(() => {
    wrapper.unmount();
    delete globalThis.__toolShelfPanel;
  });

  return wrapper;
}

test('TW-F01: ready переносит все поля rows; badge main совпадает с полными строками child', async (t) => {
  const f = await pairedShelf(t);

  assert.ok(f.main.store.rows.length > 0, 'Фикстура main содержит готовые строки');
  assert.deepEqual(f.mirror.store.rows, f.main.store.rows);
  assert.deepEqual(shelfNavBadge(f.mirror.store.rows), shelfNavBadge(f.main.store.rows));

  const row = f.mirror.store.rows[0];

  assert.ok(row.title);
  assert.ok(row.details.project);
  assert.ok(Array.isArray(row.details.activities));

  const panel = await shelfPanel(t, f.mirror.store);

  assert.match(panel.text(), new RegExp(row.title));
  assert.match(panel.text(), new RegExp(row.details.project));
  assert.equal(panel.findAll('[data-task-id]').length, f.main.store.rows.length);
});

test(
  'TW-F02: neutral→lit оповещает только main; mirror не гидратирует и не опрашивает источники',
  async (t) => {
  const f = await pairedShelf(t);

  f.main.h.board.data.tasks[0].unread = 1;
  f.main.store.reconcile();
  await tick();
  await tick();
  assert.equal(f.main.h.alerts.length, 1);
  assert.equal(f.mirror.h.alerts.length, 0);
  assert.deepEqual(f.mirror.store.rows, f.main.store.rows);
  assert.deepEqual(
    f.mirror.h.calls,
    [],
    'Проекция не запускает портал, гидратацию или самостоятельный GET'
  );
  assert.equal(f.childChannel.posted.some((message) => message.type === 'shelf-snapshot'), false);
});

test(
  'TW-F03: реальные кнопки remove/ack синхронизируют документы; stale/scope не откатывают rows',
  async (t) => {
  const f = await pairedShelf(t);

  f.main.h.pipeline.loadedAt = 1;
  f.main.h.pipeline.observedByTask['11'] = {
    attempt: 'a1',
    gateKnown: true,
    gate: 'GATE_PLAN'

  };
  f.main.store.reconcile();
  await tick();

  const panel = await shelfPanel(t, f.mirror.store);

  await panel.get('[data-task-id="11"] button[aria-label="Отметить событие просмотренным"]').trigger('click');
  await tick();
  await tick();

  const puts = f.main.h.calls.filter((call) => call.method === 'PUT');

  assert.equal(puts.length, 1);
  assert.equal(puts[0].body.snapshot.pipeline.gate, 'GATE_PLAN');
  assert.equal(f.mirror.h.calls.some((call) => call.method === 'PUT'), false);
  assert.deepEqual(f.mirror.store.rows, f.main.store.rows);

  const old = structuredClone(f.mainChannel.posted.at(-1));

  await panel.get('[data-task-id="99"] button[aria-label="Убрать с полки"]').trigger('click');
  await tick();
  await tick();
  assert.equal(f.main.store.rows.some((row) => row.taskId === '99'), false);
  assert.deepEqual(f.mirror.store.rows, f.main.store.rows);
  f.childChannel.onmessage({ data: old });
  await tick();
  assert.equal(f.mirror.store.rows.some((row) => row.taskId === '99'), false);
  assert.deepEqual(f.mirror.store.sourceIssues, f.main.store.sourceIssues);
  f.main.store.clear();
  await tick();
  assert.deepEqual(f.mirror.store.rows, []);
});
