// Офлайн-фикстура компилирует настоящий граф стора через общий resolver.
// Сеть, навигация и каналы подменены, чистые зависимости загружаются из исходников.
import { fileURLToPath, pathToFileURL } from 'node:url';

import { compileModule } from './compile-vue.js';

const STORE_PATH = fileURLToPath(new URL('../../../web/src/stores/chat.js', import.meta.url));
const PINIA_PATH = fileURLToPath(new URL('../../../web/node_modules/pinia/dist/pinia.mjs', import.meta.url));
const LOCALE_PATH = fileURLToPath(new URL('../../../web/src/services/locale.ts', import.meta.url));

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

/**
 * Подменяется окружение стора, а не его относительные импорты в data URL.
 * Новый чистый импорт разрешается тем же compiler, что и в component-тестах.
 */
function storeStubs() {
  return {
    '../ui.ts': `
      import { messageRef, resolveUiText } from ${JSON.stringify(LOCALE_PATH)};
      export { messageRef };
      globalThis.__chatResolveText = resolveUiText;
    `,
    '../shared/alerts.ts': `
      export const alertUser = (notice) => globalThis.__chatNotifications.push([
        notice.title, notice.body, notice.id, notice,
      ]);
      export const dismissAlert = (id) => globalThis.__chatDismissed.push(id);
      export const dismissAlertScope = (scope) => globalThis.__chatDismissed.push('scope:' + scope);
    `,
    '../shared/apiClient.ts': 'export const api = globalThis.__chatApi;',
    '../router.js': `
      export const router = { currentRoute: { value: { path: '/chats', meta: {} } } };
    `,
    './ui-context.js': 'export const useUiContextStore = () => globalThis.__chatUiContext;',
    './providers.js': 'export const useProvidersStore = () => globalThis.__chatProviders;',
    '../composables/useSse.ts': `
      export const sseSubscribe = (fn) => {
        globalThis.__chatSse = fn;
        return () => {};
      };
    `,
    '../shared/md.ts': 'export const mdToText = (value) => value;',
    '../shared/chat-visibility.js': 'export const chatVisibility = globalThis.__chatVisibility;',
    '../shared/chat-title.js': `
      export const applyGeneratedChatTitle = (session) => session;
      export const firstMessageTitle = () => '';
      export const provisionalChatTitle = () => '';
      export const shouldRequestChatTitle = () => false;
    `,
  };
}

/**
 * Свежая сборка стора на каждый тест сохраняет отдельное состояние модуля:
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

  // Модуль стора читает транспорт один раз при загрузке: подменяем его до импорта
  // и сразу возвращаем общий, чтобы соседние тесты работали с apiHarness.
  globalThis.__chatApi = api || apiHarness;
  globalThis.__chatResolveText = (value) => value;

  const [{ createPinia, setActivePinia }, { useChatStore }] = await Promise.all([
    import(pathToFileURL(PINIA_PATH).href),
    compileModule(STORE_PATH, { stubs: storeStubs() }),
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

/**
 * Старые проверки читают русское представление UiText, как его показывает UI до bootstrap.
 * Исходные descriptors и обработчики действий остаются в уведомлении стора неизменными.
 */
export function chatNotifications() {
  const render = (value) => value == null || typeof value === 'string'
    ? value : globalThis.__chatResolveText(value);

  return globalThis.__chatNotifications.map(([title, body, id, notice]) => {
    const rendered = {
      ...notice,
      title: render(title),
      body: render(body),
    };

    if (notice.actions) {
      rendered.actions = notice.actions.map((action) => ({ ...action, label: render(action.label) }));
    }

    return [render(title), render(body), id, rendered];
  });
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
