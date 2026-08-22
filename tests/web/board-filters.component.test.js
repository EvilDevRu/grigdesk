// Проверяет доступность и поведение фильтров доски задач.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { mountBoardView } from './helpers/board-view.js';

process.env.NODE_ENV = 'test';

const VIEW_PATH = new URL('../../web/src/views/BoardView.vue', import.meta.url);
const GLOBAL_STYLES_PATH = new URL('../../web/src/styles.css', import.meta.url);

const TASKS = [
  { id: 11, title: 'Первая задача', group: 'A', timerElapsed: 0 },
  { id: 22, title: 'Вторая задача', group: 'B', timerElapsed: 0 },
];

test('BOARD-FILTERS-01: панель подписана, раскрывается и различает фильтры от поиска', async (t) => {
  const { wrapper } = await mountBoardView(t, {
    prefix: 'board-filters-accessibility',
    tasks: TASKS,
    toReview: [{ id: 33, title: 'Проверить результат' }],
  });

  assert.equal(wrapper.findAll('.col.secondary').length, 1,
    'fixture воспроизводит проблемную раскладку с правой колонкой');
  assert.equal(wrapper.get('.search input').attributes('aria-label'), 'Поиск по задачам');
  assert.equal(wrapper.get('.sort-filter').element.tagName, 'LABEL');
  assert.equal(wrapper.get('#board-task-filters').attributes('aria-label'), 'Фильтры задач');
  assert.equal(wrapper.get('.batch-actions').attributes('aria-label'), 'Массовые действия с задачами');
  assert.notEqual(wrapper.get('.triage-all').element.closest('#board-task-filters'), null,
    'на узком экране действие должно сворачиваться вместе с панелью');
  assert.equal(wrapper.get('.triage-all').attributes('aria-pressed'), undefined,
    'команда не выдаёт себя за переключатель состояния');
  assert.equal(wrapper.get('.triage-all').classes().includes('trif'), false,
    'кнопка массового действия не наследует стиль переключателя фильтра');

  const toggle = wrapper.get('.filter-toggle');
  assert.equal(toggle.attributes('aria-controls'), 'board-task-filters');
  assert.equal(toggle.attributes('aria-expanded'), 'false');
  await toggle.trigger('click');
  assert.equal(toggle.attributes('aria-expanded'), 'true');
  assert.equal(wrapper.get('#board-task-filters').classes().includes('expanded'), true);

  assert.equal(wrapper.get('.trisegment .trif').attributes('aria-pressed'), 'true');
  assert.equal(wrapper.get('.unrated-filter').attributes('aria-pressed'), 'false');
  assert.equal(wrapper.get('.needs-info-filter').attributes('aria-pressed'), 'false');
});

test('BOARD-FILTERS-02: режим триажа взаимоисключающий, счётчик и общий сброс честные', async (t) => {
  const { wrapper, flushPromises } = await mountBoardView(t, {
    prefix: 'board-filters-reset',
    tasks: TASKS,
    favorites: { taskIds: ['11'] },
    seen: { taskIds: ['22'] },
    analysis: {
      22: { analysis: { risk: 5, needs_clarification: true, confidence: 'low' } },
    },
  });

  await wrapper.get('.favfilter').trigger('click');
  await wrapper.get('.newfilter').trigger('click');
  await wrapper.get('.unrated-filter').trigger('click');
  await wrapper.get('.trisort').setValue('risk');
  await flushPromises();

  assert.equal(wrapper.findAll('li.trow').length, 1);
  assert.match(wrapper.get('.h.big .cnt').text(), /1\s+из\s+2/);
  assert.equal(wrapper.get('.filter-count').text(), '4');
  assert.equal(wrapper.get('.unrated-filter').attributes('aria-pressed'), 'true');

  await wrapper.get('.needs-info-filter').trigger('click');
  await flushPromises();
  assert.equal(wrapper.get('.unrated-filter').attributes('aria-pressed'), 'false');
  assert.equal(wrapper.get('.needs-info-filter').attributes('aria-pressed'), 'true');
  assert.equal(wrapper.findAll('li.trow').length, 0,
    'режим уточнений не отменяет независимые фильтры избранного и новых');

  await wrapper.get('.search input').setValue('Вторая');
  await wrapper.get('.filter-reset').trigger('click');
  await flushPromises();
  assert.equal(wrapper.get('.search input').element.value, '');
  assert.equal(wrapper.get('.trisort').element.value, 'b24');
  assert.equal(wrapper.get('.favfilter').attributes('aria-pressed'), 'false');
  assert.equal(wrapper.get('.newfilter').attributes('aria-pressed'), 'false');
  assert.equal(wrapper.get('.trisegment .trif').attributes('aria-pressed'), 'true');
  assert.equal(wrapper.findAll('li.trow').length, 2);
  assert.equal(wrapper.get('.h.big .cnt').text().trim(), '2');
  assert.equal(wrapper.findAll('.filter-reset').length, 0);
});

test('BOARD-FILTERS-03: повреждённые сохранённые настройки не роняют доску', async (t) => {
  const { wrapper } = await mountBoardView(t, {
    prefix: 'board-filters-bad-storage',
    tasks: TASKS,
    triagePrefs: '{сломанный json',
  });

  assert.equal(wrapper.get('.trisort').element.value, 'b24');
  assert.equal(wrapper.get('.trisegment .trif').attributes('aria-pressed'), 'true');
  assert.equal(wrapper.findAll('li.trow').length, 2);
});

test('BOARD-FILTERS-04: раскладка зависит от контейнера и не создаёт несжимаемый тулбар', async () => {
  const [source, globalStyles] = await Promise.all([
    readFile(VIEW_PATH, 'utf8'),
    readFile(GLOBAL_STYLES_PATH, 'utf8'),
  ]);

  assert.match(globalStyles, /--control-height:\s*36px;/);
  assert.doesNotMatch(globalStyles, /--control-height-touch:/,
    'адаптив меняет раскладку всей панели, а не высоту отдельных контролов');
  assert.match(globalStyles, /--control-radius:\s*9px;/);
  assert.match(source, /\.cols\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap;[^}]*min-width:\s*0;/s);
  assert.match(source, /\.col\.primary\s*\{[^}]*container:\s*board-primary\s*\/\s*inline-size;/s);
  assert.match(source, /\.filterbar\s*\{[^}]*flex-wrap:\s*wrap;[^}]*min-width:\s*0;[^}]*max-width:\s*100%;/s);
  assert.match(source, /@container\s+board-primary\s*\(max-width:\s*720px\)/);
  assert.match(source, /\.filterbar\.expanded\s*\{\s*display:\s*flex;/);
  assert.match(source, /\.batch-actions\s*\{[^}]*border-left:\s*1px solid var\(--line\);/s);
  assert.match(source, /\.batch-action\s*\{[^}]*background:\s*var\(--accent\);/s);
  assert.match(source, /\.filter-toggle,\s*\.trisort,\s*\.trif,\s*\.search,\s*\.batch-action\s*\{[^}]*height:\s*var\(--control-height\);[^}]*min-height:\s*var\(--control-height\);[^}]*border-radius:\s*var\(--control-radius\);[^}]*white-space:\s*nowrap;/s);
  assert.match(source, /\.periods button\s*\{[^}]*height:\s*var\(--control-height\);[^}]*border-radius:\s*var\(--control-radius\);/s);
  assert.doesNotMatch(source, /control-height-touch/);
  assert.doesNotMatch(source, /@media\s*\(min-width:\s*860px\)/,
    'две колонки не должны включаться по viewport без учёта sidebar и dock');
});
