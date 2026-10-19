import { recordOrEmpty } from '../../../../shared/lib/objects.ts';

interface MeterBlock {
  kind: string;
  streamChars: number;
  fullChars: number;
  assigned: boolean;
}

interface ResponseUsage {
  id: string;
  measured: number | null;
  thinking: number;
  blocks: Map<string, MeterBlock>;
  nextFull: number;
  closed: boolean;
}

function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Считает только видимый вывод и JSON аргументов; рассуждения оценены отдельным событием CLI.
 * Отсутствующие или несериализуемые аргументы не создают выдуманного расхода.
 */
function blockChars(block: Record<string, unknown>): number {
  if (block.type === 'text' && typeof block.text === 'string') {
    return block.text.length;
  }
  if (block.type === 'tool_use' && block.input !== undefined) {
    try {
      return JSON.stringify(block.input).length;
    } catch {
      return 0;
    }
  }

  return 0;
}

/**
 * У каждого обращения свой измеренный или оценённый вклад, result исправляет свой сегмент.
 * Счётчик не публикует ленту и не переносит накопленный расход в следующий ход человека.
 */
export function createClaudeTokenMeter() {
  const responses: ResponseUsage[] = [];
  const latestById = new Map<string, ResponseUsage>();
  let current: ResponseUsage | null = null;
  let final: number | null = null;
  let completedTokens = 0;

  /**
   * message_start задаёт новое обращение даже при повторно использованном message.id.
   * Старый вклад остаётся в сумме, а assistant-блоки находят последнее обращение этого id.
   */
  function newResponse(id = ''): ResponseUsage {
    const response: ResponseUsage = {
      id,
      measured: null,
      thinking: 0,
      blocks: new Map(),
      nextFull: 0,
      closed: false,
    };

    responses.push(response);
    current = response;

    if (id) {
      latestById.set(id, response);
    }

    return response;
  }

  /**
   * Legacy-поток без message_start получает id из первого полного assistant-сообщения.
   * Уже накопленные перед ним thinking_tokens остаются в том же обращении.
   */
  function assistantResponse(id: string): ResponseUsage {
    const known = id ? latestById.get(id) : null;

    if (known) {
      current = known;

      return known;
    }
    if (current && !current.id && !current.closed) {
      current.id = id;

      if (id) {
        latestById.set(id, current);
      }

      return current;
    }

    return newResponse(id);
  }

  /**
   * Полный блок закрывает соответствующий блок partial-потока, не прибавляя его дважды.
   * Блоки legacy-потока без дельт сохраняют самостоятельный вклад по порядку получения.
   */
  function addAssistant(response: ResponseUsage, content: unknown): void {
    for (const value of Array.isArray(content) ? content : []) {
      const block = recordOrEmpty(value);
      const kind = String(block.type || '');
      const matching = [...response.blocks.values()].find((item) => !item.assigned && item.kind === kind);
      const target = matching ?? {
        kind,
        streamChars: 0,
        fullChars: 0,
        assigned: false
      };

      target.fullChars = blockChars(block);
      target.assigned = true;

      if (!matching) {
        response.blocks.set(`full:${response.nextFull++}`, target);
      }
    }
  }

  /**
   * Обрабатывает только содержимое одного основного обращения в partial-потоке.
   * Уменьшение внутри обращения игнорируется; новый message_start создаёт другой вклад.
   */
  function pushStream(event: Record<string, unknown>): void {
    if (event.type === 'message_start') {
      const message = recordOrEmpty(event.message);
      const id = typeof message.id === 'string' ? message.id : '';

      if (current && !current.id && !current.closed) {
        current.id = id;

        if (id) {
          latestById.set(id, current);
        }
      } else {
        newResponse(id);
      }

      return;
    }

    const response = current ?? newResponse();

    if (event.type === 'message_delta') {
      const measured = tokenCount(recordOrEmpty(event.usage).output_tokens);

      if (measured !== null) {
        response.measured = Math.max(response.measured ?? 0, measured);
      }
    } else if (event.type === 'message_stop') {
      response.closed = true;
    } else if (event.type === 'content_block_start' || event.type === 'content_block_delta') {
      const key = `stream:${event.index}`;
      const block = recordOrEmpty(event.content_block);
      const delta = recordOrEmpty(event.delta);
      const kind = event.type === 'content_block_start' ? String(block.type || '')
        : delta.type === 'text_delta' ? 'text' : delta.type === 'input_json_delta' ? 'tool_use' : '';
      const target = response.blocks.get(key) ?? {
        kind,
        streamChars: 0,
        fullChars: 0,
        assigned: false
      };

      if (event.type === 'content_block_start') {
        target.streamChars = block.type === 'text' && typeof block.text === 'string' ? block.text.length : 0;
      } else {
        const text = delta.type === 'text_delta' ? delta.text
          : delta.type === 'input_json_delta' ? delta.partial_json : '';

        target.streamChars += typeof text === 'string' ? text.length : 0;
      }

      response.blocks.set(key, target);
    }
  }

  /**
   * Отбрасывает субагентов, явные повторы и сообщения самого CLI до изменения счёта.
   * Нулевой output принимается только как конечное неотрицательное целое число.
   */
  function push(value: unknown): void {
    const event = recordOrEmpty(value);
    const message = recordOrEmpty(event.message);

    if (event.parent_tool_use_id || event.isReplay === true || message.model === '<synthetic>') {
      return;
    }

    if (event.type === 'result') {
      const measured = tokenCount(recordOrEmpty(event.usage).output_tokens);

      if (measured !== null) {
        final = measured;
      }

      return;
    }
    if (final !== null) {
      // Уточнение в очереди открывает новый сегмент явным началом обращения.
      // Поздние блоки завершённого ответа не возобновляют уже измеренный сегмент.
      if (event.type !== 'stream_event' || recordOrEmpty(event.event).type !== 'message_start') {
        return;
      }

      completedTokens += final;
      final = null;
      responses.length = 0;
      latestById.clear();
      current = null;
    }

    if (event.type === 'stream_event') {
      pushStream(recordOrEmpty(event.event));
    } else if (event.type === 'assistant') {
      const id = typeof message.id === 'string' ? message.id : '';

      addAssistant(assistantResponse(id), message.content);
    } else if (event.type === 'system' && event.subtype === 'thinking_tokens') {
      const delta = tokenCount(event.estimated_tokens_delta);

      if (delta !== null && delta > 0) {
        const response = current ?? newResponse();

        response.thinking += delta;
      }
    }
  }

  /**
   * Точные вклады заменяют свои оценки, включая рассуждения, а не добавляются к ним.
   * Пока хотя бы одно обращение не измерено, общая сумма честно остаётся оценкой.
   */
  function total(): { tokens: number; tokensIsEstimate: boolean } {
    if (final !== null) {
      return { tokens: completedTokens + final, tokensIsEstimate: false };
    }

    const tokens = responses.reduce((sum, response) => {
      const chars = [...response.blocks.values()]
        .reduce((size, block) => size + Math.max(block.streamChars, block.fullChars), 0);

      return sum + (response.measured ?? response.thinking + Math.round(chars / 3));
    }, 0);

    return {
      tokens: completedTokens + tokens,
      tokensIsEstimate: !responses.length || responses.some((response) => response.measured === null),
    };
  }

  return { push, total };
}
