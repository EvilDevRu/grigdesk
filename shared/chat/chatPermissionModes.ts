import { isRecord } from '../lib/objects.ts';

export interface ChatModeSelection {
  provider: string;
  id: string;
  revision: number;
  chatId: string;
}

export interface WorkToolPolicy {
  revision: number;
  allowedActions: Readonly<Record<string, readonly string[]>>;
}

/**
 * Маркер явного выбора проверяется одинаково в истории и на HTTP-границе.
 * Принадлежность конкретному чату и адаптеру дополнительно проверяет runtime.
 */
export function isChatModeSelection(value: unknown): value is ChatModeSelection {
  return isRecord(value)
    && typeof value.provider === 'string' && value.provider.length > 0 && value.provider.length <= 100
    && typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 100
    && Number.isSafeInteger(value.revision) && Number(value.revision) > 0
    && typeof value.chatId === 'string' && value.chatId.length > 0 && value.chatId.length <= 200;
}
