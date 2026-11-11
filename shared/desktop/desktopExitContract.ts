import { isRecord } from '../lib/objects.ts';

export interface DesktopExitSnapshot {
  chats: { chatKey: string; title: string }[];
  pipelines: { task: string; title: string }[];
  update?: { version: string } | null;
}

export type DesktopExitCommandType = 'inspect' | 'prompt' | 'decision' | 'stopping'
  | 'stop-pipelines' | 'cancel';

export interface DesktopExitCommand {
  type: DesktopExitCommandType;
  requestId: string;
  expiresAt: number;
  snapshot?: DesktopExitSnapshot;
}

export type DesktopExitDecision = {
  decision: 'pending' | 'cancel' | 'confirm';
  remember?: boolean;
};

/**
 * Граница main принимает только заголовки и публичные идентификаторы работы.
 * Лента, ключи и внутренние данные ответа сервера в снимок не переходят.
 */
export function decodeDesktopExitSnapshot(value: unknown): DesktopExitSnapshot | null {
  if (!isRecord(value) || !Array.isArray(value.chats) || !Array.isArray(value.pipelines)) {
    return null;
  }

  const chats: DesktopExitSnapshot['chats'] = [];
  const pipelines: DesktopExitSnapshot['pipelines'] = [];

  for (const chat of value.chats) {
    if (!isRecord(chat) || typeof chat.chatKey !== 'string' || !chat.chatKey
      || typeof chat.title !== 'string') {
      return null;
    }

    chats.push({ chatKey: chat.chatKey, title: chat.title });
  }

  for (const pipeline of value.pipelines) {
    if (!isRecord(pipeline) || typeof pipeline.task !== 'string' || !/^\d+$/u.test(pipeline.task)
      || typeof pipeline.title !== 'string') {
      return null;
    }

    pipelines.push({ task: pipeline.task, title: pipeline.title });
  }

  /**
   * Готовое обновление приходит необязательной строкой версии: её наличие включает
   * в модале предупреждение о применении и перезапуске приложения при выходе.
   */
  let update: DesktopExitSnapshot['update'];

  if (value.update !== undefined) {
    if (!isRecord(value.update) || typeof value.update.version !== 'string' || !value.update.version) {
      return null;
    }

    update = { version: value.update.version };
  }

  if (update) {
    return {
      chats,
      pipelines,
      update,
    };
  }

  return { chats, pipelines };
}

/**
 * Просроченная или неизвестная команда не меняет renderer и не запускает Stop.
 * Снимки команд отображения проверяются тем же декодером, что ответ inspect.
 */
export function decodeDesktopExitCommand(value: unknown, now: number): DesktopExitCommand | null {
  if (!isRecord(value) || typeof value.requestId !== 'string' || !value.requestId
    || typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt)
    || value.expiresAt <= now) {
    return null;
  }

  const types: readonly unknown[] = ['inspect', 'prompt', 'decision', 'stopping', 'stop-pipelines', 'cancel'];

  if (!types.includes(value.type)) {
    return null;
  }

  const snapshot = value.snapshot === undefined ? undefined : decodeDesktopExitSnapshot(value.snapshot);

  if (snapshot === null || (['prompt', 'stopping'].includes(String(value.type)) && !snapshot)) {
    return null;
  }

  return {
    type: value.type as DesktopExitCommandType,
    requestId: value.requestId,
    expiresAt: value.expiresAt,
    ...(snapshot ? { snapshot } : {}),
  };
}

/**
 * Решение человека отделено от ACK показа и результата остановки.
 * Флажок согласия учитывается только у подтверждённого выхода.
 */
export function decodeDesktopExitDecision(value: unknown): DesktopExitDecision | null {
  if (!isRecord(value)) {
    return null;
  }

  if (value.decision === 'pending' || value.decision === 'cancel') {
    return { decision: value.decision };
  }

  return value.decision === 'confirm'
    ? { decision: 'confirm', remember: value.remember === true } : null;
}
