import {
  base, cut, cutMiddle, lineCount, STEP_DIFF_LIMIT, STEP_TEXT_LIMIT, STEP_THINK_LIMIT,
} from '../chat/stream-steps.js';

/**
 * Блоки content ACP: текст и структурный diff. Форма диффа — `{type:'diff', path,
 * oldText, newText}`; поля `diff` у него нет, и чтение несуществующего поля
 * оставляло правку файла в ленте пустой строкой.
 */
function splitContent(content) {
  const list = Array.isArray(content) ? content : [];
  const texts = [];
  let diff = null;
  for (const entry of list) {
    if (entry?.type === 'diff') {
      diff = {
        path: String(entry.path || ''),
        old: String(entry.oldText ?? ''),
        new: String(entry.newText ?? ''),
      };
      continue;
    }
    if (entry?.type === 'content' && entry.content?.type === 'text') {
      const text = String(entry.content.text || '');
      if (text.trim()) texts.push(text);
    }
  }
  return { text: texts.join('\n'), diff };
}

function firstString(...values) {
  return values.find((value) => typeof value === 'string' && value.trim()) || '';
}

/**
 * Шаг ленты из tool_call/tool_call_update. Аргументы берём из `rawInput` — он
 * приходит только на upgrade вызова (`in_progress`), поэтому строку ленты
 * собираем именно тогда, а не на lazy-create первой дельты.
 */
function toolStep(update) {
  const id = update.toolCallId;
  const kind = String(update.kind || 'other');
  const raw = update.rawInput && typeof update.rawInput === 'object' ? update.rawInput : {};
  const { text, diff } = splitContent(update.content);
  const title = String(update.title || kind);

  if (kind === 'execute') {
    // Заголовком идёт сама команда: «Bash Bash» ничего человеку не сообщает.
    const command = firstString(raw.command, raw.cmd, raw.script) || text;
    return {
      k: 'tool', id, name: 'Bash', lang: 'bash',
      title: cut((command || title).split('\n')[0], 200),
      command: cutMiddle(command, STEP_TEXT_LIMIT),
      preview: command ? '' : cut(title, 200),
    };
  }

  if (kind === 'edit' || diff) {
    const file = firstString(diff?.path, update.locations?.[0]?.path, raw.path, raw.file_path);
    return {
      k: 'tool', id, name: 'Edit',
      title: file ? base(file) : cut(title, 200),
      sub: file,
      ...(diff
        ? { diff: { old: cut(diff.old, STEP_DIFF_LIMIT), new: cut(diff.new, STEP_DIFF_LIMIT) } }
        : { preview: cut(text || JSON.stringify(raw), 600) }),
    };
  }

  if (kind === 'read') {
    const file = firstString(update.locations?.[0]?.path, raw.path, raw.file_path);
    return {
      k: 'tool', id, name: 'Read', title: file ? base(file) : cut(title, 200), sub: file,
    };
  }

  if (kind === 'search') {
    return {
      k: 'tool', id, name: 'Grep',
      title: cut(firstString(raw.pattern, raw.query, raw.regex) || title, 200),
      sub: firstString(raw.path, raw.glob),
    };
  }

  const args = Object.keys(raw).length ? JSON.stringify(raw) : text;
  return {
    k: 'tool', id, name: title, title: cut(title, 200), preview: cut(args, 600),
  };
}

/** Stateful ACP → provider-neutral ChatStep normalizer. */
export function createKimiStepNormalizer({ model = '', cwd = '', mode = 'manual' } = {}) {
  let started = false;
  let thought = '';
  const tools = new Map();

  // Размышление приходит потоком мелких кусков: каждый отдельным шагом превратил бы
  // ленту в лапшу из обрывков. Копим и отдаём одним шагом перед следующим действием
  // агента (и в конце хода — flush()).
  function flushThought(out) {
    const text = thought.trim();
    thought = '';
    if (text) out.push({ k: 'think', text: cut(text, STEP_THINK_LIMIT) });
    return out;
  }

  function normalize(params) {
    const update = params?.update;
    if (!update || typeof update !== 'object') return [];
    const out = [];
    if (!started && ['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update', 'plan'].includes(update.sessionUpdate)) {
      started = true;
      out.push({ k: 'start', model, cwd, mode });
    }

    // Размышление Kimi — то же, что thinking у Claude: это опубликованный агентом
    // текст, а не приватная цепочка. Пряча его за «Kimi анализирует задачу…»,
    // кокпит терял единственное, ради чего ленту и раскрывают.
    if (update.sessionUpdate === 'agent_thought_chunk') {
      const text = update.content?.type === 'text' ? String(update.content.text || '') : '';
      // Потолок вдвое выше лимита шага: хвост всё равно срежет cut, а копить
      // мегабайты в памяти хода незачем.
      if (text) thought = `${thought}${text}`.slice(0, STEP_THINK_LIMIT * 2);
      return out;
    }

    flushThought(out);

    if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      const id = update.toolCallId;
      const known = tools.get(id);
      // Лента append-only: уже отданный шаг не исправить. Первый tool_call —
      // это lazy-create по первой дельте аргументов (без rawInput, с обрезанным
      // именем), поэтому ждём upgrade до in_progress или завершения вызова.
      const ready = update.sessionUpdate === 'tool_call_update'
        || (update.status && update.status !== 'pending');
      if (!known && ready) {
        const step = toolStep(update);
        tools.set(id, step);
        out.push(step);
      }
      if (['completed', 'failed'].includes(update.status)) {
        if (!tools.has(id)) {
          const step = toolStep(update);
          tools.set(id, step);
          out.push(step);
        }
        const { text, diff } = splitContent(update.content);
        const result = text || (diff ? diff.path : '');
        out.push({
          k: 'res', id, ok: update.status === 'completed',
          text: cut(result, update.status === 'completed' ? 400 : 600), lines: lineCount(result),
        });
      }
      return out;
    }

    if (update.sessionUpdate === 'plan') {
      const entries = Array.isArray(update.entries) ? update.entries : [];
      const text = entries.map((entry) => {
        const status = String(entry.status || 'pending');
        const mark = status === 'completed' ? '✓' : status === 'in_progress' ? '▸' : '·';
        return `${mark} ${entry.content || entry.title || ''}`;
      }).join('\n');
      if (text) out.push({ k: 'note', text: cut(text) });
    }
    return out;
  }

  // Хвост размышления, за которым не последовало действия (агент подумал и ответил
  // текстом): без явного flush он пропадал бы вместе с нормализатором.
  normalize.flush = () => flushThought([]);
  return normalize;
}
