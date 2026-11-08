import { mountBoardView } from './board-view.js';
import { STOCK_CAPS } from './trackerCard.js';

export const SOURCE_A = `fixture-a@${'a'.repeat(64)}`;
export const SOURCE_B = `fixture-b@${'b'.repeat(64)}`;
export const MULTI_TASKS = [
  {
    id: 42,
    source: SOURCE_A,
    title: 'Задача A',
    group: 'Общий проект',
    timerElapsed: 0,
  },
  {
    id: 42,
    source: SOURCE_B,
    title: 'Задача B',
    group: 'Общий проект',
    timerElapsed: 0,
  },
];

/**
 * Metadata является тем же источником имени и PNG, который читает реальный UI.
 * Временная ошибка меняет только описание A, не глобальную готовность B.
 */
export function multiCatalog() {
  return {
    revision: 1,
    enabledIds: ['fixture-a', 'fixture-b'],
    default: 'fixture-b',
    externalId: 'fixture-b',
    activeIds: ['own', 'fixture-a', 'fixture-b'],
    drivers: [
      {
        id: 'own',
        name: 'GrigDesk',
        status: 'active',
        capabilities: STOCK_CAPS,
      },
      {
        id: 'fixture-a',
        name: 'Альфа',
        status: 'active',
        configured: true,
        generation: 1,
        dataRevision: 1,
        source: SOURCE_A,
        logoUrl: `/api/trackers/fixture-a/logo/${'a'.repeat(64)}`,
        capabilities: STOCK_CAPS,
      },
      {
        id: 'fixture-b',
        name: 'Бета',
        status: 'active',
        configured: true,
        generation: 1,
        dataRevision: 1,
        source: SOURCE_B,
        capabilities: STOCK_CAPS,
      },
    ],
  };
}

/**
 * Компонент доски и UI facade настоящие, данные задач и каталог — публичные DTO.
 * Соседние личные ветки отдельно проверяются через runtime в tracker-multi-personal.
 */
export async function mountMultiBoard(t, { catalog = multiCatalog(), ...options } = {}) {
  const metadata = {
    catalog,
    legacy: false,
    error: '',
    loading: false,
    capabilities: STOCK_CAPS,
    async load() {},
    invalidate() {},
  };

  globalThis.__multiViewTrackers = metadata;
  t.after(() => delete globalThis.__multiViewTrackers);

  const card = await mountBoardView(t, {
    tasks: MULTI_TASKS,
    ...options,
    snapshot: {
      source: SOURCE_B,
      trackerId: 'fixture-b',
      generation: 1,
      ...options.snapshot,
    },
    compilerStubs: {
      '../stores/trackers.ts': 'export const useTrackersStore = () => globalThis.__multiViewTrackers;',
      ...Object.fromEntries(['taskFavorites', 'taskSeen', 'taskShelf'].map((file, index) => [
        `../stores/${file}.ts`,
        `export const use${file[0].toUpperCase() + file.slice(1)}Store = () => {
          const store = globalThis.__boardViewStores.${['favorites', 'seen', 'shelf'][index]}();
          store.forSource = (source) => source === 'grigdesk' ? store.own : store;
          return store;
        };`,
      ])),
      ...options.compilerStubs,
    },
  });

  // Новая граница личных веток делегирует этим синтетическим marks для UI-проверки.
  // Саму независимость сохранения подтверждает отдельная настоящая HTTP-фикстура.
  for (const name of ['favorites', 'seen', 'shelf']) {
    const store = card.stores[name]();

    store.forSource = () => store;
  }

  return { ...card, metadata };
}
