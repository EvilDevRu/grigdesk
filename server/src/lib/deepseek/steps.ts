import { STEP_IMAGE_TEXT } from '../../../../shared/chat/chatSteps.ts';
import { base, cut, lineCount, STEP_DIFF_LIMIT, STEP_THINK_LIMIT } from '../chat/streamSteps.ts';
import type { ChatStep } from '../chat/streamSteps.ts';

export interface DeepSeekUpdate {
  sessionUpdate?: unknown;
  messageId?: unknown;
  toolCallId?: unknown;
  title?: unknown;
  status?: unknown;
  rawInput?: unknown;
  content?: unknown;
  used?: unknown;
  size?: unknown;
}

function textContent(value: unknown): string {
  const direct = value as { type?: unknown; text?: unknown } | null;
  if (direct?.type === 'text') return String(direct.text || '');
  if (!Array.isArray(value)) return '';
  return value.map((entry) => {
    const wrapped = entry as { content?: unknown } | null;
    return textContent(wrapped?.content);
  }).filter(Boolean).join('\n');
}

function kindFor(title: string): string {
  if (title === 'bash') return 'execute';
  if (title === 'read') return 'read';
  if (title === 'write') return 'write';
  if (title === 'edit') return 'edit';
  if (title === 'grep' || title === 'glob') return 'search';
  if (title.startsWith('mcp__')) return 'mcp';
  return 'other';
}

/**
 * Строка ленты из вызова инструмента DSH: имя и разобранные аргументы модели.
 * Словарь общий для ACP-потока и web-потока, поэтому DeepSeek и GLM рисуют
 * одни и те же Bash/Read/Write/Edit с заголовком, командой или диффом.
 */
export function deepSeekToolStep(name: string, rawInput: unknown, id: string): ChatStep {
  const title = name || 'Действие';
  const raw = rawInput && typeof rawInput === 'object'
    ? rawInput as Record<string, unknown>
    : {};
  const kind = kindFor(title);
  const file = String(raw.file_path || '');
  if (kind === 'execute') {
    const command = String(raw.command || title);
    return { k: 'tool', id, name: 'Bash', lang: 'bash', title: cut(command.split('\n')[0], 200), preview: cut(command, 600) };
  }
  if (kind === 'read') return { k: 'tool', id, name: 'Read', title: base(file) || title, sub: file };
  // ACP-мост DSH диффы не передаёт вовсе: ни у `write`, ни у `edit` в потоке нет
  // блока `type:'diff'`, а в результате приходит только текст подтверждения. Зато
  // rawInput несёт саму правку, поэтому строку ленты собираем из неё — как Claude
  // из своих tool_use аргументов.
  if (kind === 'write') {
    const content = typeof raw.content === 'string' ? raw.content : '';
    // У перезаписи существующего файла «до» неизвестно, поэтому показываем превью
    // содержимого, а не сплошное добавление: стата «+N −0» соврала бы про убыль.
    return {
      k: 'tool', id, name: 'Write', title: base(file) || title, sub: file,
      preview: cut(content, STEP_DIFF_LIMIT), lines: lineCount(content),
      ...(file ? { files: [file] } : {}),
    };
  }
  if (kind === 'edit') {
    const oldText = typeof raw.old_string === 'string' ? raw.old_string : '';
    const newText = typeof raw.new_string === 'string' ? raw.new_string : '';
    return {
      k: 'tool', id, name: 'Edit', title: base(file) || title, sub: file,
      // Пустой пары строк не рисуем: неизвестная форма правки остаётся строкой с путём,
      // а не пустой рамкой «было/стало».
      ...(oldText || newText
        ? {
          diff: {
            old: cut(oldText, STEP_DIFF_LIMIT),
            new: cut(newText, STEP_DIFF_LIMIT),
            all: raw.replace_all === true,
          },
        }
        : {}),
      ...(file ? { files: [file] } : {}),
    };
  }
  if (kind === 'search') return { k: 'tool', id, name: title === 'glob' ? 'Glob' : 'Grep', title: cut(raw.pattern || title, 200) };

  // MCP и прочие инструменты: имя уже стоит в строке ленты, поэтому заголовок — аргументы,
  // как у Claude. Не поместившиеся в заголовок аргументы видны целиком в раскрытии.
  const args = JSON.stringify(raw);

  return {
    k: 'tool',
    id,
    name: title,
    title: args === '{}' ? '' : cut(args, 200),
    ...(args.length > 200 ? { preview: cut(args, 600) } : {}),
  };
}

// Блок итога инструмента в сообщении `tool/result` web-потока DSH.
interface DeepSeekToolResultBlock {
  type?: unknown;
  toolCallId?: unknown;
  content?: unknown;
  isError?: unknown;
}

/**
 * Текст итога из блоков tool-result DSH. Картинка становится общей заглушкой ленты,
 * прочие блоки (файлы, ссылки) в строку итога не попадают.
 */
function toolResultText(content: unknown): string {
  const blocks = Array.isArray(content) ? content : [];

  return blocks
    .map((value) => {
      const block = value as { type?: unknown; text?: unknown } | null;

      if (block?.type === 'text') {
        return String(block.text || '');
      }

      return block?.type === 'image' ? STEP_IMAGE_TEXT : '';
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * Итог инструмента из события `tool/result` web-потока DSH. Id вызова DSH кладёт в source
 * сообщения и в блок tool-result, исход — в `isError` блока. Верхних `toolCallId` и
 * `isError` у сообщения нет: по ним итог не находил свой вызов и всегда выглядел успехом.
 */
export function deepSeekToolResultStep(data: Record<string, unknown>): ChatStep {
  const message = (data.message && typeof data.message === 'object' ? data.message : {}) as {
    source?: { callId?: unknown } | null;
    content?: unknown;
  };
  const blocks = (Array.isArray(message.content) ? message.content : []) as
    Array<DeepSeekToolResultBlock | null>;
  const id = String(message.source?.callId || blocks.find((item) => item?.toolCallId)?.toolCallId || '');
  const block = blocks.find((item) => item?.type === 'tool-result' && item.toolCallId === id) || blocks[0];
  const ok = block?.isError !== true;
  const text = toolResultText(block?.content);

  return {
    k: 'res',
    id,
    ok,
    text: cut(text, ok ? 400 : 600),
    lines: lineCount(text),
  };
}

export function createDeepSeekStepNormalizer({ model = '', cwd = '', mode = '' } = {}) {
  let started = false;
  let thought = '';
  const tools = new Map<string, { emitted: boolean; resultEmitted: boolean; update: DeepSeekUpdate }>();

  // Размышление приходит потоком мелких кусков (как у Kimi): копим и отдаём одним
  // шагом перед следующим действием агента, а хвост без действия — по flush() в конце
  // хода. Текст — тот же, что модель видит у себя; человек читает, о чём агент думает.
  function flushThought(out: ChatStep[]): ChatStep[] {
    const text = thought.trim();
    thought = '';
    if (text) out.push({ k: 'think', text: cut(text, STEP_THINK_LIMIT) });
    return out;
  }

  function normalize(params: { update?: DeepSeekUpdate } | null | undefined): ChatStep[] {
    const update = params?.update;
    if (!update || typeof update !== 'object') return [];
    const event = String(update.sessionUpdate || '');
    const out: ChatStep[] = [];
    if (!started && ['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update'].includes(event)) {
      started = true;
      out.push({ k: 'start', model, cwd, mode });
    }
    if (event === 'agent_thought_chunk') {
      const text = textContent(update.content);
      if (text) thought = `${thought}${text}`.slice(0, STEP_THINK_LIMIT * 2);
      return out;
    }
    if (event === 'agent_message_chunk') {
      flushThought(out);
      const text = textContent(update.content);
      if (text) out.push({ k: 'text', text: cut(text) });
      return out;
    }
    if (event !== 'tool_call' && event !== 'tool_call_update') return out;
    if (event === 'tool_call') flushThought(out);

    const id = String(update.toolCallId || '');
    if (!id) return out;
    const state = tools.get(id) || { emitted: false, resultEmitted: false, update: {} };
    state.update = {
      ...state.update,
      ...update,
      rawInput: update.rawInput ?? state.update.rawInput,
      title: update.title ?? state.update.title,
    };
    const terminal = ['completed', 'failed'].includes(String(update.status || ''));

    if (!state.emitted && (event === 'tool_call' || terminal)) {
      out.push(deepSeekToolStep(String(state.update.title || ''), state.update.rawInput, id));
      state.emitted = true;
    }
    if (terminal && !state.resultEmitted) {
      const text = textContent(update.content);
      out.push({
        k: 'res', id, ok: update.status === 'completed', text: cut(text, 600), lines: lineCount(text),
      });
      state.resultEmitted = true;
    }
    tools.set(id, state);
    return out;
  }

  // Хвост размышления без последующего действия иначе пропал бы вместе с нормализатором.
  normalize.flush = () => flushThought([]);
  return normalize;
}
