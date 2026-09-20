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

function toolStep(update: DeepSeekUpdate, id: string): ChatStep {
  const title = String(update.title || 'Действие');
  const raw = update.rawInput && typeof update.rawInput === 'object'
    ? update.rawInput as Record<string, unknown>
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
  return { k: 'tool', id, name: title, title: cut(title, 200), preview: cut(JSON.stringify(raw), 600) };
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
      out.push(toolStep(state.update, id));
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
