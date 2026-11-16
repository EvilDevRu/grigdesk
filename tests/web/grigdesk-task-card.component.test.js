import assert from 'node:assert/strict';
import test from 'node:test';

import { LOCAL_TASK } from './helpers/grigdesk-task-card.js';
import { mountTrackerCard, STOCK_CAPS } from './helpers/trackerCard.js';

for (const presentation of ['dialog', 'document']) {
  test(`OWN-REMOVED-LINK: ${presentation} показывает отсутствие без побочных эффектов`, async (t) => {
    const fx = await mountTrackerCard(t, {
      id: LOCAL_TASK.id,
      detail: LOCAL_TASK,
      presentation,
      openReference: `grigdesk:${LOCAL_TASK.id}`,
    });

    assert.match(fx.wrapper.text(), /Задача не найдена/u);
    assert.equal(fx.calls.some((call) => call.url?.startsWith('/api/grigdesk-tasks')), false);

    const taskEffects = fx.calls.filter((call) =>
      /\/task\/|\/analysis|\/clarifications/u.test(call.url ?? ''));

    assert.deepEqual(taskEffects, []);
    assert.equal(fx.calls.some((call) => ['PERSONAL', 'ANALYSIS', 'POST', 'PUT', 'DELETE']
      .includes(call.method)), false);

    await fx.ui.openTask(LOCAL_TASK.id);
    await fx.flushPromises();
    assert.match(fx.wrapper.text(), /Следующая внешняя задача/u);
    assert.ok(fx.calls.some((call) => call.url === `/api/tracker/task/${LOCAL_TASK.id}`));

    fx.ui.close();
    await fx.flushPromises();
    await fx.ui.openTask('42');
    await fx.flushPromises();
    assert.equal(fx.ui.taskId, '42');
    assert.match(fx.wrapper.text(), /Следующая внешняя задача/u);
    assert.ok(fx.calls.some((call) => call.url === '/api/tracker/task/42'));
  });
}

for (const addressed of [false, true]) {
  test(`OWN-REMOVED-BARE-ID: ${addressed ? 'внешний' : 'bare'} 12-значный номер сразу идёт в tracker`,
    async (t) => {
      const source = `grigdesk-b24-discript@${'a'.repeat(64)}`;
      const catalog = {
        revision: 1,
        enabledIds: ['grigdesk-b24-discript'],
        activeIds: ['grigdesk-b24-discript'],
        default: 'grigdesk-b24-discript',
        externalId: 'grigdesk-b24-discript',
        drivers: [{
          id: 'grigdesk-b24-discript',
          name: 'Внешняя доска',
          status: 'active',
          configured: true,
          source,
          generation: 1,
          capabilities: STOCK_CAPS,
        }],
      };
      const fx = await mountTrackerCard(t, {
        id: '100000000001',
        ...(addressed ? { taskSource: source, catalog } : {}),
      });
      const details = fx.calls.filter((call) => call.method === 'GET'
        && /grigdesk-tasks|\/task\/\d+$/u.test(call.url));
      const prefix = addressed ? '/api/tracker/grigdesk-b24-discript' : '/api/tracker';

      assert.deepEqual(details.map((call) => call.url), [`${prefix}/task/100000000001`]);
      assert.match(fx.wrapper.text(), /Задача трекера/u);
    });
}
