import assert from 'node:assert/strict';
import test from 'node:test';

import { statusOverflow, statusSummaryLayout } from '../../web/src/views/chat/chatStatusLayout.ts';

const facts = {
  modelKind: 'выбрана',
  modelLabel: 'Opus 5.5',
  cwd: '/home/user/Workspace/grigdesk',
  extraDirs: [],
  usageItems: [
    {
      key: 'session',
      label: 'Сессия (5ч)',
      value: '96%',
    },
    {
      key: 'week',
      label: 'Неделя',
      value: '40%',
    },
    {
      key: 'opus',
      label: 'Opus',
      value: '70%',
    },
  ],
};

test('STATUS-LAYOUT-01: на широкой строке видно всё, включая третье окно лимита', () => {
  const layout = statusSummaryLayout(600, 3);

  assert.deepEqual(layout, {
    model: true,
    kind: true,
    cwd: true,
    labels: true,
    windows: 3,
  });
  assert.deepEqual(statusOverflow(layout, facts), []);
});

test('STATUS-LAYOUT-01b: окна сверх двух уходят по замеру первыми, но не ниже двух', () => {
  const layout = statusSummaryLayout(600, 3, { windows: 1 });

  assert.equal(layout.windows, 2);
  assert.equal(layout.cwd, true, 'папка уходит только после лишних окон');
  assert.deepEqual(statusOverflow(layout, facts).map((entry) => entry.key), ['usage:opus']);
  assert.equal(statusSummaryLayout(600, 3, { windows: 5 }).windows, 2);
});

test('STATUS-LAYOUT-02: при нехватке места уходят папка, потом модель, потом подписи', () => {
  assert.deepEqual(
    statusOverflow(statusSummaryLayout(300, 3), facts).map((entry) => entry.key),
    ['usage:week', 'usage:opus'],
  );
  assert.deepEqual(
    statusOverflow(statusSummaryLayout(200, 3), facts).map((entry) => entry.key),
    ['cwd', 'usage:week', 'usage:opus'],
  );
  assert.deepEqual(
    statusOverflow(statusSummaryLayout(120, 3), facts).map((entry) => entry.key),
    ['model', 'cwd', 'usage:week', 'usage:opus'],
  );

  const tiny = statusOverflow(statusSummaryLayout(80, 3), facts);

  assert.deepEqual(
    tiny.map((entry) => entry.key),
    ['model', 'cwd', 'usage:session', 'usage:week', 'usage:opus'],
  );
  assert.deepEqual(tiny[0], {
    key: 'model',
    label: 'Модель',
    value: 'выбрана Opus 5.5',
  });
  assert.equal(tiny[1].value, '/home/user/Workspace/grigdesk', 'во всплывашке путь полный');
  assert.equal(tiny[2].label, 'Сессия (5ч)', 'окно без подписи в строке получает её во всплывашке');
});

test('STATUS-LAYOUT-03: без лимитов модель не прячется — иначе блок опустел бы', () => {
  const layout = statusSummaryLayout(100, 0);

  assert.equal(layout.model, true);
  assert.equal(layout.cwd, false);
  assert.deepEqual(
    statusOverflow(layout, { ...facts, usageItems: [] }).map((entry) => entry.key),
    ['cwd'],
  );
});

test('STATUS-LAYOUT-04: дополнительные каталоги в строку не входят никогда', () => {
  const entries = statusOverflow(statusSummaryLayout(600, 3), {
    ...facts,
    usageItems: facts.usageItems.slice(0, 1),
    extraDirs: ['/srv/shared', '/srv/docs'],
  });

  assert.deepEqual(entries, [{
    key: 'extra-dirs',
    label: 'Доп. каталоги',
    value: '/srv/shared, /srv/docs',
  }]);
});

test('STATUS-LAYOUT-05: ширина ещё не измерена — показываем всё, без ложного «+N»', () => {
  const layout = statusSummaryLayout(Number.POSITIVE_INFINITY, 3);

  assert.equal(layout.cwd, true);
  assert.deepEqual(
    statusOverflow(layout, { ...facts, usageItems: facts.usageItems.slice(0, 2) }),
    [],
  );
});

test('STATUS-LAYOUT-06: обрезанное по факту замера уходит во всплывашку, а не в «Opu…»', () => {
  const cwdOnly = statusSummaryLayout(300, 3, { cwd: true });

  assert.equal(cwdOnly.cwd, false, 'обрезанная папка прячется целиком, даже если порог пройден');
  assert.equal(cwdOnly.model, true);

  const both = statusSummaryLayout(300, 3, {
    cwd: true,
    model: true,
  });

  assert.equal(both.model, false);
  assert.equal(
    statusSummaryLayout(300, 0, { model: true }).model,
    true,
    'без лимитов модель остаётся, пусть и с многоточием: иначе блок пустой',
  );
});
