import { setImmediate as yieldToLoop } from 'node:timers/promises';
import type { StoredChat } from './historyStore.ts';

/**
 * История состоит из JSON-полей и сообщений: сериализуем их порциями до восьми мс.
 * Готовые тела повторно не обходим при повышении revision после проверки no-op.
 */
export async function serializeHistoryChat(chat: StoredChat) {
  const fields: string[] = [];
  let revisionIndex = -1;
  let started = performance.now();

  for (const key of Object.keys(chat)) {
    const value = chat[key];
    let encoded: string | undefined;

    if (key === 'messages' && Array.isArray(value)) {
      const messages: string[] = [];

      for (let index = 0; index < value.length; index += 1) {
        const messageKey = JSON.stringify(String(index));
        const field = JSON.stringify({ [index]: value[index] });

        messages.push(field === '{}' ? 'null' : field.slice(messageKey.length + 2, -1));

        if (performance.now() - started >= 8) {
          await yieldToLoop();
          started = performance.now();
        }
      }

      encoded = `[${messages.join(',')}]`;
    } else {
      const field = JSON.stringify({ [key]: value });

      encoded = field === '{}' ? undefined : field.slice(JSON.stringify(key).length + 2, -1);
    }

    if (encoded !== undefined) {
      if (key === 'revision') {
        revisionIndex = fields.length;
      }

      fields.push(`${JSON.stringify(key)}:${encoded}`);
    }

    if (performance.now() - started >= 8) {
      await yieldToLoop();
      started = performance.now();
    }
  }

  return {
    json: `{${fields.join(',')}}`,
    /**
     * Меняется только готовое поле revision, порядок остальных JSON-полей сохраняется.
     * Сообщения и их вложенные тела уже закодированы и больше не читаются.
     */
    withRevision(revision: number): string {
      const next = [...fields];
      const field = `"revision":${JSON.stringify(revision)}`;

      if (revisionIndex < 0) {
        next.push(field);
      } else {
        next[revisionIndex] = field;
      }

      return `{${next.join(',')}}`;
    },
  };
}
