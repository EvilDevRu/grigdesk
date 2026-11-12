import { randomUUID } from 'node:crypto';

import {
  cut, STEP_TEXT_LIMIT, STEP_THINK_LIMIT, type ChatStep,
} from '../chat/streamSteps.ts';

/**
 * ACP передаёт дельты текста, а лента хранит законченные смысловые блоки.
 * Смена рода текста или явная граница закрывает блок; пустые chunks его не разрывают.
 */
export function createQwenTextSteps(now: () => number = Date.now) {
  const prefix = randomUUID();
  let sequence = 0;
  let kind: 'think' | 'text' | null = null;
  let pending = '';
  let at = 0;

  /**
   * Хвост выпускается один раз, включая завершение с ошибкой или отменой.
   * Время первой дельты сохраняет место блока перед следующим действием.
   */
  function flush(): ChatStep[] {
    const text = pending.trim();
    const current = kind;
    const startedAt = at;

    kind = null;
    pending = '';
    at = 0;

    return text && current ? [{
      k: current,
      id: `${prefix}-${++sequence}`,
      text: cut(text, current === 'think' ? STEP_THINK_LIMIT : STEP_TEXT_LIMIT),
      at: startedAt,
    }] : [];
  }

  /**
   * Пробелы между дельтами сохраняются, память ограничена лимитом предпросмотра.
   * Полный ответ отдельно собирает runtime; этот буфер не определяет его длину.
   */
  function append(next: 'think' | 'text', text: string): ChatStep[] {
    if (!text) {
      return [];
    }

    const out = kind && kind !== next ? flush() : [];

    if (!kind) {
      kind = next;
      at = now();
    }

    const limit = kind === 'think' ? STEP_THINK_LIMIT : STEP_TEXT_LIMIT;

    pending = (pending + text).slice(0, limit + 1);

    return out;
  }

  return { append, flush };
}
