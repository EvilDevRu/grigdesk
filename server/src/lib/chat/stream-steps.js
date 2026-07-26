// Нормализация потока `claude --output-format stream-json` в ШАГИ хода для UI.
// Задача: показать в чате кокпита то же, что видно в чате VS Code — размышления,
// вызовы инструментов с превью (команда, файл, дифф) и их результаты, а не только
// финальный текст. Формат шага намеренно плоский и короткий: он летит по SSE
// и сохраняется в историю чата, поэтому всё длинное режем здесь, на сервере.
//
// Виды шагов (поле k):
//   start  — начало хода: ФАКТИЧЕСКАЯ модель, режим прав, cwd
//   think  — блок размышления
//   text   — промежуточный текст агента (финальный ответ приходит отдельно, как result)
//   tool   — вызов инструмента (title/preview/diff — по типу инструмента)
//   res    — результат инструмента (ok/ошибка + краткий вывод)
//   note   — служебное (ретрай API, компакт контекста, лимиты)

const TEXT_LIMIT = 1200;   // превью текста/вывода в шаге
const DIFF_LIMIT = 2000;   // куски old/new для диффа правки

function cut(s, limit = TEXT_LIMIT) {
  const t = String(s ?? '');
  return t.length > limit ? t.slice(0, limit) + '…' : t;
}

function base(p) {
  return String(p || '').split('/').filter(Boolean).pop() || String(p || '');
}

function lineCount(s) {
  return s ? String(s).split('\n').length : 0;
}

/**
 * Заголовок и превью вызова инструмента — по одному на каждый знакомый инструмент,
 * чтобы строка ленты читалась без раскрытия («Bash: git status», «Edit main.js»).
 */
function describeTool(name, input = {}) {
  const i = input || {};
  switch (name) {
    case 'Bash':
      return { title: cut((i.command || '').split('\n')[0], 200), preview: cut(i.description || '', 200), lang: 'bash' };
    case 'Read':
      return { title: base(i.file_path), sub: i.file_path || '' };
    case 'Write':
      return { title: base(i.file_path), sub: i.file_path || '', preview: cut(i.content, DIFF_LIMIT), lines: lineCount(i.content) };
    case 'Edit':
      return {
        title: base(i.file_path), sub: i.file_path || '',
        diff: { old: cut(i.old_string, DIFF_LIMIT), new: cut(i.new_string, DIFF_LIMIT), all: !!i.replace_all },
      };
    case 'NotebookEdit':
      return { title: base(i.notebook_path), sub: i.notebook_path || '' };
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
      return { title: 'план готов', preview: cut(i.plan, DIFF_LIMIT) };
    case 'Skill':
      return { title: i.skill || '', sub: i.args || '' };
    default: {
      // MCP-инструменты (mcp__сервер__метод) и всё незнакомое: показываем аргументы.
      const s = JSON.stringify(i);
      return { title: s === '{}' ? '' : cut(s, 200) };
    }
  }
}

/**
 * Текст результата инструмента: content бывает строкой или массивом блоков.
 */
function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c?.type === 'text' ? c.text : c?.type === 'image' ? '[изображение]' : '')).filter(Boolean).join('\n');
  }
  return content ? JSON.stringify(content) : '';
}

/**
 * Событие stream-json → шаг(и) для UI. Возвращает массив (одно событие assistant
 * может нести и размышление, и вызов инструмента) — пустой, если показывать нечего.
 */
export function toStep(ev) {
  const out = [];
  if (!ev || typeof ev !== 'object') return out;

  if (ev.type === 'system') {
    if (ev.subtype === 'init') {
      out.push({ k: 'start', model: ev.model || '', mode: ev.permissionMode || '', cwd: ev.cwd || '' });
    } else if (ev.subtype === 'api_retry') {
      // Без номера попытки: ретраи идут сериями, в ленте они схлопываются в одну строку «×N».
      out.push({ k: 'note', level: 'warn', text: 'Повтор запроса к API (сеть)' });
    } else if (ev.subtype === 'compact_boundary') {
      out.push({ k: 'note', level: 'info', text: 'Контекст сжат (compact)' });
    }
    return out;
  }

  if (ev.type === 'assistant') {
    const sub = !!ev.parent_tool_use_id; // шаг внутри подзадачи (Task)
    for (const c of ev.message?.content || []) {
      if (c.type === 'thinking' && c.thinking) {
        out.push({ k: 'think', text: cut(c.thinking), sub });
      } else if (c.type === 'text' && c.text?.trim()) {
        out.push({ k: 'text', text: cut(c.text, 4000), sub });
      } else if (c.type === 'tool_use') {
        out.push({ k: 'tool', id: c.id, name: c.name, sub, ...describeTool(c.name, c.input) });
      }
    }
    return out;
  }

  if (ev.type === 'user') {
    const content = ev.message?.content;
    if (!Array.isArray(content)) return out;
    for (const c of content) {
      if (c.type !== 'tool_result') continue;
      const text = resultText(c.content);
      out.push({
        k: 'res', id: c.tool_use_id, ok: !c.is_error,
        text: cut(text, c.is_error ? 600 : 400),
        lines: lineCount(text),
      });
    }
    return out;
  }

  return out;
}
