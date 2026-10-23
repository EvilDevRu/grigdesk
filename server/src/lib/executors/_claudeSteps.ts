// Нормализация Claude stream-json в нейтральную ленту хода GrigDesk.
// Файл начинается с _, поэтому загрузчик executors не считает его отдельным ИИ.
import {
  base, cut, cutMiddle, lineCount, STEP_DIFF_LIMIT, STEP_TEXT_LIMIT, STEP_THINK_LIMIT,
} from '../chat/streamSteps.ts';
import type { ChatStep } from '../chat/streamSteps.ts';
import { STEP_IMAGE_TEXT } from '../../../../shared/chat/chatSteps.ts';

/**
 * Заголовок и превью вызова инструмента — по одному на каждый знакомый инструмент,
 * чтобы строка ленты читалась без раскрытия («Bash: git status», «Edit main.js»).
 */
// Аргументы вызова инструмента. Их присылает CLI, а состав зависит от инструмента,
// поэтому объявлено ровно то, что читает описание строки ленты.
interface ToolInput {
  command?: unknown;
  description?: unknown;
  file_path?: unknown;
  notebook_path?: unknown;
  content?: unknown;
  old_string?: unknown;
  new_string?: unknown;
  replace_all?: unknown;
  pattern?: unknown;
  path?: unknown;
  glob?: unknown;
  subagent_type?: unknown;
  prompt?: unknown;
  url?: unknown;
  query?: unknown;
  todos?: Array<{ status?: string; content?: string }>;
  questions?: Array<{ question?: string }>;
  plan?: unknown;
  skill?: unknown;
  args?: unknown;
}

function describeTool(name: unknown, input: ToolInput = {}): Record<string, unknown> {
  const i = input || {};
  switch (name) {
    case 'Bash':
      return {
        title: cut(String(i.command || '').split('\n')[0], 200),
        command: cutMiddle(i.command || '', STEP_TEXT_LIMIT),
        preview: cut(i.description || '', 200),
        lang: 'bash',
      };
    case 'Read':
      return { title: base(i.file_path), sub: i.file_path || '' };
    case 'Write':
      return { title: base(i.file_path), sub: i.file_path || '', preview: cut(i.content, STEP_DIFF_LIMIT), lines: lineCount(i.content), files: i.file_path ? [String(i.file_path)] : [] };
    case 'Edit':
      return {
        title: base(i.file_path), sub: i.file_path || '',
        diff: { old: cut(i.old_string, STEP_DIFF_LIMIT), new: cut(i.new_string, STEP_DIFF_LIMIT), all: !!i.replace_all },
        files: i.file_path ? [String(i.file_path)] : [],
      };
    case 'NotebookEdit':
      return { title: base(i.notebook_path), sub: i.notebook_path || '', files: i.notebook_path ? [String(i.notebook_path)] : [] };
    case 'Glob':
      return { title: i.pattern || '', sub: i.path || '' };
    case 'Grep':
      return { title: i.pattern || '', sub: [i.path, i.glob].filter(Boolean).join(' · ') };
    case 'Agent':
    case 'Task':
      return {
        title: i.description || i.subagent_type || 'подзадача',
        preview: cut(i.prompt, 400),
        sub: i.subagent_type || '',
      };
    case 'WebFetch':
      return { title: i.url || '', preview: cut(i.prompt, 200) };
    case 'WebSearch':
      return { title: i.query || '' };
    case 'TodoWrite':
      return {
        title: `${(i.todos || []).length} пункт(ов)`,
        preview: cut((i.todos || []).map((t) => (
          `${t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▸' : '·'} ${t.content}`
        )).join('\n'), 600),
      };
    case 'AskUserQuestion':
      return { title: cut((i.questions || [])[0]?.question || 'вопрос', 200) };
    case 'ExitPlanMode':
      return { title: 'план готов', preview: cut(i.plan, STEP_DIFF_LIMIT) };
    case 'Skill':
      return { title: i.skill || '', sub: i.args || '' };
    default: {
      // MCP-инструменты (mcp__сервер__метод) и всё незнакомое: показываем аргументы.
      const serialized = JSON.stringify(i);
      return { title: serialized === '{}' ? '' : cut(serialized, 200) };
    }
  }
}

/** Текст результата инструмента: content бывает строкой или массивом блоков. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((raw) => raw as { type?: string; text?: string } | null)
      .map((item) => {
        if (item?.type === 'text') return item.text || '';

        return item?.type === 'image' ? STEP_IMAGE_TEXT : '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return content ? JSON.stringify(content) : '';
}

/** Событие Claude stream-json → нейтральные шаги UI. */
export function toClaudeSteps(value: unknown): ChatStep[] {
  const out: ChatStep[] = [];
  if (!value || typeof value !== 'object') return out;

  const event = value as {
    type?: string;
    subtype?: string;
    model?: unknown;
    permissionMode?: unknown;
    cwd?: unknown;
    compactMetadata?: { preTokens?: unknown; trigger?: unknown };
    parent_tool_use_id?: unknown;
    message?: { id?: unknown; content?: Array<Record<string, unknown>> };
  };

  if (event.type === 'system') {
    if (event.subtype === 'init') {
      out.push({ k: 'start', model: event.model || '', mode: event.permissionMode || '', cwd: event.cwd || '' });
    } else if (event.subtype === 'api_retry') {
      out.push({ k: 'note', level: 'warn', text: 'Повтор запроса к API (сеть)' });
    } else if (event.subtype === 'compact_boundary') {
      // Сжатие посреди хода делает САМ CLI по своему порогу (GrigDesk задаёт его через
      // CLAUDE_CODE_AUTO_COMPACT_WINDOW). Со стороны это выглядит как «агент забыл
      // разговор», поэтому в ленте оно называется вслух и с цифрой «было».
      const pre = Number(event.compactMetadata?.preTokens) || 0;
      const how = event.compactMetadata?.trigger === 'manual' ? 'по команде' : 'сам, по порогу';
      out.push({ k: 'note', level: 'info', text: `Контекст сжат: CLI сжал его ${how}${pre ? ` (было ${pre.toLocaleString('ru')} ток.)` : ''}` });
    }
    return out;
  }

  if (event.type === 'assistant') {
    // Шаги субагента несут id родительского вызова (`Agent`/`Task`): по нему лента рисует их
    // вложенными. Раньше признак ехал булевым `sub`, а это же поле у инструментов — путь
    // файла: `Edit` в корне хода выглядел вложенным, а у вложенного Bash в теле стояло «true».
    const parentId = event.parent_tool_use_id ? String(event.parent_tool_use_id) : '';
    const parent = parentId ? { parent: parentId } : {};
    for (const raw of event.message?.content || []) {
      const content = raw as {
        type?: string;
        thinking?: unknown;
        text?: string;
        id?: unknown;
        name?: unknown;
        input?: ToolInput;
      };
      if (content.type === 'thinking' && content.thinking) {
        out.push({ k: 'think', text: cut(content.thinking, STEP_THINK_LIMIT), ...parent });
      } else if (content.type === 'text' && content.text?.trim()) {
        // Id сообщения связывает текстовый шаг с видимым блоком ответа: новый клиент
        // показывает блок, старый продолжает видеть шаг — дубля нет у обоих.
        out.push({
          k: 'text',
          id: String(event.message?.id || ''),
          text: cut(content.text, 4000),
          ...parent,
        });
      } else if (content.type === 'tool_use') {
        out.push({
          k: 'tool',
          id: content.id,
          name: content.name,
          ...describeTool(content.name, content.input),
          ...parent,
        });
      }
    }
    return out;
  }

  if (event.type === 'user') {
    const content = event.message?.content;
    if (!Array.isArray(content)) return out;
    for (const raw of content) {
      const item = raw as {
        type?: string;
        tool_use_id?: unknown;
        is_error?: unknown;
        content?: unknown;
      };
      if (item.type !== 'tool_result') continue;
      const text = resultText(item.content);
      out.push({
        k: 'res', id: item.tool_use_id, ok: !item.is_error,
        text: cut(text, item.is_error ? 600 : 400),
        lines: lineCount(text),
      });
    }
  }

  return out;
}
