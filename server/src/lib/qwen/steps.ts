import { randomUUID } from 'node:crypto';

import {
  cut, STEP_TEXT_LIMIT, STEP_THINK_LIMIT, type ChatStep,
} from '../chat/streamSteps.ts';

/**
 * ACP передаёт дельты текста, а лента хранит законченные смысловые блоки.
 * Каналы могут чередоваться внутри слова, поэтому только явная граница закрывает блоки.
 */
export function createQwenTextSteps(now: () => number = Date.now) {
  const prefix = randomUUID();
  let sequence = 0;
  const pending = new Map<'think' | 'text', { text: string; at: number }>();

  /**
   * Хвост выпускается один раз, включая завершение с ошибкой или отменой.
   * Порядок первых дельт сохраняет место каждого канала перед следующим действием.
   */
  function flush(): ChatStep[] {
    const steps: ChatStep[] = [];

    for (const [kind, block] of pending) {
      const text = block.text.trim();

      if (text) {
        steps.push({
          k: kind,
          id: `${prefix}-${++sequence}`,
          text: cut(text, kind === 'think' ? STEP_THINK_LIMIT : STEP_TEXT_LIMIT),
          at: block.at,
        });
      }
    }

    pending.clear();

    return steps;
  }

  /**
   * Пробелы между дельтами сохраняются, каждый канал ограничен лимитом предпросмотра.
   * Полный ответ отдельно собирает runtime; этот буфер не определяет его длину.
   */
  function append(next: 'think' | 'text', text: string): ChatStep[] {
    if (!text) {
      return [];
    }

    let block = pending.get(next);

    if (!block) {
      block = { text: '', at: now() };
      pending.set(next, block);
    }

    const limit = next === 'think' ? STEP_THINK_LIMIT : STEP_TEXT_LIMIT;

    block.text = (block.text + text).slice(0, limit + 1);

    return [];
  }

  return { append, flush };
}
