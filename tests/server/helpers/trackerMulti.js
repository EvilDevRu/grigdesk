import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { STOCK_CAPABILITIES, selectTracker, trackerFixture, writeTracker } from './trackerFixture.js';
import { TaskFavoritesStore } from '../../../server/src/lib/taskFavoritesStore.ts';
import { TaskFavoritesService } from '../../../server/src/lib/taskFavoritesService.ts';
import { TaskSeenStore } from '../../../server/src/lib/taskSeenStore.ts';
import { TaskSeenService } from '../../../server/src/lib/taskSeenService.ts';
import { TaskShelfStore } from '../../../server/src/lib/taskShelfStore.ts';
import { TaskShelfService } from '../../../server/src/lib/taskShelfService.ts';
import favoritesModule from '../../../server/src/modules/task-favorites/index.ts';
import seenModule from '../../../server/src/modules/task-seen/index.ts';
import shelfModule from '../../../server/src/modules/task-shelf/index.ts';

export const IDS = ['fixture-a', 'fixture-b', 'fixture-c'];

/**
 * Запись полки использует тот же обязательный снимок, что нормализует серверный store.
 * Пустые источники означают «ещё не наблюдались», а не повреждённое тело запроса.
 */
export function shelfInput(title = 'Задача на полке') {
  return {
    title,
    reason: 'manual',
    createIfMissing: true,
    snapshot: {
      analysis: null,
      pipeline: null,
      b24: null,
    },
  };
}

/**
 * Исполняемый пакет хранит команды управления рядом с временными данными фикстуры.
 * Host даёт настоящий транспорт для удержания вызова; идентичности A/B различаются.
 */
export async function writeMultiDriver(config, id, { manifest = {} } = {}) {
  const directory = path.join(config.driversDir, id);
  const code = `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const root = ${JSON.stringify(directory)};
writeFileSync(root + '/imported', 'yes');
const record = (method, args) => appendFileSync(root + '/calls.jsonl',
  JSON.stringify({ method, args }) + '\\n');
const control = () => existsSync(root + '/control.json')
  ? JSON.parse(readFileSync(root + '/control.json', 'utf8')) : {};
export default function createDriver(host) {
  const task = { id: 42, source: 'b24', title: ${JSON.stringify(id)}, status: 3 };
  const effect = (method) => async (...args) => {
    record(method, args);
    if (control().hold === method) await host.fetch('https://held.fixture/' + method);
    return { ok: true, id: 43 };
  };
  return {
    id: ${JSON.stringify(id)},
    capabilities: ${JSON.stringify(STOCK_CAPABILITIES)},
    isConfigured: () => {
      if (control().configuredThrows) throw new Error('Ошибка состояния ' + ${JSON.stringify(id)});
      return true;
    },
    accountIdentity: async () => {
      record('accountIdentity', []);
      return { baseUrl: host.credentials.read()?.endpoint || ${JSON.stringify(`https://${id}.fixture`)},
        userId: 7 };
    },
    testAuth: async () => ({ ok: true, userId: 7 }),
    listTasks: async () => [task],
    getDashboard: async () => {
      record('getDashboard', []);

      if (control().dashboardError) {
        throw new Error(control().dashboardError);
      }

      return {
        tasks: [{ ...task, ...(control().task ?? {}) }],
        toReview: [],
        created: [],
        widgets: [],
      };
    },
    taskDetail: async (id) => {
      record('taskDetail', [id]);

      if (control().detailError) {
        throw new Error(control().detailError);
      }

      return task;
    },
    taskPageData: async (id) => {
      record('taskPageData', [id]);

      if (control().pageError) {
        throw new Error(control().pageError);
      }

      if (control().hold === 'taskPageData') {
        await host.fetch('https://held.fixture/taskPageData');
      }

      return { comments: control().comments || [] };
    },
    createTask: effect('createTask'),
    updateTask: effect('updateTask'),
    addComment: effect('addComment'),
    timer: effect('timer'),
    completeTask: effect('completeTask'),
    deleteTask: effect('deleteTask'),
    renewTask: effect('renewTask'),
    addChecklistItem: effect('addChecklistItem'),
    updateChecklistItem: effect('updateChecklistItem'),
    deleteChecklistItem: effect('deleteChecklistItem'),
    updateTaskTags: effect('updateTaskTags'),
    approveTask: effect('approveTask'),
    disapproveTask: effect('disapproveTask'),
    findUsers: async (q) => { record('findUsers', [q]); return [{ id: 7, name: 'Исполнитель' }]; },
    listGroups: async () => { record('listGroups', []); return [{ id: 9, name: 'Проект' }]; },
    sourceUrl: (id) => ${JSON.stringify(`https://${id}.fixture/t/`)} + id,
    probeTaskNumber: async (id) => {
      record('probeTaskNumber', [id]);
      return control().probeById?.[id] || control().probe || 'absent';
    },
    dispose: async () => {},
  };
}
`;

  return writeTracker(config, id, {
    manifest: { settings: { endpoint: { type: 'string', label: { text: 'Адрес' } } }, ...manifest },
    code,
  });
}

/**
 * Личные сервисы используют реальные stores и тот же facade, что HTTP задач.
 * Отдельные файлы в корне фикстуры исключают чтение состояния владельца.
 */
export async function registerPersonal({ app, runtime, config }) {
  const definitions = [
    ['favorites', TaskFavoritesStore, TaskFavoritesService, favoritesModule],
    ['seen', TaskSeenStore, TaskSeenService, seenModule],
    ['shelf', TaskShelfStore, TaskShelfService, shelfModule],
  ];
  const services = {};

  for (const [key, Store, Service, module] of definitions) {
    const store = new Store({ filePath: path.join(config.stateDir, `multi-${key}.json`) });
    const service = new Service({
      store,
      tracker: runtime.tracker,
      ownTasks: runtime.own,
    });

    services[key] = service;
    await app.register(module, { [key]: service });
  }

  return services;
}

/**
 * Legacy-включения работают на базе и в будущем включают A/B с дефолтом B.
 * Новую форму выбора проверяют сами тесты, а не подготовка этой фикстуры.
 */
export async function multiFixture(t, { ids = IDS.slice(0, 2), personal = false, ...options } = {}) {
  let services;
  const fixture = await trackerFixture(t, {
    ...options,
    pluginEnabled: () => true,
    setup: async (config) => {
      for (const id of ids) {
        await writeMultiDriver(config, id);
      }
    },
    register: async (context) => {
      if (personal) {
        services = await registerPersonal(context);
      }

      await options.register?.(context);
    },
  });

  for (const id of ids) {
    await selectTracker(fixture, id);
  }

  const current = fixture.runtime.catalog().drivers.find((entry) => entry.id === ids.at(-1));

  assert.equal(current?.configured, true,
    'Синтетический default обязан работать до проверки нового поведения');

  return { ...fixture, services };
}

/**
 * CAS читается из того же HTTP settings API, которое принимает запись.
 * Отказ нового контракта на базе остаётся наблюдаемым HTTP-утверждением.
 */
export async function saveMulti(fixture, drivers, defaultId, settings = {}) {
  const current = await fixture.request('GET', '/api/trackers/settings');

  return fixture.request('POST', '/api/trackers/settings', {
    drivers,
    default: defaultId,
    settings,
    expectedRevision: current.json().revision,
  });
}

/**
 * Контекст читается через публичный адресный маршрут без dashboard.
 * Несуществующий endpoint даёт целевой RED 404 вместо отсутствующего импорта.
 */
export async function driverContext(fixture, id) {
  const response = await fixture.request('GET', `/api/tracker/${id}/context`);

  assert.equal(response.statusCode, 200, `Контекст ${id}: ${response.body}`);

  return response.json();
}

export const generationHeader = (context) => ({
  'x-grigdesk-tracker-generation': String(context.generation),
});

/**
 * Контроллер меняет только файл своего синтетического пакета.
 * Существующие ключи сохраняются, чтобы hold и health не мешали друг другу.
 */
export async function controlDriver(fixture, id, changes) {
  const file = path.join(fixture.config.driversDir, id, 'control.json');
  const previous = await readFile(file, 'utf8').then(JSON.parse).catch(() => ({}));

  await writeFile(file, JSON.stringify({ ...previous, ...changes }));
}
