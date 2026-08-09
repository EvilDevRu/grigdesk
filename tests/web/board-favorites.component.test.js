import assert from 'node:assert/strict';
import test from 'node:test';
import { mountBoardView } from './helpers/board-view.js';

process.env.NODE_ENV = 'test';

test('UI-04/07: BoardView переключает favoriteOnly и передаёт строке правильную задачу', async (t) => {
  const { wrapper, flushPromises, calls } = await mountBoardView(t, {
    prefix: 'board-favorites',
    tasks: [
      { id: 11, title: 'Избранная задача', group: 'A', timerElapsed: 0 },
      { id: 22, title: 'Обычная задача', group: 'B', timerElapsed: 0 },
    ],
    favorites: { taskIds: ['11'] },
  });

  assert.equal(wrapper.findAll('li.trow').length, 2);
  const filter = wrapper.get('button.favfilter');
  assert.match(filter.text(), /1/);
  assert.equal(filter.attributes('aria-pressed'), 'false');

  const projectBadges = wrapper.findAll('.project-badge');
  assert.deepEqual(projectBadges.map((badge) => badge.text()), ['A', 'B']);
  assert.equal(projectBadges[0].attributes('title'), 'Проект: A');
  assert.equal(projectBadges[0].attributes('aria-label'), 'Проект: A');
  const firstRowChildren = [...wrapper.get('li.trow').element.children];
  assert.ok(firstRowChildren.indexOf(wrapper.get('button.stub-fav').element)
    < firstRowChildren.indexOf(projectBadges[0].element));
  assert.ok(firstRowChildren.indexOf(projectBadges[0].element)
    < firstRowChildren.indexOf(wrapper.get('button.ttext').element));

  await filter.trigger('click');
  await flushPromises();
  assert.equal(filter.attributes('aria-pressed'), 'true');
  assert.equal(wrapper.findAll('li.trow').length, 1);
  assert.match(wrapper.get('li.trow').text(), /Избранная задача/);

  await wrapper.get('button.stub-fav').trigger('click');
  assert.deepEqual(calls.toggled, ['11']);
});
