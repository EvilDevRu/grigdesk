import { isRecord } from '../lib/objects.ts';
import { decodePluginPanelParams } from './pluginPanelParams.ts';
import type { PluginPanelParams } from './pluginPanelParams.ts';

export interface PluginNotification {
  action: 'show';
  id: string;
  dedupKey: string;
  topic: string;
  title: { ru: string; en: string };
  body?: { ru: string; en: string };
  tone?: 'accent' | 'warning' | 'danger';
  sticky?: boolean;
  params?: PluginPanelParams;
}

export type PluginNotificationEvent = PluginNotification
  | { action: 'dismiss'; id: string }
  | { action: 'dismiss-topic'; topic: string }
  | { action: 'clear' };

export interface PluginNotificationSnapshot {
  pluginId: string;
  generation: string;
  items: PluginNotification[];
  error: string | null;
}

const stringWithin = (value: unknown, limit: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= limit;

/**
 * Сервер плагина передаёт буквальные переводы только двух известных языков.
 * Неизвестные поля не превращаются в адрес, scope или произвольный HTML.
 */
function localized(value: unknown, limit: number): value is { ru: string; en: string } {
  return isRecord(value) && Object.keys(value).length === 2
    && Object.hasOwn(value, 'ru') && Object.hasOwn(value, 'en')
    && stringWithin(value.ru, limit) && stringWithin(value.en, limit);
}

/**
 * Один закрытый decoder используется перед SSE и при приёме snapshot в окне.
 * Копирование не удерживает изменяемые объекты доверенного серверного кода.
 */
export function decodePluginNotification(value: unknown): PluginNotificationEvent | null {
  if (!isRecord(value) || !Object.hasOwn(value, 'action')) {
    return null;
  }

  const keys = Object.keys(value);

  if (value.action === 'clear') {
    return keys.length === 1 ? { action: 'clear' } : null;
  }

  if (value.action === 'dismiss' || value.action === 'dismiss-topic') {
    const field = value.action === 'dismiss' ? 'id' : 'topic';

    if (keys.length !== 2 || !Object.hasOwn(value, field) || !stringWithin(value[field], 200)) {
      return null;
    }

    return value.action === 'dismiss'
      ? { action: 'dismiss', id: value.id as string }
      : { action: 'dismiss-topic', topic: value.topic as string };
  }

  const fields = ['action', 'id', 'dedupKey', 'topic', 'title', 'body', 'tone', 'sticky', 'params'];

  if (value.action !== 'show' || keys.some((key) => !fields.includes(key))
    || ['id', 'dedupKey', 'topic', 'title'].some((key) => !Object.hasOwn(value, key))
    || !stringWithin(value.id, 200) || !stringWithin(value.topic, 200)
    || !stringWithin(value.dedupKey, 512) || !localized(value.title, 300)
    || value.body !== undefined && !localized(value.body, 2000)
    || value.tone !== undefined && (typeof value.tone !== 'string'
      || !['accent', 'warning', 'danger'].includes(value.tone))
    || value.sticky !== undefined && typeof value.sticky !== 'boolean') {
    return null;
  }

  const params = value.params === undefined ? undefined : decodePluginPanelParams(value.params);

  if (params === null) {
    return null;
  }

  return {
    action: 'show',
    id: value.id,
    dedupKey: value.dedupKey,
    topic: value.topic,
    title: { ...value.title },
    ...(value.body === undefined ? {} : { body: { ...value.body as { ru: string; en: string } } }),
    ...(value.tone === undefined ? {} : { tone: value.tone as PluginNotification['tone'] }),
    ...(value.sticky === undefined ? {} : { sticky: value.sticky }),
    ...(params === undefined ? {} : { params }),
  };
}
