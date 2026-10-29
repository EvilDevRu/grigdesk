import { recordOrEmpty } from '../../../../shared/lib/objects.ts';
import type { ChatStep } from '../chat/streamSteps.ts';
import { STEP_THINK_LIMIT, cut } from '../chat/streamSteps.ts';

/**
 * Изолирует блоки и попытки ребёнка от основного ответа чата.
 * Live block-end и последующий durable message публикуют один и тот же шаг только один раз.
 */
export function createGlmChildPresentation(options: {
  id: (turn: unknown, id: unknown) => string;
  emit: (step: ChatStep) => void;
  usage: (tokens: number) => void;
}) {
  const emitted = new Set<string>();
  const attempts = new Map<string, number>();
  const attemptKey = (turn: unknown, step: unknown) => JSON.stringify([turn, step]);
  const attemptStep = (turn: unknown, step: unknown) =>
    `${step}:${attempts.get(attemptKey(turn, step)) ?? 0}`;
  let active: {
    id: string;
    turn: unknown;
    step: unknown;
    next: number;
  } | undefined;
  const drafts = new Map<number, { type: string; text: string }>();

  /**
   * Публикует завершённый блок под устойчивым id с ограничением объёма размышления.
   * Одинаковые индексы блоков в соседних ходах не склеиваются.
   */
  function block(turn: unknown, step: unknown, index: number, value: Record<string, unknown>): void {
    const id = options.id(turn, `${step}:${index}`);

    if (emitted.has(id) || !['text', 'reasoning'].includes(String(value.type))
      || typeof value.text !== 'string' || !value.text) {
      return;
    }

    emitted.add(id);
    options.emit({
      k: value.type === 'reasoning' ? 'think' : 'text',
      id,
      text: value.type === 'reasoning' ? cut(value.text, STEP_THINK_LIMIT) : value.text,
    });
  }

  /**
   * Сохраняет только незавершённые блоки; инструментальные дельты здесь не интерпретируются.
   * Дочерние tool/call и tool/result приходят отдельным обязательным журналом.
   */
  function chunk(value: Record<string, unknown>): void {
    if (!active) {
      return;
    }

    const index = Number(value.index);
    const type = value.type === 'reasoning-delta' ? 'reasoning' : 'text';

    if (value.type === 'text-delta' || value.type === 'reasoning-delta') {
      const previous = drafts.get(index)?.text ?? '';

      drafts.set(index, { type, text: previous + String(value.text ?? '') });
    } else if (value.type === 'block-end') {
      block(active.turn, active.step, index, recordOrEmpty(value.block));
      drafts.delete(index);
    }
  }

  /**
   * Snapshot активной попытки содержит компактные записи, live — отдельные дельты.
   * Обе формы проходят один сборщик; nextIndex исключает повтор suffix после snapshot.
   */
  function compact(records: unknown): void {
    for (const raw of Array.isArray(records) ? records : []) {
      const record = recordOrEmpty(raw);

      if (record.type === 'chunk') {
        chunk(recordOrEmpty(record.chunk));
      } else if (record.type === 'text-chunks' || record.type === 'reasoning-chunks') {
        chunk({
          type: record.type === 'text-chunks' ? 'text-delta' : 'reasoning-delta',
          index: record.index,
          text: Array.isArray(record.texts) ? record.texts.join('') : '',
        });
      }
    }
  }

  /**
   * Завершает prefix оборванной попытки без подмены корневого reply.
   * Удалённые черновики не переносятся на следующую попытку модели.
   */
  function flush(): void {
    if (active) {
      for (const [index, draft] of drafts) {
        block(active.turn, active.step, index, draft);
      }
    }

    drafts.clear();
  }

  /**
   * Восстанавливает активную попытку из snapshot без проигрывания seed.
   * Следующая дельта должна начинаться ровно с native nextIndex.
   */
  function baseline(raw: unknown): void {
    const value = recordOrEmpty(raw);

    if (typeof value.attemptId !== 'string') {
      return;
    }

    active = {
      id: value.attemptId,
      turn: value.turn,
      step: attemptStep(value.turn, value.step),
      next: Number(value.nextIndex)
    };
    compact(value.stream);
  }

  /**
   * Проверяет последовательность chunks внутри попытки независимо от durable cursor.
   * Конец попытки закрывает только дочерние черновики, не весь ход.
   */
  function frame(value: Record<string, unknown>): void {
    if (value.type === 'start') {
      flush();
      active = {
        id: String(value.attemptId),
        turn: value.turn,
        step: attemptStep(value.turn, value.step),
        next: 0
      };
    } else if (value.type === 'chunk' && active && active.id === value.attemptId) {
      const index = Number(value.index);

      if (index < active.next) {
        return;
      }
      if (index !== active.next) {
        throw new Error('Пропущена дельта дочерней попытки GLM');
      }

      active.next += 1;
      chunk(recordOrEmpty(value.chunk));
    } else if (value.type === 'end' && active && active.id === value.attemptId) {
      flush();
      active = undefined;
    }
  }

  /**
   * Durable сообщение восстанавливает блоки пропущенного live и точный расход попытки.
   * Observer уже удалил дубликаты seq и унаследованный prefix до вызова этой функции.
   */
  function message(data: Record<string, unknown>): void {
    const value = recordOrEmpty(data.message);
    const content = Array.isArray(value.content) ? value.content.map(recordOrEmpty) : [];
    const records = Array.isArray(data.stream) ? data.stream.map(recordOrEmpty) : [];
    const usageRecord = records.findLast((item) => recordOrEmpty(item.chunk).type === 'usage');
    const usage = recordOrEmpty(data.usage ?? recordOrEmpty(usageRecord?.chunk).usage);
    const step = attemptStep(data.turn, data.step);
    const key = attemptKey(data.turn, data.step);
    const prefix = new Map<number, { type: string; text: string }>();

    content.forEach((value, index) => block(data.turn, step, index, value));

    // Оборванная попытка хранит stream без message. Его видимый prefix нужен и
    // при позднем follow; номер settlement отделяет повтор в том же turn/step.
    for (const record of records) {
      const value = record.type === 'chunk' ? recordOrEmpty(record.chunk) : record;
      const index = Number(value.index);
      const reasoning = value.type === 'reasoning-chunks' || value.type === 'reasoning-delta';

      if (['text-chunks', 'reasoning-chunks', 'text-delta', 'reasoning-delta'].includes(String(value.type))) {
        const text = Array.isArray(value.texts) ? value.texts.join('') : String(value.text ?? '');

        prefix.set(index, {
          type: reasoning ? 'reasoning' : 'text',
          text: (prefix.get(index)?.text ?? '') + text,
        });
      } else if (value.type === 'block-end') {
        block(data.turn, step, index, recordOrEmpty(value.block));
        prefix.delete(index);
      }
    }
    for (const [index, value] of prefix) {
      block(data.turn, step, index, value);
    }

    attempts.set(key, (attempts.get(key) ?? 0) + 1);

    if (typeof usage.outputTokens === 'number' && Number.isFinite(usage.outputTokens)) {
      options.usage(Math.max(0, usage.outputTokens));
    }
  }

  return {
    baseline,
    frame,
    message,
    flush
  };
}
