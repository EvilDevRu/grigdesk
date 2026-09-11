import assert from 'node:assert/strict';
import test from 'node:test';

import {
  boardTaskListResetKey,
  selectBoardTasks,
} from '../../web/src/shared/board-task-list.js';

const tasks = [
  { id: 11, title: 'Альфа отчёт', group: 'SEO', status: 2 },
  { id: 22, title: 'Исправить форму', group: 'Frontend', status: 3 },
  { id: 33, title: 'Обновить API', group: 'Backend', status: 2 },
  { id: 44, title: 'Документация', group: 'General', status: 2 },
];

const analysisByTask = {
  11: {
    analysis: {
      complexity: 2, risk: 1, diff_size: 'S', generated_at: '2026-07-28T10:00:00Z',
      needs_clarification: false, confidence: 'high',
    },
  },
  22: {
    analysis: {
      complexity: 4, risk: 5, diff_size: 'XL', generated_at: '2026-07-29T10:00:00Z',
      needs_clarification: true, confidence: 'low',
    },
  },
  44: {
    analysis: {
      complexity: 3, risk: 2, diff_size: 'M', generated_at: '2026-07-27T10:00:00Z',
      needs_clarification: false, confidence: 'medium',
    },
  },
};

function select(overrides = {}) {
  return selectBoardTasks({
    tasks,
    analysisByTask,
    query: '',
    sortBy: 'b24',
    onlyUnrated: false,
    onlyNeedsInfo: false,
    favoriteOnly: false,
    favoriteTaskIds: [],
    newOnly: false,
    seenTaskIds: [],
    ...overrides,
  });
}

test('LIST-01: поиск работает по id, названию и группе без учёта регистра', () => {
  assert.deepEqual(select({ query: '22' }).map((task) => task.id), [22]);
  assert.deepEqual(select({ query: 'ФОРМУ' }).map((task) => task.id), [22]);
  assert.deepEqual(select({ query: 'backend' }).map((task) => task.id), [33]);
});

test('поиск соединяет слова из разных полей и одинаково читает # и е/ё', () => {
  const result = selectBoardTasks({
    tasks: [
      { id: 11, title: 'Отчёт по заявкам', group: 'Кабинет', responsible: 'Семён' },
      { id: 12, title: 'Отчёт по заявкам', group: 'Кабинет', responsible: 'Анна' },
    ],
    query: '  #11 СЕМЕН отчет кабинет  ',
  });

  assert.deepEqual(result.map((task) => task.id), [11]);
});

test('LIST-02/07: порядок B24 сохраняется и выключенное избранное его не меняет', () => {
  assert.deepEqual(select().map((task) => task.id), [11, 22, 33, 44]);
  assert.deepEqual(select({
    favoriteTaskIds: ['44', '11'],
    favoriteOnly: false,
  }).map((task) => task.id), [11, 22, 33, 44]);
});

test('LIST-03: существующие фильтры триажа сохраняют смысл', () => {
  assert.deepEqual(select({ onlyUnrated: true }).map((task) => task.id), [33]);
  assert.deepEqual(select({ onlyNeedsInfo: true }).map((task) => task.id), [22]);
});

test('LIST-04: favoriteOnly оставляет только сохранённые текущие задачи', () => {
  assert.deepEqual(select({
    favoriteOnly: true,
    favoriteTaskIds: ['44', 11, '999'],
  }).map((task) => task.id), [11, 44]);
});

test('LIST-05: избранное сочетается с поиском и триажем через AND', () => {
  assert.deepEqual(select({
    favoriteOnly: true,
    favoriteTaskIds: ['11', '22', '33'],
    query: 'front',
    onlyNeedsInfo: true,
  }).map((task) => task.id), [22]);

  assert.deepEqual(select({
    favoriteOnly: true,
    favoriteTaskIds: ['11', '22'],
    onlyUnrated: true,
  }), []);
});

test('LIST-06: сортировка применяется после фильтрации', () => {
  assert.deepEqual(select({
    favoriteOnly: true,
    favoriteTaskIds: ['11', '22', '44'],
    sortBy: 'risk',
  }).map((task) => task.id), [22, 44, 11]);
  assert.deepEqual(select({
    favoriteOnly: true,
    favoriteTaskIds: ['11', '22', '44'],
    sortBy: 'size',
  }).map((task) => task.id), [22, 44, 11]);
});

test('LIST-08: ключ сброса пагинации меняется от поиска и всех фильтров', () => {
  const base = boardTaskListResetKey({
    query: '',
    onlyUnrated: false,
    onlyNeedsInfo: false,
    favoriteOnly: false,
    newOnly: false,
    sortBy: 'b24',
    taskCount: 77,
  });
  for (const patch of [
    { query: 'api' },
    { onlyUnrated: true },
    { onlyNeedsInfo: true },
    { favoriteOnly: true },
    { newOnly: true },
    { sortBy: 'risk' },
    { taskCount: 78 },
  ]) {
    assert.notEqual(boardTaskListResetKey({
      query: '',
      onlyUnrated: false,
      onlyNeedsInfo: false,
      favoriteOnly: false,
      newOnly: false,
      sortBy: 'b24',
      taskCount: 77,
      ...patch,
    }), base);
  }
});

test('LIST-09: newOnly оставляет только непросмотренные задачи', () => {
  assert.deepEqual(select({
    newOnly: true,
    seenTaskIds: ['11', 33],
  }).map((task) => task.id), [22, 44]);

  // Отметка несуществующей задачи никого не выбрасывает, а полный список отметок
  // честно оставляет пустой результат: «новых нет» — это состояние, а не сбой.
  assert.deepEqual(select({
    newOnly: true,
    seenTaskIds: ['999'],
  }).map((task) => task.id), [11, 22, 33, 44]);
  assert.deepEqual(select({
    newOnly: true,
    seenTaskIds: ['11', '22', '33', '44'],
  }), []);
});

test('LIST-10: «новые» складываются с поиском, избранным и триажем через AND', () => {
  assert.deepEqual(select({
    newOnly: true,
    seenTaskIds: ['11'],
    query: 'обновить',
  }).map((task) => task.id), [33]);

  assert.deepEqual(select({
    newOnly: true,
    seenTaskIds: ['11'],
    favoriteOnly: true,
    favoriteTaskIds: ['11', '33'],
  }).map((task) => task.id), [33]);

  // Просмотренная задача не возвращается через триаж-фильтр.
  assert.deepEqual(select({
    newOnly: true,
    seenTaskIds: ['33'],
    onlyUnrated: true,
  }), []);
});
