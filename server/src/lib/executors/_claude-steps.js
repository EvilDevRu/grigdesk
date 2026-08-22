// Нормализация Claude stream-json в нейтральную ленту хода Cockpit.
// Файл начинается с _, поэтому загрузчик executors не считает его отдельным ИИ.
import {
  base, cut, cutMiddle, lineCount, STEP_DIFF_LIMIT, STEP_TEXT_LIMIT, STEP_THINK_LIMIT,
} from '../chat/stream-steps.js';

/**
 * Заголовок и превью вызова инструмента — по одному на каждый знакомый инструмент,
 * чтобы строка ленты читалась без раскрытия («Bash: git status», «Edit main.js»).
 */
function describeTool(name, input = {}) {
  const i = input || {};
  switch (name) {
    case 'Bash':
      return {
        title: cut((i.command || '').split('\n')[0], 200),
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
    case 'Task':
      return { title: i.description || i.subagent_type || 'подзадача', preview: cut(i.prompt, 400), sub: i.subagent_type || '' };
    case 'WebFetch':
      return { title: i.url || '', preview: cut(i.prompt, 200) };
    case 'WebSearch':
      return { title: i.query || '' };
    case 'TodoWrite':
      return { title: `${(i.todos || []).length} пункт(ов)`, preview: cut((i.todos || []).map((t) => `${t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▸' : '·'} ${t.content}`).join('\n'), 600) };
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
function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((item) => (item?.type === 'text' ? item.text : item?.type === 'image' ? '[изображение]' : '')).filter(Boolean).join('\n');
  }
  return content ? JSON.stringify(content) : '';
}

/** Событие Claude stream-json → нейтральные шаги UI. */
export function toClaudeSteps(event) {
  const out = [];
  if (!event || typeof event !== 'object') return out;

  if (event.type === 'system') {
    if (event.subtype === 'init') {
      out.push({ k: 'start', model: event.model || '', mode: event.permissionMode || '', cwd: event.cwd || '' });
    } else if (event.subtype === 'api_retry') {
      out.push({ k: 'note', level: 'warn', text: 'Повтор запроса к API (сеть)' });
    } else if (event.subtype === 'compact_boundary') {
      // Сжатие посреди хода делает САМ CLI по своему порогу (кокпит задаёт его через
      // CLAUDE_CODE_AUTO_COMPACT_WINDOW). Со стороны это выглядит как «агент забыл
      // разговор», поэтому в ленте оно называется вслух и с цифрой «было».
      const pre = Number(event.compactMetadata?.preTokens) || 0;
      const how = event.compactMetadata?.trigger === 'manual' ? 'по команде' : 'сам, по порогу';
      out.push({ k: 'note', level: 'info', text: `Контекст сжат: CLI сжал его ${how}${pre ? ` (было ${pre.toLocaleString('ru')} ток.)` : ''}` });
    }
    return out;
  }

  if (event.type === 'assistant') {
    const sub = !!event.parent_tool_use_id;
    for (const content of event.message?.content || []) {
      if (content.type === 'thinking' && content.thinking) {
        out.push({ k: 'think', text: cut(content.thinking, STEP_THINK_LIMIT), sub });
      } else if (content.type === 'text' && content.text?.trim()) {
        out.push({ k: 'text', text: cut(content.text, 4000), sub });
      } else if (content.type === 'tool_use') {
        out.push({ k: 'tool', id: content.id, name: content.name, sub, ...describeTool(content.name, content.input) });
      }
    }
    return out;
  }

  if (event.type === 'user') {
    const content = event.message?.content;
    if (!Array.isArray(content)) return out;
    for (const item of content) {
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
