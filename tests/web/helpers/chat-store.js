// Общая обвязка для офлайн-тестов стора чатов.
//
// Стор тянет роутер, соседние сторы, уведомления и общий EventSource — подменяем их
// заглушками прямо в исходнике (тот же приём, что в task-favorites-store). DOM не
// поднимаем: vue сам обходится без него, а самодельный `document` ломает runtime-dom
// на импорте, поэтому пути, которым он нужен (`_visible`), тесты не трогают.
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const STORE_PATH = fileURLToPath(new URL('../../../web/src/stores/chat.js', import.meta.url));
const PINIA_PATH = fileURLToPath(new URL('../../../web/node_modules/pinia/dist/pinia.mjs', import.meta.url));
const PINIA_URL = pathToFileURL(PINIA_PATH).href;
const CONTEXT_USAGE_URL = new URL('../../../shared/chat/chatContextUsage.ts', import.meta.url).href;
const IN_TURN_CONTRACT_URL = new URL('../../../shared/chat/chatInTurnContracts.ts', import.meta.url).href;
const IN_TURN_STORE_URL = new URL('../../../web/src/stores/chatInTurn.ts', import.meta.url).href;

// Запросы стора: тест подменяет нужные методы (`api.get` и т.д.).
export const apiHarness = {};
globalThis.__chatApi = apiHarness;
globalThis.__chatNotifications = [];
globalThis.__chatDismissed = [];
globalThis.__chatVisibility = {
  ids: new Set(),
  isVisible(id) { return this.ids.has(id); },
  register() { return { update() {}, dispose() {} }; },
};
globalThis.__chatUiContext = {
  capture: () => ({ routingScope: null, promptContext: { page: '', path: '/chats' } }),
};

/** Реестр исполнителей по умолчанию: любая запрошенная модель существует, уровней нет. */
function defaultProviders() {
  return {
    modelOf(value) {
      const id = typeof value === 'object' && value ? value.model : (value || 'test-model');
      const provider = typeof value === 'object' && value?.provider ? value.provider : 'test-provider';
      return { id, model: { id }, provider: { id: provider } };
    },
  };
}
globalThis.__chatProviders = defaultProviders();

/** Подменить реестр на время теста (модель с уровнями эффорта, пропавшая модель и т.п.). */
export function setChatProviders(providers) {
  globalThis.__chatProviders = providers || defaultProviders();
}

let patchedSource;
let instance = 0;

function patch(source) {
  return source
    .replace(
      "import { alertUser, dismissAlert, dismissAlertScope } from '../shared/alerts.ts';",
      'const alertUser = (notice) => globalThis.__chatNotifications.push('
      + '[notice.title, notice.body, notice.id, notice]);'
      + ' const dismissAlert = (id) => globalThis.__chatDismissed.push(id);'
      + ' const dismissAlertScope = (scope) => globalThis.__chatDismissed.push(`scope:${scope}`);',
    )
    .replace("'../shared/quickPermission.ts'",
      JSON.stringify(new URL('../../../web/src/shared/quickPermission.ts', import.meta.url).href))
    .replace("'../../../shared/chat/chatRun.ts'",
      JSON.stringify(new URL('../../../shared/chat/chatRun.ts', import.meta.url).href))
    .replace("'../../../shared/chat/chatWorkdir.ts'",
      JSON.stringify(new URL('../../../shared/chat/chatWorkdir.ts', import.meta.url).href))
    .replace("import { defineStore } from 'pinia';", `import { defineStore } from "${PINIA_URL}";`)
    .replace("import { api } from '../shared/apiClient.ts';", 'const api = globalThis.__chatApi;')
    .replace(
      "import { router } from '../router.js';",
      "const router = { currentRoute: { value: { path: '/chats', meta: {} } } };"
      + ' const document = { hidden: false };',
    )
    .replace(
      "import { useUiContextStore } from './ui-context.js';",
      'const useUiContextStore = () => globalThis.__chatUiContext;',
    )
    .replace(
      "import { useProvidersStore } from './providers.js';",
      'const useProvidersStore = () => globalThis.__chatProviders;',
    )
    .replace(
      "import { sseSubscribe } from '../composables/useSse.ts';",
      'const sseSubscribe = (fn) => { globalThis.__chatSse = fn; return () => {}; };',
    )
    .replace("import { mdToText } from '../shared/md.ts';", 'const mdToText = (x) => x;')
    .replace("'../shared/chatListPreview.ts'",
      JSON.stringify(new URL('../../../web/src/shared/chatListPreview.ts', import.meta.url).href))
    .replace("'../shared/chatHistorySnapshot.ts'",
      JSON.stringify(new URL('../../../web/src/shared/chatHistorySnapshot.ts', import.meta.url).href))
    .replace("'../shared/chatPersistenceProjection.ts'",
      JSON.stringify(new URL('../../../web/src/shared/chatPersistenceProjection.ts', import.meta.url).href))
    .replace("'../shared/chatHistoryStepReuse.ts'",
      JSON.stringify(new URL('../../../web/src/shared/chatHistoryStepReuse.ts', import.meta.url).href))
    .replace(
      "import { normalizeContextUsage } from '../../../shared/chat/chatContextUsage.ts';",
      `import { normalizeContextUsage } from '${CONTEXT_USAGE_URL}';`,
    )
    .replace("from '../../../shared/chat/chatInTurnContracts.ts';",
      `from '${IN_TURN_CONTRACT_URL}';`)
    .replace("from './chatInTurn.ts';", `from '${IN_TURN_STORE_URL}';`)
    .replace(
      "import { chatVisibility } from '../shared/chat-visibility.js';",
      'const chatVisibility = globalThis.__chatVisibility;',
    )
    .replace(
      /import \{[^}]*\} from '\.\.\/shared\/chat-title\.js';/,
      'const applyGeneratedChatTitle = (s) => s, firstMessageTitle = () => "",'
      + ' provisionalChatTitle = () => "", shouldRequestChatTitle = () => false;',
    );
}

/**
 * Свежий экземпляр стора на каждый тест (уникальный текст модуля = отдельный модуль):
 * у стора есть состояние вне pinia — подписка на SSE, карта отправленного, id окна, —
 * и общий модуль протаскивал бы его из теста в тест.
 *
 * `api` — свой транспорт окна (например, настоящий модуль чата через inject): так два
 * экземпляра стора в одном тесте ведут себя как два окна со своими сетями.
 * `fromServer` — окно грузит историю само, как после F5, а не из готового состояния.
 *
 * @param {{ sessions?: object[], archived?: object[], activeId?: string }} state
 * @param {{ api?: object, fromServer?: boolean }} options
 * @returns {Promise<object>} стор, уже помеченный как загруженный и синхронный с сервером
 */
export async function chatStoreFixture(state = {}, { api = null, fromServer = false } = {}) {
  globalThis.__chatNotifications = [];
  globalThis.__chatDismissed = [];
  globalThis.__chatProviders = defaultProviders();
  globalThis.__chatVisibility.ids.clear();
  globalThis.__chatUiContext.capture = () => ({
    routingScope: null,
    promptContext: { page: '', path: '/chats' },
  });
  if (!patchedSource) patchedSource = patch(await readFile(STORE_PATH, 'utf8'));
  // Модуль стора читает транспорт один раз при загрузке: подменяем его до импорта
  // и сразу возвращаем общий, чтобы соседние тесты работали с apiHarness.
  globalThis.__chatApi = api || apiHarness;

  const [{ createPinia, setActivePinia }, { useChatStore }] = await Promise.all([
    import(pathToFileURL(PINIA_PATH).href),
    import(`data:text/javascript;base64,${Buffer.from(
      `${patchedSource}\n// экземпляр ${++instance}`,
    ).toString('base64')}`),
  ]);

  globalThis.__chatApi = apiHarness;
  setActivePinia(createPinia());
  const chat = useChatStore();

  if (!api) {
    apiHarness.get = async () => ({ active: [] });
    apiHarness.post = async () => ({});
    apiHarness.put = async () => ({});
    apiHarness.del = async () => ({});
  }
  if (fromServer) {
    await chat._load();

    return chat;
  }

  chat.sessions = state.sessions || [];
  chat.archived = state.archived || [];
  chat.activeId = state.activeId ?? (chat.sessions[0]?.id || null);
  chat.loaded = true;
  // Стор считает себя совпавшим с сервером — иначе любое чужое изменение он отвергнет
  // как «у нас есть несохранённое» (см. `_dirty`).
  chat._markSent();
  return chat;
}

export function chatNotifications() {
  return globalThis.__chatNotifications;
}

export function setChatVisible(id, visible = true) {
  if (visible) globalThis.__chatVisibility.ids.add(id);
  else globalThis.__chatVisibility.ids.delete(id);
}

export function setChatContextCapture(capture) {
  globalThis.__chatUiContext.capture = capture;
}

/** Обработчик SSE, который стор зарегистрировал через initPerms(). */
export function sseOf(chat) {
  chat.initPerms();
  return globalThis.__chatSse;
}

/**
 * Возвращает скалярные id погашенных оповещений для проверки сверок и ответов.
 * Подмена общего канала сохраняет формат прежних проверок notifications.
 */
export function chatDismissed() {
  return globalThis.__chatDismissed;
}
