import assert from 'node:assert/strict';
import test from 'node:test';

import { mountBoardView } from './helpers/board-view.js';

process.env.NODE_ENV = 'test';

test('STALE-01: ошибка обновления сохраняет задачи, время и явное предупреждение', async (t) => {
  const { wrapper, flushPromises } = await mountBoardView(t, {
    prefix: 'board-stale',
    boardError: 'fixture refresh failed',
    tasks: [{
      id: 42,
      title: 'Сохранённая задача',
      group: 'A',
      timerElapsed: 0,
    }],
  });

  assert.equal(wrapper.findAll('li.trow').length, 1);
  assert.match(wrapper.text(), /Сохранённая задача/u);
  assert.match(wrapper.get('[data-role="board-snapshot-status"]').text(), /последние полученные/u);
  assert.ok(wrapper.get('[data-role="board-snapshot-status"] time').attributes('datetime'));

  // Ошибка является состоянием реального стора view, а не собственной копией компонента.
  globalThis.__boardViewStores.board().error = null;
  await flushPromises();
  assert.equal(wrapper.findAll('li.trow').length, 1);
  assert.doesNotMatch(wrapper.get('[data-role="board-snapshot-status"]').text(), /последние полученные/u);
});

test('STALE-02: ошибка первого чтения не выдаёт отсутствующий снимок за данные', async (t) => {
  const { wrapper, flushPromises, stores } = await mountBoardView(t, {
    prefix: 'board-no-snapshot',
    pending: true,
    boardError: 'fixture initial failure',
  });

  assert.equal(wrapper.findAll('li.trow').length, 0);
  assert.equal(wrapper.find('[data-role="board-snapshot-status"]').exists(), false);
  assert.match(wrapper.get('.board-tracker-error').text(), /Не удалось обновить задачи трекера/u);
  assert.equal(wrapper.find('.board-tracker-error-details').exists(), false);
  await wrapper.get('.board-tracker-error .ui-disclosure-button').trigger('click');
  await flushPromises();
  assert.equal(wrapper.get('.board-tracker-error-details').text(), 'fixture initial failure');

  const refreshes = [];

  assert.equal(wrapper.get('.board-tracker-error button[data-variant="text"]').attributes('disabled'), '');
  stores.board().loading = false;
  await flushPromises();

  stores.board().load = async (force) => {
    refreshes.push(force);
  };
  await wrapper.get('.board-tracker-error button[data-variant="text"]').trigger('click');
  await flushPromises();
  assert.deepEqual(refreshes, [true]);
});
