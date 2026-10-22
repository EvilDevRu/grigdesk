import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';

import type { Pinia } from 'pinia';

type StoreShape = {
  $id: string;
  $state: Record<string, unknown>;
};

type StoreFactory = (pinia: Pinia) => StoreShape;

type DiffStore = StoreShape & {
  openFor(id: number): void;
  close(): void;
};

type Agent = {
  kind: string;
  label: string;
};

type ReturnEdge = {
  from: string;
  to: string;
  label: string;
};

type RouteModule = {
  layoutRoute(
    stages: string[],
    returns: ReturnEdge[],
    agents: Record<string, Agent> | Map<string, Agent>,
  ): unknown;
};

/**
 * Загружает исходный модуль до переноса и его новый путь после переноса.
 * Барьер поведения остаётся тем же файлом с той же контрольной суммой на обоих этапах.
 */
async function loadModule<T>(previous: string, next: string): Promise<T> {
  const nextUrl = new URL(`../../web/src/${next}.ts`, import.meta.url);
  const url = existsSync(nextUrl) ? nextUrl : new URL(`../../web/src/${previous}.js`, import.meta.url);

  return await import(url.href) as T;
}

test('форма и id пяти локальных сторов сохранены', async (t) => {
  const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

  t.after(() => {
    if (storage) {
      Object.defineProperty(globalThis, 'localStorage', storage);
    } else {
      Reflect.deleteProperty(globalThis, 'localStorage');
    }
  });

  Object.defineProperty(globalThis, 'localStorage', { value: undefined, configurable: true });

  const piniaUrl = new URL('../../web/node_modules/pinia/dist/pinia.mjs', import.meta.url);
  const { createPinia, setActivePinia } = await import(piniaUrl.href) as typeof import('pinia');
  const pinia = createPinia();

  setActivePinia(pinia);
  t.after(() => setActivePinia(undefined));

  const { useDeviceStore } = await loadModule<{ useDeviceStore: StoreFactory }>(
    'stores/device', 'stores/device',
  );
  const { useDiffStore } = await loadModule<{ useDiffStore: (pinia: Pinia) => DiffStore }>(
    'stores/diff', 'stores/diff',
  );
  const { useDockStore } = await loadModule<{ useDockStore: StoreFactory }>('stores/dock', 'stores/dock');
  const { useHotkeysStore } = await loadModule<{ useHotkeysStore: StoreFactory }>(
    'stores/hotkeys', 'stores/hotkeys',
  );
  const { useUiContextStore } = await loadModule<{ useUiContextStore: StoreFactory }>(
    'stores/ui-context', 'stores/uiContext',
  );
  const diff = useDiffStore(pinia);
  const cases: Array<[StoreShape, string, string[]]> = [
    [useDeviceStore(pinia), 'device', [
      'wakeLockEnabled',
      'wakeLockSupported',
      'wakeLockActive',
      'wakeLockBusy',
      'wakeLockIssue',
      'wakeLockInitialized',
      'notificationSupported',
      'notificationPermission',
      'notificationBusy',
      'notificationIssue',
      'notificationInitialized',
    ]],
    [diff, 'diff', ['open', 'taskId']],
    [useDockStore(pinia), 'dock', [
      'isOpen',
      'isExpanded',
      'expandedPreferences',
      'activeTool',
      'width',
      'preferredWidth',
      'mounted',
      'intents',
      'nextIntentId',
      'runtime',
    ]],
    [useHotkeysStore(pinia), 'hotkeys', ['overrides', 'recording']],
    [useUiContextStore(pinia), 'uiContext', ['revision']],
  ];

  for (const [store, id, keys] of cases) {
    assert.equal(store.$id, id);
    assert.deepEqual(Object.keys(store.$state).sort(), keys.toSorted(), id);
  }

  assert.deepEqual(diff.$state, { open: false, taskId: null });

  diff.openFor(42);
  assert.deepEqual(diff.$state, { open: true, taskId: '42' });

  diff.close();
  assert.deepEqual(diff.$state, { open: false, taskId: '42' });
});

test('раскладка маршрута сохраняет пустой граф, Map и возвраты', async () => {
  const { layoutRoute } = await loadModule<RouteModule>('shared/route-layout', 'shared/routeLayout');

  assert.deepEqual(layoutRoute([], [], {}), {
    nodes: {},
    pos: {},
    edges: [],
    vb: '',
  });

  const stages = ['a', 'b'];
  const returns = [
    {
      from: 'b',
      to: 'a',
      label: 'Повтор',
    },
    {
      from: 'missing',
      to: 'a',
      label: 'Нет начала',
    },
    {
      from: 'b',
      to: 'missing',
      label: 'Нет конца',
    },
  ];
  const agents = {
    a: { kind: 'agent', label: 'А' },
    b: { kind: 'human', label: 'Б' },
  };
  const agentsMap = new Map(Object.entries(agents));
  const input = {
    stages,
    returns,
    agents,
    agentsMap,
  };
  const before = structuredClone(input);
  const expected = {
    nodes: {
      a: ['agent', '🤖 А', ''],
      b: ['human', '👤 Б', ''],
    },
    pos: {
      a: [168, 50],
      b: [356, 50],
    },
    edges: [
      ['_start', 'a', '', 'plain', 'h'],
      ['a', 'b', '', 'plain', 'h'],
      ['b', 'a', 'Повтор', 'fail', 'arc_up'],
    ],
    vb: '',
  };

  assert.deepEqual(layoutRoute(stages, returns, agents), expected);
  assert.deepEqual(layoutRoute(stages, returns, agentsMap), expected);
  assert.deepEqual(input, before);
});
