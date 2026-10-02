import { STEP_THINK_LIMIT, cut } from '../chat/streamSteps.ts';
import type { ChatStep } from '../chat/streamSteps.ts';

/**
 * Собирает опубликованное размышление web-потока DSH по id попытки и индексу блока.
 * Лента получает один ограниченный шаг на блок, а не отдельную строку на каждый токен.
 */
export function createDeepSeekServerThoughtNormalizer() {
  const pending = new Map<string, string>();
  const completed = new Set<string>();

  /**
   * Закрывает блок после его полного снимка или перед следующим действием.
   * Повторный block-end и запоздавшие дельты уже опубликованный шаг не дублируют.
   */
  function complete(id: string): ChatStep[] {
    const text = (pending.get(id) || '').trim();

    pending.delete(id);
    completed.add(id);

    return text ? [{
      k: 'think',
      id,
      text: cut(text, STEP_THINK_LIMIT),
    }] : [];
  }

  /**
   * Перед ответом, инструментом или завершением отдаёт все незакрытые блоки.
   * Порядок первой дельты сохраняется, в том числе у потока без block-end.
   */
  function flush(): ChatStep[] {
    return [...pending.keys()].flatMap(complete);
  }

  /**
   * Полный block-end заменяет накопленные дельты, поскольку это снимок того же блока.
   * Usage и начало размышления не разрывают текст; остальные chunks закрывают его.
   */
  function normalize(id: string, chunk: Record<string, unknown>): ChatStep[] {
    if (chunk.type === 'reasoning-delta') {
      if (!completed.has(id)) {
        const text = `${pending.get(id) || ''}${String(chunk.text || '')}`;

        pending.set(id, text.slice(0, STEP_THINK_LIMIT + 1));
      }

      return [];
    }

    const block = chunk.block as { type?: unknown; text?: unknown } | null | undefined;

    if (chunk.type === 'block-end' && block?.type === 'reasoning') {
      if (completed.has(id)) {
        return [];
      }

      if (typeof block.text === 'string') {
        pending.set(id, block.text.slice(0, STEP_THINK_LIMIT + 1));
      }

      return complete(id);
    }

    if (chunk.type === 'usage' || (chunk.type === 'block-start' && chunk.blockType === 'reasoning')) {
      return [];
    }

    return flush();
  }

  normalize.flush = flush;

  return normalize;
}
