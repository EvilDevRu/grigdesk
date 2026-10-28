import { translator, type LocaleSource } from '../../../shared/i18n/catalogs.ts';
import { messageRef, type MessageRef } from '../../../shared/i18n/core.ts';

export const ALERT_CHAT_QUERY = 'openChat';
export const ALERT_TASK_QUERY = 'openTask';

export type AlertTarget = {
  kind: 'plugin';
  pluginId: string;
} | {
  kind: 'chat';
  chatId: string;
} | {
  kind: 'pipeline';
  taskId: string;
} | {
  kind: 'task';
  taskId: string;
} | {
  kind: 'studio';
  modelId: string;
  versionId: string;
};

/**
 * Формирует ссылку для системного уведомления с безопасным кодированием id.
 * Отдельные query-ключи не пересекаются с параметрами страницы «Диф».
 */
export function alertTargetHash(target: AlertTarget): string {
  if (target.kind === 'plugin') {
    return `#/ext/${encodeURIComponent(target.pluginId)}`;
  }
  if (target.kind === 'studio') {
    return `#/3d?model=${encodeURIComponent(target.modelId)}&version=${encodeURIComponent(target.versionId)}`;
  }
  if (target.kind === 'chat') {
    return `#/chats?${ALERT_CHAT_QUERY}=${encodeURIComponent(target.chatId)}`;
  }
  if (target.kind === 'task') {
    return `#/shelf?${ALERT_TASK_QUERY}=${encodeURIComponent(target.taskId)}`;
  }

  return '#/pipeline';
}

/**
 * Называет действие по виду цели одинаково для всех источников оповещений.
 * Подпись не зависит от текущего раздела приложения.
 */
export function alertTargetLabel(target: AlertTarget, locale: LocaleSource = 'ru'): string {
  return translator.resolveText(
    alertTargetMessage(target), typeof locale === 'string' ? locale : locale.value,
  );
}

/**
 * Действие оповещения хранит смысл до показа, а не снимок выбранного языка.
 * Обычные подписи прежних прямых вызовов остаются совместимыми через alertTargetLabel.
 */
export function alertTargetMessage(target: AlertTarget): MessageRef {
  const keys = {
    plugin: 'core.openPluginPanel',
    studio: 'core.openModel',
    chat: 'core.openChat',
    task: 'core.openTask',
    pipeline: 'core.openPipeline',
  };

  return messageRef(keys[target.kind]);
}

/**
 * Vue Router может отдать строку или массив значений одного query-ключа.
 * Посторонние значения не превращаются в случайный идентификатор чата или задачи.
 */
export function firstQueryValue(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }

  return Array.isArray(value) ? firstQueryValue(value.find((item) => typeof item === 'string')) : '';
}
