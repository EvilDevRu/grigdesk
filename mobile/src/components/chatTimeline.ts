import type { MobileMessage } from '../api/contract.ts';

type MessageGroup = {
  key: string;
  turn: boolean;
  turnId: string | null;
  messages: [MobileMessage, ...MobileMessage[]];
};

/**
 * Группирует только соседние записи доказанного хода, не меняя серверный порядок.
 * Начальный запрос остаётся снаружи; уточнение внутри того же хода продолжает общую линию.
 */
export function groupMessages(messages: MobileMessage[]): MessageGroup[] {
  const groups: MessageGroup[] = [];

  for (const message of messages) {
    const previous = groups.at(-1);

    if (previous?.turn && message.turnId && previous.turnId === message.turnId) {
      previous.messages.push(message);
    } else {
      groups.push({
        key: message.id,
        turn: message.role === 'assistant',
        turnId: message.turnId,
        messages: [message],
      });
    }
  }

  return groups;
}
