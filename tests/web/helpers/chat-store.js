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
// Чистый модуль без Vue/pinia — подставляем настоящий, а не заглушку: правило
// «полупустая ссылка = дефолт реестра» должно проверяться тем же кодом, что в бою.
const COMPANION_RUN_URL = pathToFileURL(fileURLToPath(
  new URL('../../../web/src/shared/companion-run.js', import.meta.url),
)).href;

// Запросы стора: тест подменяет нужные методы (`api.get` и т.д.).
export const apiHarness = {};
globalThis.__chatApi = apiHarness;
globalThis.__chatNotifications = [];
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
    .replace("import { defineStore } from 'pinia';", `import { defineStore } from "${PINIA_URL}";`)
    .replace("import { api } from '../shared/api-client.js';", 'const api = globalThis.__chatApi;')
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
      "import { normalizeCompanionRun } from '../shared/companion-run.js';",
      `import { normalizeCompanionRun } from "${COMPANION_RUN_URL}";`,
    )
    .replace(
      "import { notify } from '../shared/notify.js';",
      'const notify = (...args) => globalThis.__chatNotifications.push(args);',
    )
    .replace(
      "import { sseSubscribe } from '../composables/useSse.js';",
      'const sseSubscribe = (fn) => { globalThis.__chatSse = fn; return () => {}; };',
    )
    .replace("import { mdToText } from '../shared/md.js';", 'const mdToText = (x) => x;')
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
 * @param {{ sessions?: object[], archived?: object[], activeId?: string }} state
 * @returns {Promise<object>} стор, уже помеченный как загруженный и синхронный с сервером
 */
export async function chatStoreFixture(state = {}) {
  globalThis.__chatNotifications = [];
  globalThis.__chatProviders = defaultProviders();
  globalThis.__chatVisibility.ids.clear();
  globalThis.__chatUiContext.capture = () => ({
    routingScope: null,
    promptContext: { page: '', path: '/chats' },
  });
  if (!patchedSource) patchedSource = patch(await readFile(STORE_PATH, 'utf8'));
  const [{ createPinia, setActivePinia }, { useChatStore }] = await Promise.all([
    import(pathToFileURL(PINIA_PATH).href),
    import(`data:text/javascript;base64,${Buffer.from(
      `${patchedSource}\n// экземпляр ${++instance}`,
    ).toString('base64')}`),
  ]);
  setActivePinia(createPinia());
  const chat = useChatStore();
  chat.sessions = state.sessions || [];
  chat.archived = state.archived || [];
  chat.activeId = state.activeId ?? (chat.sessions[0]?.id || null);
  chat.loaded = true;
  apiHarness.get = async () => ({ active: [] });
  apiHarness.post = async () => ({});
  apiHarness.put = async () => ({});
  apiHarness.del = async () => ({});
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
