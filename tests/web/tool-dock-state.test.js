import assert from 'node:assert/strict';
import test from 'node:test';

import { createPinia, setActivePinia } from '../../web/node_modules/pinia/dist/pinia.mjs';
import { useDockStore, clampDockWidth } from '../../web/src/stores/dock.js';
import { normalizeNavItem, sortNavItems } from '../../web/src/stores/plugins.js';
import { aggregateNavBadges, inboxNavBadge } from '../../web/src/shared/nav-badges.js';
import { launchTool } from '../../web/src/shared/tools/launcher.js';

function memoryStorage(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    getItem: (key) => data.has(key) ? data.get(key) : null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
    value: (key) => data.get(key),
  };
}

test('dock store клампит ширину, запоминает геометрию и не теряет intent при viewport-unmount', () => {
  const storage = memoryStorage({
    'cockpit-dock-tool': 'code',
    'cockpit-dock-width': 'oops',
    'cockpit-dock-expanded': '0',
  });
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
  setActivePinia(createPinia());
  const dock = useDockStore();

  assert.equal(dock.activeTool, 'code');
  assert.equal(dock.width, 560);
  assert.equal(clampDockWidth(900, 600), 600);
  assert.equal(clampDockWidth(1, 600), 380);
  assert.equal(clampDockWidth(500, 200), 200, 'узкий content временно уменьшает минимум');

  dock.setWidth(599, { max: 600 });
  assert.equal(storage.value('cockpit-dock-width'), 'oops', 'drag не пишет каждый пиксель');
  dock.setWidth(590, { max: 600, persist: true });
  assert.equal(storage.value('cockpit-dock-width'), '590');

  dock.open('terminal');
  dock.setRuntime('terminal', { status: 'open' });
  dock.setExpanded(true);
  assert.equal(dock.isExpanded, true);
  assert.equal(dock.expandedPreference, true);
  assert.equal(storage.value('cockpit-dock-expanded'), '1');
  assert.equal(dock.width, 590, 'разворачивание не подменяет сохранённую обычную ширину');
  dock.open('code');
  assert.equal(dock.isExpanded, true, 'переключение инструмента сохраняет геометрию открытого дока');
  dock.close();
  assert.equal(dock.isExpanded, false);
  assert.equal(dock.expandedPreference, true, 'скрытие сохраняет выбранную геометрию');
  assert.equal(dock.mounted.terminal, true, 'скрытие не размонтирует живой инструмент');
  assert.equal(dock.runtime.terminal.status, 'open', 'скрытие не сбрасывает живую сессию');

  const first = dock.enqueue('terminal', { id: 999, type: 'insert', text: 'one' });
  const second = dock.enqueue('terminal', { type: 'insert', text: 'two' });
  const code = dock.enqueue('code', { type: 'project', project: 'cockpit' });
  assert.deepEqual([first.id, second.id, code.id], [1, 2, 3], 'payload не подменяет монотонный id');
  dock.consume('terminal', first.id);
  assert.deepEqual(dock.intents.terminal.map((item) => item.id), [2]);
  assert.deepEqual(dock.intents.code.map((item) => item.id), [3]);

  dock.open('terminal');
  assert.equal(dock.isExpanded, true, 'новое открытие восстанавливает полноширинный режим');
  assert.equal(dock.runtime.terminal.status, 'open', 'повторное открытие использует ту же сессию');
  dock.setExpanded(false, { persist: false });
  assert.equal(dock.isExpanded, false, 'смена route может временно вернуть обычную ширину');
  assert.equal(dock.expandedPreference, true, 'техническое сворачивание не меняет настройку');
  assert.equal(storage.value('cockpit-dock-expanded'), '1');
  dock.close();
  dock.open('terminal');
  assert.equal(dock.isExpanded, true, 'после временного сворачивания настройка восстанавливается');
  dock.setExpanded(false);
  assert.equal(storage.value('cockpit-dock-expanded'), '0');
  dock.close();
  dock.open('terminal');
  assert.equal(dock.isExpanded, false, 'явное сворачивание становится новой настройкой');
  dock.setRuntime('terminal', { status: 'open' });
  dock.resetRuntime('terminal');
  assert.equal(dock.mounted.terminal, undefined);
  assert.equal(dock.runtime.terminal, undefined);
  assert.deepEqual(dock.intents.terminal.map((item) => item.id), [2], 'смена viewport сохраняет команду');

  dock.resetAllRuntime();
  assert.equal(dock.isOpen, false);
  assert.equal(dock.isExpanded, false);
  assert.equal(dock.expandedPreference, false);
  assert.deepEqual(dock.intents, {}, 'logout не переносит команды в следующий сеанс');

  dock.open('code');
  dock.setExpanded(true);
  dock.resetAllRuntime();
  assert.equal(dock.expandedPreference, true, 'runtime-reset не стирает настройку геометрии');
  setActivePinia(createPinia());
  const restored = useDockStore();
  restored.open('code');
  assert.equal(restored.isExpanded, true, 'полноширинный режим восстанавливается из localStorage');
});

function launcherHarness({ routeTool = null, isOpen = false, activeTool = 'code' } = {}) {
  const events = [];
  const dock = {
    isOpen,
    activeTool,
    runtime: {},
    enqueue(id, intent) { events.push(['enqueue', id, intent]); },
    open(id) { events.push(['open', id]); this.isOpen = true; this.activeTool = id; },
    setRuntime(id, value) {
      events.push(['runtime', id, value]);
      this.runtime[id] = { ...(this.runtime[id] || {}), ...value };
    },
  };
  const router = { async push(path) { events.push(['push', path]); } };
  return { route: { meta: routeTool ? { tool: routeTool } : {} }, router, dock, events };
}

test('launcher соблюдает route/dock state machine и кладёт intent до перехода', async () => {
  const desktop = launcherHarness();
  assert.equal(await launchTool({ ...desktop, canDock: () => true }, 'terminal', { type: 'insert', text: 'cmd' }), true);
  assert.deepEqual(desktop.events.map((event) => event[0]), ['enqueue', 'open', 'runtime']);
  assert.equal(desktop.dock.activeTool, 'terminal');

  const mobile = launcherHarness();
  await launchTool({ ...mobile, canDock: () => false }, 'code', { type: 'project', project: 'demo' });
  assert.deepEqual(mobile.events.map((event) => event[0]), ['enqueue', 'push']);
  assert.equal(mobile.events[1][1], '/code');

  const sameRoute = launcherHarness({ routeTool: 'code', isOpen: true, activeTool: 'terminal' });
  await launchTool({ ...sameRoute, canDock: () => true }, 'code', { type: 'project', project: 'demo' });
  assert.deepEqual(sameRoute.events.map((event) => event[0]), ['enqueue', 'runtime']);
  assert.equal(sameRoute.dock.isOpen, true, 'полноценная tool-страница не скрывает лежащий под ней dock');
  assert.equal(sameRoute.dock.activeTool, 'terminal');

  const otherRoute = launcherHarness({ routeTool: 'code', isOpen: true, activeTool: 'code' });
  await launchTool({ ...otherRoute, canDock: () => true }, 'terminal', { type: 'insert', text: 'login' });
  assert.deepEqual(otherRoute.events.map((event) => event[0]), ['enqueue', 'push']);
  assert.equal(otherRoute.events[1][1], '/terminal');
  assert.equal(otherRoute.dock.isOpen, true);
  assert.equal(otherRoute.dock.activeTool, 'code');

  assert.equal(await launchTool({ ...launcherHarness(), canDock: () => true }, 'unknown'), false);
});

test('Полка, Код и Терминал переключают один activeTool эксклюзивного дока', () => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: memoryStorage(),
    configurable: true,
  });
  setActivePinia(createPinia());
  const dock = useDockStore();
  const sequence = [];

  for (const id of ['shelf', 'code', 'terminal']) {
    dock.open(id);
    sequence.push([dock.isOpen, dock.activeTool]);
  }

  assert.deepEqual(sequence, [
    [true, 'shelf'],
    [true, 'code'],
    [true, 'terminal'],
  ]);
});

test('nav placement сортируется стабильно, invalid group остаётся в rail, а badge сохраняет приоритет', () => {
  const items = [
    normalizeNavItem({ id: 'z', nav: { path: '/z', label: 'Я', group: 'tools', order: 20 } }),
    normalizeNavItem({ id: 'a', nav: { path: '/a', label: 'А', group: 'broken', order: 10 } }),
    normalizeNavItem({ id: 'b', nav: { path: '/b', label: 'Б' } }),
  ];
  assert.equal(items[1].group, 'rail');
  assert.equal(items[2].group, 'rail');
  assert.deepEqual(sortNavItems(items).map((item) => item.id), ['a', 'z', 'b']);

  const legacySystem = ['video', 'code', 'inbox', 'telegram', 'github'].map((id) => normalizeNavItem({
    id,
    system: true,
    nav: { path: `/${id}`, label: id },
  }));
  assert.deepEqual(
    legacySystem.map(({ id, group, order }) => [id, group, order]),
    [
      ['video', 'tools', 10],
      ['code', 'dock', 10],
      ['inbox', 'rail', 30],
      ['telegram', 'tools', 20],
      ['github', 'tools', 30],
    ],
    'новый web не возвращает встроенные инструменты в левую рейку до рестарта старого server',
  );
  assert.equal(
    normalizeNavItem({ id: 'code', system: false, nav: { path: '/code', label: 'Чужой Code' } }).group,
    'rail',
    'fallback не даёт пользовательскому manifest привилегий встроенного Code',
  );

  const inbox = inboxNavBadge({ reviewCount: 4 });
  assert.deepEqual(inbox, {
    '/inbox': { n: 4, kind: 'info', title: 'к разбору: 4' },
  });
  assert.deepEqual(inboxNavBadge({ reviewCount: 0 }), {}, 'нулевой чип скрыт');
  const aggregate = aggregateNavBadges([
    { label: 'Видео', badge: { n: 2, kind: 'wait' } },
    { label: 'Входящие', badge: inbox['/inbox'] },
    { label: 'База', badge: { n: 1, kind: 'stall' } },
  ]);
  assert.deepEqual(aggregate, {
    n: 7,
    kind: 'stall',
    title: 'Видео: 2 · Входящие: 4 · База: 1',
  });
});
