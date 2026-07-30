// Нормализация JSONL `codex exec --json` в нейтральную ленту хода Cockpit.
// Показываем только краткое reasoning-поле, которое отдал сам Codex; raw_content
// намеренно игнорируем, чтобы не превращать ленту в раскрытие приватной цепочки мыслей.
import {
  base, cut, cutMiddle, lineCount, STEP_TEXT_LIMIT,
} from '../chat/stream-steps.js';

function textOf(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join('\n');
  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.content === 'string') return value.content;
    try { return JSON.stringify(value); } catch { return ''; }
  }
  return '';
}

function commandOf(item) {
  const command = item?.command ?? item?.cmd ?? '';
  return Array.isArray(command) ? command.join(' ') : textOf(command);
}

function itemOk(item) {
  if (item?.error) return false;
  if (typeof item?.exit_code === 'number') return item.exit_code === 0;
  return !['failed', 'error', 'cancelled', 'canceled'].includes(String(item?.status || '').toLowerCase());
}

function resultOf(item) {
  return textOf(item?.aggregated_output ?? item?.output ?? item?.result ?? item?.error ?? '');
}

function changeList(item) {
  const changes = Array.isArray(item?.changes) ? item.changes : [];
  return changes.map((change) => {
    const file = change?.path || change?.file_path || change?.move_path || '';
    const kind = change?.kind || change?.type || 'update';
    return { file: String(file), kind: String(kind) };
  }).filter((change) => change.file);
}

function toolOf(item) {
  if (!item || typeof item !== 'object') return null;
  const id = item.id ? String(item.id) : '';

  if (item.type === 'command_execution') {
    const command = commandOf(item);
    return {
      id, name: 'Bash', title: cut(command.split('\n')[0], 200),
      command: cutMiddle(command, STEP_TEXT_LIMIT),
      preview: cut(item?.description || '', 200), lang: 'bash',
    };
  }

  if (item.type === 'file_change') {
    const changes = changeList(item);
    const paths = changes.map((change) => `${change.kind}: ${change.file}`).join('\n');
    return {
      id, name: 'Edit',
      title: changes.length === 1 ? base(changes[0].file) : `${changes.length || 'несколько'} файлов`,
      preview: cut(paths, STEP_TEXT_LIMIT), lines: lineCount(paths),
    };
  }

  if (item.type === 'mcp_tool_call') {
    const server = String(item.server || item.server_name || 'mcp');
    const tool = String(item.tool || item.tool_name || item.name || 'вызов');
    const args = item.arguments ?? item.input ?? item.params ?? {};
    return {
      id, name: `mcp__${server}__${tool}`, title: tool,
      sub: server, preview: cut(textOf(args), 600),
    };
  }

  if (item.type === 'web_search') {
    return { id, name: 'WebSearch', title: cut(item.query || item.search_query || '', 200) };
  }

  // Новые Codex tool-items должны fail closed в контурах, где tools запрещены.
  // Обычные agent/reasoning messages обработаны ниже отдельно; всё похожее на
  // image/browser/computer/tool нельзя молча потерять из audit trail.
  const type = String(item.type || '').toLowerCase();
  if (/(?:tool|image|browser|computer|exec|command|file_change|web_search)/.test(type)) {
    return {
      id,
      name: 'UnknownTool',
      title: cut(type || 'неизвестный инструмент', 200),
      preview: cut(textOf(item?.arguments ?? item?.input ?? item?.params ?? ''), 600),
    };
  }

  return null;
}

function reasoningSummary(item) {
  // `raw_content` и похожие технические поля сюда не добавляем. `text`/`summary`
  // — единственные явные, предназначенные для клиента поля reasoning item.
  if (typeof item?.text === 'string') return item.text;
  if (typeof item?.summary === 'string') return item.summary;
  if (Array.isArray(item?.summary)) return item.summary.map((part) => textOf(part)).filter(Boolean).join('\n');
  return '';
}

/**
 * Создаёт stateful normalizer одного Codex-хода. Stateful-часть нужна только для
 * склейки item.started/item.completed и единственного start; наружу всегда уходит
 * provider-neutral массив шагов.
 */
export function createCodexStepNormalizer({
  model = '',
  cwd = '',
  mode = 'workspace-write',
} = {}) {
  let started = false;
  const tools = new Set();

  function begin(event, out) {
    if (started) return;
    started = true;
    out.push({
      k: 'start',
      model: event?.model || event?.thread?.model || model || '',
      mode,
      cwd,
    });
  }

  function ensureTool(item, out) {
    const tool = toolOf(item);
    if (!tool) return null;
    if (tool.id) {
      if (tools.has(tool.id)) return tool;
      tools.add(tool.id);
    }
    out.push({ k: 'tool', ...tool });
    return tool;
  }

  return function toCodexSteps(event) {
    const out = [];
    if (!event || typeof event !== 'object') return out;

    if (['thread.started', 'turn.started', 'item.started', 'item.completed'].includes(event.type)) {
      begin(event, out);
    }

    if (event.type === 'item.started') {
      ensureTool(event.item, out);
      return out;
    }

    if (event.type === 'item.completed') {
      const item = event.item || {};
      if (item.type === 'reasoning' || item.type === 'agent_reasoning') {
        const text = reasoningSummary(item);
        if (text.trim()) out.push({ k: 'think', text: cut(text) });
        return out;
      }

      const tool = ensureTool(item, out);
      if (tool) {
        const text = resultOf(item);
        const ok = itemOk(item);
        out.push({
          k: 'res', id: tool.id, ok,
          text: cut(text, ok ? 400 : 600), lines: lineCount(text),
        });
      }
      // agent_message — это финальный ответ отдельным сообщением; не дублируем его
      // в ленте шага.
      return out;
    }

    if (['error', 'turn.failed', 'turn.error'].includes(event.type)) {
      const text = textOf(event.error ?? event.message ?? event.reason ?? 'Ошибка Codex');
      out.push({ k: 'note', level: 'warn', text: cut(text, 600) });
    }

    return out;
  };
}
