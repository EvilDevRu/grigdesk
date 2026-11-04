import { chatSpeedModes, isChatSpeed } from '../../../../shared/chat/chatSpeed.ts';
import type { ExecutorAdapter } from '../executors/index.ts';

/**
 * Durable выбор применяется только к новому снимку запуска после ожидания очереди.
 * Нативные файлы, общий default и настройки уже работающего агента не меняются.
 */
export function applyChatSpeed(
  executor: Pick<ExecutorAdapter, 'chatSpeed'>,
  model: { chatSpeedModes?: readonly string[] } | null | undefined,
  speed: unknown,
  settings: Record<string, unknown>,
): Record<string, unknown> {
  if (!isChatSpeed(speed)) {
    throw Object.assign(new Error('Некорректная скорость чата.'), { code: 'bad_chat_speed' });
  }
  if (speed == null) {
    return { ...settings };
  }
  if (!executor.chatSpeed) {
    if (speed === 'standard') {
      return { ...settings };
    }

    throw Object.assign(new Error('Исполнитель не поддерживает ускорение.'),
      { code: 'unsupported_speed' });
  }
  if (!chatSpeedModes(executor.chatSpeed, model).includes(speed)) {
    throw Object.assign(new Error('Модель не подтвердила поддержку ускорения. Выберите обычную скорость.'),
      { code: 'unsupported_speed' });
  }

  return executor.chatSpeed.apply({ ...settings }, speed);
}
