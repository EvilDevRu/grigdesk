// Метка «новая» и фильтр «новые» на доске. Новая — та, которую ещё не открывали;
// отметки просмотра серверные, поэтому без загруженной базовой линии новых не бывает
// вовсе (иначе после первого запуска новыми выглядели бы все давние задачи).
import assert from 'node:assert/strict';
import test from 'node:test';
import { mountBoardView } from './helpers/board-view.js';

process.env.NODE_ENV = 'test';

const TASKS = [
  { id: 11, title: 'Новая задача', group: 'A', timerElapsed: 0 },
  { id: 22, title: 'Просмотренная задача', group: 'B', timerElapsed: 0 },
];

test('BOARD-NEW-01: метка стоит только у непросмотренной задачи, счётчик считает по всей доске', async (t) => {
  const { wrapper, calls } = await mountBoardView(t, {
    prefix: 'board-new-badge',
    tasks: TASKS,
    seen: { taskIds: ['22'] },
  });

  const rows = wrapper.findAll('li.trow');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].findAll('.newbadge').length, 1);
  assert.equal(rows[1].findAll('.newbadge').length, 0);
  const badge = rows[0].get('.newbadge');
  assert.equal(badge.text(), 'Новая');
  assert.equal(badge.attributes('aria-label'), 'Новая задача — ещё не открывали');

  await rows[0].get('button.ttext').trigger('click');
  assert.deepEqual(calls.opened, ['11']);
  assert.deepEqual(calls.seenMarked, [], 'отметку просмотра сохраняет карточка задачи');

  const filter = wrapper.get('button.newfilter');
  assert.match(filter.text(), /Новые\s*1/);
  assert.equal(filter.attributes('aria-pressed'), 'false');
  assert.equal(filter.attributes('disabled'), undefined);

  // Доска сама просит отметки при открытии — иначе метки появлялись бы только после
  // фонового поллинга всего приложения.
  assert.deepEqual(calls.seenLoad, [true]);
});

test('BOARD-NEW-02: фильтр оставляет только новые и объясняет пустой список', async (t) => {
  const { wrapper, flushPromises } = await mountBoardView(t, {
    prefix: 'board-new-filter',
    tasks: TASKS,
    seen: { taskIds: ['22'] },
  });

  const filter = wrapper.get('button.newfilter');
  await filter.trigger('click');
  await flushPromises();
  assert.equal(filter.attributes('aria-pressed'), 'true');
  assert.equal(filter.classes().includes('is-pressed'), true);
  const rows = wrapper.findAll('li.trow');
  assert.equal(rows.length, 1);
  assert.match(rows[0].text(), /Новая задача/);

  // Фильтры складываются по И: поиск по просмотренной задаче не воскрешает её.
  await wrapper.get('.search input').setValue('Просмотренная');
  await flushPromises();
  assert.equal(wrapper.findAll('li.trow').length, 0);
  assert.match(wrapper.get('li.empty').text(), /не подходят под поиск/);

  await wrapper.get('.search input').setValue('');
  await flushPromises();
  await filter.trigger('click');
  await flushPromises();
  assert.equal(wrapper.findAll('li.trow').length, 2);
});

test('BOARD-NEW-03: всё просмотрено — фильтр честно говорит, что новых нет', async (t) => {
  const { wrapper, flushPromises } = await mountBoardView(t, {
    prefix: 'board-new-empty',
    tasks: TASKS,
    seen: { taskIds: ['11', '22'] },
  });

  const filter = wrapper.get('button.newfilter');
  assert.match(filter.text(), /Новые\s*0/);
  assert.equal(wrapper.findAll('.newbadge').length, 0);

  await filter.trigger('click');
  await flushPromises();
  assert.equal(wrapper.findAll('li.trow').length, 0);
  assert.match(wrapper.get('li.empty').text(), /Новых задач нет/);
});

test('BOARD-NEW-04: без базовой линии новых не бывает, а кнопка ждёт сервер', async (t) => {
  const { wrapper } = await mountBoardView(t, {
    prefix: 'board-new-baseline',
    tasks: TASKS,
    seen: { taskIds: [], loaded: true, initialized: false },
  });

  assert.equal(wrapper.findAll('.newbadge').length, 0);
  const filter = wrapper.get('button.newfilter');
  assert.equal(filter.attributes('disabled'), '');
  assert.match(filter.text(), /Новые\s*0/);
  assert.match(filter.attributes('title'), /загружаются/);
  assert.equal(wrapper.findAll('li.trow').length, 2);
});

test('BOARD-NEW-05: отказ отметок виден плашкой, а не молчанием', async (t) => {
  const { wrapper, calls } = await mountBoardView(t, {
    prefix: 'board-new-error',
    tasks: TASKS,
    seen: { taskIds: [], loaded: false, initialized: false, error: 'отметки недоступны' },
  });

  const alerts = wrapper.findAll('[role="alert"]');
  const seenAlert = alerts.find((node) => node.text().includes('Отметки просмотра'));
  assert.ok(seenAlert, 'плашка об отказе отметок должна быть на экране');
  assert.match(seenAlert.text(), /отметки недоступны/);
  // Метки без ответа сервера не рисуем: пустой набор — это «не знаем», а не «всё новое».
  assert.equal(wrapper.findAll('.newbadge').length, 0);

  await seenAlert.get('button').trigger('click');
  assert.deepEqual(calls.seenLoad, [true, true]);
});
