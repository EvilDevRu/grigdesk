import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

test('Полка обводит существующую точку и не меняет состав доски или звезду', async (t) => {
  const { wrapper } = await mountBoardView(t, {
    prefix: 'board-shelf',
    tasks: [
      { id: 11, title: 'На полке и в избранном', group: 'A', timerElapsed: 0 },
      { id: 22, title: 'Обычная задача', group: 'B', timerElapsed: 0 },
    ],
    favorites: { taskIds: ['11'] },
    shelf: { entries: [{ taskId: '11' }] },
  });
  const rows = wrapper.findAll('li.trow');
  const statusDots = wrapper.findAll('.tstat');
  const source = await readFile(
    new URL('../../web/src/views/BoardView.vue', import.meta.url),
    'utf8',
  );

  assert.deepEqual({
    rowCount: rows.length,
    statusDotCount: statusDots.length,
    firstOnShelf: statusDots[0]?.classes().includes('on-shelf'),
    secondOnShelf: statusDots[1]?.classes().includes('on-shelf'),
    firstFavorite: rows[0]?.get('button.stub-fav').attributes('aria-pressed'),
    outlineDeclared: /\.tstat\.on-shelf[\s\S]{0,240}outline\s*:/.test(source),
  }, {
    rowCount: 2,
    statusDotCount: 2,
    firstOnShelf: true,
    secondOnShelf: false,
    firstFavorite: 'true',
    outlineDeclared: true,
  });
});

test('Живой гейт плагина включает и снимает обводку, не меняя доску', async (t) => {
  const { wrapper, flushPromises, stores } = await mountBoardView(t, {
    prefix: 'board-shelf-disabled',
    tasks: [{ id: 11, title: 'Сохранена на полке', group: 'A', timerElapsed: 0 }],
    shelf: { entries: [{ taskId: '11' }] },
  });
  const beforeDisable = wrapper.get('.tstat').classes().includes('on-shelf');
  stores.plugins().list[0].enabled = false;
  await flushPromises();

  assert.deepEqual({
    rowCount: wrapper.findAll('li.trow').length,
    outlineStates: [
      beforeDisable,
      wrapper.get('.tstat').classes().includes('on-shelf'),
    ],
  }, {
    rowCount: 1,
    outlineStates: [true, false],
  });
});
