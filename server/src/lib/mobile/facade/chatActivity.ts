import { recordOrEmpty } from '../../../../../shared/lib/objects.ts';

import type { ChatActivity, ChatActivityItem } from '../contract.ts';
import { text } from './common.ts';

/**
 * Публикует ограниченную проекцию уже нормализованной ленты исполнителя.
 * Результат обновляет свой вызов, неизвестный шаг остаётся видимой служебной строкой.
 */
export function chatActivity(source: unknown, live = false): ChatActivity {
  const steps = Array.isArray(source) ? source.map(recordOrEmpty) : [];
  const items: ChatActivityItem[] = [];
  const tools = new Map<string, ChatActivityItem>();
  let omitted = 0;

  for (const [index, step] of steps.entries()) {
    if (step.truncated && Number.isSafeInteger(step.dropped)) {
      omitted += Math.max(0, Number(step.dropped));

      continue;
    }
    if (step.k === 'text' && !live) {
      continue;
    }

    const id = text(step.id || `step-${index}`, 200);
    const previous = tools.get(id);

    if (step.k === 'res' && previous) {
      previous.result = bounded(step.text || step.preview, 6000);
      previous.state = step.ok === false ? 'error' : 'done';

      continue;
    }
    if (step.k === 'tool' && previous) {
      previous.text = bounded(step.preview || step.text || previous.text, 6000);

      continue;
    }

    const kind = step.k === 'tool' || step.k === 'think' || step.k === 'text' ? step.k : 'note';
    const title = kind === 'tool' ? step.name || 'Действие'
      : kind === 'think' ? 'Размышление'
        : kind === 'text' ? 'Агент'
          : step.k === 'start' ? 'Начало хода' : step.name || 'Событие';
    const item: ChatActivityItem = {
      id,
      kind,
      title: text(title, 200),
      text: bounded(step.preview || step.text || step.sub || step.model || step.k, 6000),
      result: '',
      state: step.ok === false ? 'error' : kind === 'tool' && live ? 'running' : 'done',
      at: Number.isSafeInteger(step.at) && Number(step.at) >= 0 ? Number(step.at) : 0,
    };

    items.push(item);

    if (kind === 'tool') {
      tools.set(id, item);
    }
  }

  // JSON budget учитывает многобайтный текст и экранирование. Метка пропуска честно
  // сообщает потерю раннего окна, сохраняя наиболее свежие действия текущего запуска.
  let bytes = 0;
  const result: ChatActivityItem[] = [];

  for (const item of items.toReversed()) {
    const size = Buffer.byteLength(JSON.stringify(item));

    if (bytes + size > 128 * 1024 || result.length >= 400) {
      omitted += 1;
    } else {
      bytes += size;
      result.unshift(item);
    }
  }

  return { items: result, omitted };
}

/**
 * Короткая мобильная проекция не выдаёт усечённый фрагмент за полный результат.
 * Многоточие входит в лимит схемы, даже если общий text режет строку без маркера.
 */
function bounded(value: unknown, limit: number) {
  const source = typeof value === 'string' ? value : '';

  return source.length > limit ? `${source.slice(0, limit - 1)}…` : source;
}
