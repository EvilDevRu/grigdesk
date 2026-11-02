import assert from 'node:assert/strict';
import test from 'node:test';

import { deadlineState, formatDateTime } from '../../web/src/shared/format.ts';
import { connectUiLocalePort } from '../../web/src/shared/uiLocalePort.ts';
import { taskAvatar, taskChecklist, taskPeopleNames } from '../../web/src/shared/taskCardFields.ts';
import { decodeTaskSubtasks, decodeTaskTags } from '../../web/src/shared/boardContracts.ts';

const ISO = '2026-11-05T19:00:00+07:00';

test('Дата со смещением форматируется в локальном времени и на языке UI', (t) => {
  const previousZone = process.env.TZ;

  process.env.TZ = 'Asia/Novosibirsk';
  t.after(() => {
    if (previousZone === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = previousZone;
    }

    connectUiLocalePort('ru');
  });
  connectUiLocalePort('ru');
  assert.equal(formatDateTime(ISO), '5 ноя 2026, 19:00');
  process.env.TZ = 'UTC';
  assert.equal(formatDateTime(ISO), '5 ноя 2026, 12:00');
  connectUiLocalePort('en');
  assert.match(formatDateTime(ISO), /Nov 5, 2026, 12:00/u);
});

test('Пустой или ошибочный срок не показывает дату и срочность', () => {
  for (const value of ['', ' ', 'invalid', '05.11.2026', null, undefined, false]) {
    assert.equal(formatDateTime(value), '');
    assert.equal(deadlineState(value, Date.now()), null);
  }

  assert.equal(deadlineState(ISO, NaN), null);
});

test('Срочность учитывает локальную полночь и прошедшие часы сегодня', (t) => {
  const previousZone = process.env.TZ;

  process.env.TZ = 'Asia/Novosibirsk';
  t.after(() => {
    if (previousZone === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = previousZone;
    }
  });

  const now = Date.parse('2026-11-05T00:10:00+07:00');

  assert.equal(deadlineState('2026-11-05T00:20:00+07:00', now), 'today');
  assert.equal(deadlineState('2026-11-05T00:00:00+07:00', now), 'over');
  assert.equal(deadlineState('2026-11-06T00:00:00+07:00', now), null);
  assert.equal(deadlineState('2026-11-04T17:20:00Z', now), 'today');
  assert.equal(deadlineState(new Date(now).toISOString(), now), 'today');
});

test('Участники и аватары защищены от повреждённых REST-полей', () => {
  assert.equal(taskPeopleNames([{ name: 'Анна' }, null, { name: false }, { name: 'Борис' }]), 'Анна, Борис');
  assert.equal(taskPeopleNames({ 1: { name: 'Анна' }, 2: { name: 'Борис' } }), 'Анна, Борис');
  assert.equal(taskPeopleNames(null), '');
  assert.equal(taskAvatar('https://avatar.fixture/a.png'), 'https://avatar.fixture/a.png');

  for (const value of ['http://avatar.fixture/a.png', '//avatar.fixture/a.png',
    'javascript:alert(1)', 'https://name:secret@avatar.fixture', null]) {
    assert.equal(taskAvatar(value), '');
  }
});

test('Чек-лист строит и сортирует дерево, считает Y и не зацикливается', () => {
  const result = taskChecklist({
    4: {
      id: 4,
      parentId: '2',
      title: 'Второй ребёнок',
      sortIndex: 20,
      isComplete: 'N',
    },
    3: {
      id: 3,
      parentId: 2,
      title: 'Первый ребёнок',
      sortIndex: 10,
      isComplete: 'Y',
    },
    2: {
      id: 2,
      parentId: '0',
      title: 'Группа',
      sortIndex: 20,
      isImportant: 'Y',
    },
    1: {
      id: 1,
      parentId: 0,
      title: 'Начало',
      sortIndex: 10,
      isComplete: 'Y',
    },
    5: {
      id: 5,
      parentId: 99,
      title: 'Сирота',
      sortIndex: 30,
      isComplete: true,
    },
    6: {
      id: 6,
      parentId: 7,
      title: 'Цикл 1',
    },
    7: {
      id: 7,
      parentId: 6,
      title: 'Цикл 2',
    },
    8: null,
  });

  assert.deepEqual(result.rows.map((row) => row.id), ['1', '2', '3', '4', '5', '6', '7']);
  assert.deepEqual(result.rows.map((row) => row.depth), [0, 0, 1, 1, 0, 0, 1]);
  assert.equal(result.complete, 1);
  assert.equal(result.total, 3);
  assert.equal(result.rows[1].important, true);
  assert.deepEqual(taskChecklist({}), {
    rows: [],
    complete: 0,
    total: 0,
  });
  assert.deepEqual(taskChecklist(null), {
    rows: [],
    complete: 0,
    total: 0,
  });
});

test('Необязательные page-расширения сохраняют совместимость contract 1', () => {
  const subtasks = [{
    id: 42,
    title: 'Задача',
    statusText: 'В работе',
  }];

  assert.deepEqual(decodeTaskTags({ tags: ['Релиз'] }), ['Релиз']);
  assert.deepEqual(decodeTaskSubtasks({ subtasks }), subtasks);

  for (const value of [null, {}, { comments: [] }, { tags: [null], subtasks: [{}] }]) {
    assert.deepEqual(decodeTaskTags(value), []);
    assert.deepEqual(decodeTaskSubtasks(value), []);
  }
});
