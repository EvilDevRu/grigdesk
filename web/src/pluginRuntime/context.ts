import { computed, readonly } from 'vue';
import { api } from '../shared/apiClient.ts';
import type { PluginApi, PluginBaseContext } from '../../../packages/plugin-types/src/web.js';
import { uiLocale, locales } from '../ui.ts';
import { createTranslator } from '../../../shared/i18n/core.ts';
import type { Messages, MessageParams } from '../../../shared/i18n/core.ts';
import type { PluginWebModule } from '../../../shared/plugins/pluginsContracts.ts';
import { isRecord } from '../../../shared/lib/objects.ts';
import { isPluginModuleDescriptor } from './descriptor.ts';

interface PluginsContextPort {
  byId(id: string): { values?: Record<string, unknown> } | null;
}

type ContextApi = PluginApi;

/**
 * API плагина разделяет с окном сессию и обработчик 401.
 * Адрес проверяется до транспорта, включая декодированные попытки выхода из /api.
 */
function apiPath(value: string): string {
  const parsed = new URL(value, 'https://grigdesk.invalid');

  if (!value.startsWith('/api/') || /[\\\x00-\x20\x7f]/u.test(value)
    || parsed.origin !== 'https://grigdesk.invalid' || !parsed.pathname.startsWith('/api/')) {
    throw new Error('invalid-api-path');
  }

  return value;
}

const contextApi: ContextApi = {
  get: (path, options) => api.get(apiPath(path), options),
  post: (path, body, options) => api.post(apiPath(path), body, options),
  put: (path, body) => api.put(apiPath(path), body),
  patch: (path, body) => api.patch(apiPath(path), body),
  del: (path, body) => api.del(apiPath(path), body),
  upload: (path, body, options) => api.upload(apiPath(path), body, options),
  getBlob: (path) => api.getBlob(apiPath(path)),
  postBytes: (path, body, options) => api.postBytes(apiPath(path), body, options),
};

/**
 * Пакетный словарь состоит только из строк и вложенных объектов.
 * Битый ресурс прерывает подготовку панели, не затрагивая каталоги ядра.
 */
function isMessages(value: unknown): value is Messages {
  return isRecord(value) && Object.values(value).every((item) =>
    typeof item === 'string' || isMessages(item));
}

/**
 * Контекст удерживает реактивную связь с языком и текущей карточкой плагина.
 * Собственные словари читаются один раз, а настройки доступны глубоко readonly.
 */
export async function createPluginContext(
  pluginId: string,
  descriptor: PluginWebModule,
  plugins: PluginsContextPort,
  options: { signal: AbortSignal },
): Promise<PluginBaseContext> {
  if (!isPluginModuleDescriptor(pluginId, descriptor)) {
    throw new Error('invalid-module-descriptor');
  }

  const messages: Record<string, Messages> = {};

  await Promise.all(Object.entries(descriptor.locales).map(async ([language, url]) => {
    const dictionary = await api.get(url, { signal: options.signal });

    if (!isMessages(dictionary)) {
      throw new Error('invalid-module-dictionary');
    }

    messages[language] = dictionary;
  }));
  options.signal.throwIfAborted();

  const translator = createTranslator({ locales, messages });
  // Ключи принадлежат пакету плагина, а не каталогу собственных надписей окна.
  // Отдельное имя отличает этот перевод от проверяемых обращений к каталогу ядра.
  const translatePlugin = translator.t;

  return {
    pluginId,
    api: contextApi,
    locale: uiLocale,
    settings: readonly(computed(() => plugins.byId(pluginId)?.values ?? {})),
    t: (key: string, params?: MessageParams, fallback?: string) =>
      translatePlugin(uiLocale.value, key, params, fallback ?? key),
  };
}

export type PluginContext = PluginBaseContext;
