// Нормализация JSON-RPC notifications `codex app-server` в нейтральную ленту Cockpit.
// Legacy JSONL `codex exec --json` остаётся совместимым для старых fixture/потребителей.
// Показываем только краткое reasoning-поле, которое отдал сам Codex; raw_content
// намеренно игнорируем, чтобы не превращать ленту в раскрытие приватной цепочки мыслей.
import { Buffer } from 'node:buffer';
import {
  base, cut, cutMiddle, lineCount, STEP_DIFF_LIMIT, STEP_TEXT_LIMIT, STEP_THINK_LIMIT,
} from '../chat/stream-steps.js';

// Rich fileChange у app-server может содержать сотни файлов и мегабайты unified
// diff. Шаг одновременно уходит в SSE и историю, поэтому лимитируем сам контракт,
// а не только его визуальный preview.
const MAX_CODEX_FILE_CHANGES = 20;
const MAX_CODEX_CHANGE_DIFF_BYTES = 16 * 1024;
const MAX_CODEX_CHANGE_PATH_CHARS = 500;
const DIFF_CUT_MARKER = '\n… сокращено …\n';

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
  if (item?.success === false) return false;
  if (item?.success === true) return true;
  if (typeof item?.exitCode === 'number') return item.exitCode === 0;
  if (typeof item?.exit_code === 'number') return item.exit_code === 0;
  return !['failed', 'error', 'declined', 'cancelled', 'canceled']
    .includes(String(item?.status || '').toLowerCase());
}

function resultOf(item) {
  return textOf(item?.aggregatedOutput ?? item?.aggregated_output
    ?? item?.output ?? item?.result ?? item?.error ?? item?.contentItems ?? '');
}

function toolCallInputOf(item) {
  return textOf(item?.arguments ?? item?.input ?? item?.params ?? item?.prompt ?? '');
}

function changeKind(change) {
  const raw = change?.kind ?? change?.type ?? 'update';
  const kind = typeof raw === 'object' && raw ? raw.type : raw;
  if (kind === 'create') return 'add';
  if (kind === 'remove') return 'delete';
  return ['add', 'delete', 'update'].includes(String(kind)) ? String(kind) : 'update';
}

function utf8Prefix(buffer, maxBytes) {
  let end = Math.min(buffer.length, Math.max(0, maxBytes));
  while (end > 0 && end < buffer.length && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString('utf8');
}

function utf8Suffix(buffer, maxBytes) {
  let start = Math.max(0, buffer.length - Math.max(0, maxBytes));
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start).toString('utf8');
}

function cutDiffMiddle(value, maxBytes) {
  const text = String(value ?? '');
  const source = Buffer.from(text, 'utf8');
  if (source.length <= maxBytes) return text;

  const marker = Buffer.from(DIFF_CUT_MARKER, 'utf8');
  if (maxBytes <= marker.length) return utf8Prefix(marker, maxBytes);
  const available = maxBytes - marker.length;
  const headBytes = Math.ceil(available / 2);
  const tailBytes = available - headBytes;
  const lastLine = text.slice(text.lastIndexOf('\n') + 1);
  const lastLineBytes = Buffer.from(lastLine, 'utf8');
  const inlineMarker = Buffer.from('…', 'utf8');
  let suffix = utf8Suffix(source, tailBytes);
  // Если последняя +/- строка сама длиннее хвоста, сохраняем и её знак с
  // началом, и конец: голый suffix терял бы семантику added/deleted стороны.
  if (/^[+\- ]/.test(lastLine) && lastLineBytes.length > tailBytes
    && tailBytes > inlineMarker.length + 4) {
    const lineHeadBytes = Math.ceil((tailBytes - inlineMarker.length) / 3);
    suffix = `${utf8Prefix(lastLineBytes, lineHeadBytes)}…${utf8Suffix(
      lastLineBytes,
      tailBytes - inlineMarker.length - lineHeadBytes,
    )}`;
  }
  return `${utf8Prefix(source, headBytes)}${DIFF_CUT_MARKER}${suffix}`;
}

function changeList(item) {
  const raw = Array.isArray(item?.changes) ? item.changes : [];
  const valid = raw.filter((change) => (
    change?.path || change?.file_path || change?.move_path
  ));
  const omittedChanges = Math.max(0, valid.length - MAX_CODEX_FILE_CHANGES);
  const selected = valid.slice(0, MAX_CODEX_FILE_CHANGES);
  let remainingBytes = MAX_CODEX_CHANGE_DIFF_BYTES;

  const changes = selected.map((change, index) => {
    const file = change?.path || change?.file_path || change?.move_path || '';
    const remainingChanges = selected.length - index;
    const fairShare = Math.floor(remainingBytes / Math.max(1, remainingChanges));
    const diff = cutDiffMiddle(
      change?.diff || change?.unified_diff || '',
      Math.min(STEP_DIFF_LIMIT, fairShare),
    );
    remainingBytes -= Buffer.byteLength(diff, 'utf8');
    return {
      path: cut(String(file), MAX_CODEX_CHANGE_PATH_CHARS),
      kind: changeKind(change),
      diff,
    };
  });
  return { changes, omittedChanges };
}

function toolOf(item) {
  if (!item || typeof item !== 'object') return null;
  const id = item.id ? String(item.id) : '';

  if (item.type === 'command_execution' || item.type === 'commandExecution') {
    const command = commandOf(item);
    return {
      id, name: 'Bash', title: cut(command.split('\n')[0], 200),
      command: cutMiddle(command, STEP_TEXT_LIMIT),
      preview: cut(item?.description || '', 200), lang: 'bash',
    };
  }

  if (item.type === 'file_change' || item.type === 'fileChange') {
    const { changes, omittedChanges } = changeList(item);
    const paths = changes.map((change) => `${change.kind}: ${change.path}`).join('\n');
    const overflow = omittedChanges > 0 ? `… ещё ${omittedChanges} файлов` : '';
    const preview = overflow
      ? `${cut(paths, Math.max(0, STEP_TEXT_LIMIT - overflow.length - 1))}\n${overflow}`
      : cut(paths, STEP_TEXT_LIMIT);
    const totalChanges = changes.length + omittedChanges;
    return {
      id, name: 'Edit',
      title: totalChanges === 1 ? base(changes[0].path) : `${totalChanges || 'несколько'} файлов`,
      preview, lines: lineCount(preview),
      // Один file_change может править сразу несколько файлов — отдаём все пути.
      files: changes.map((change) => change.path),
      changes,
      ...(omittedChanges > 0 ? { omittedChanges } : {}),
    };
  }

  if (item.type === 'mcp_tool_call' || item.type === 'mcpToolCall') {
    const server = String(item.server || item.server_name || 'mcp');
    const tool = String(item.tool || item.tool_name || item.name || 'вызов');
    const args = item.arguments ?? item.input ?? item.params ?? {};
    return {
      id, name: `mcp__${server}__${tool}`, title: tool,
      sub: server, preview: cut(textOf(args), 600),
    };
  }

  if (item.type === 'web_search' || item.type === 'webSearch') {
    return { id, name: 'WebSearch', title: cut(item.query || item.search_query || '', 200) };
  }

  if (String(item.type || '').endsWith('ToolCall')) {
    const namespace = String(item.namespace || item.type.slice(0, -'ToolCall'.length));
    const name = String(item.tool || item.name || item.type);
    const input = textOf(item.arguments ?? item.prompt ?? item.input ?? '');
    return {
      id, name, title: cut(input, 200), sub: namespace, preview: cut(input, 600),
    };
  }

  const type = String(item.type || '').toLowerCase();
  const toolCallSuffix = '_tool_call';
  if (type.endsWith(toolCallSuffix)) {
    const namespace = type.slice(0, -toolCallSuffix.length);
    const name = String(item.tool || item.tool_name || item.name || type);
    const input = toolCallInputOf(item);
    return {
      id,
      name,
      title: cut(input, 200),
      sub: namespace,
      preview: cut(input, 600),
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

function planText(params) {
  const entries = Array.isArray(params?.plan) ? params.plan : [];
  return entries.map((entry) => {
    const status = String(entry?.status || 'pending');
    const mark = status === 'completed' ? '✓' : ['inProgress', 'in_progress'].includes(status) ? '▸' : '·';
    return `${mark} ${entry?.step || entry?.content || entry?.title || ''}`;
  }).filter((line) => line.trim().length > 1).join('\n');
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
  const tools = new Map();
  const agentMessages = new Map();
  const commandOutputs = new Map();
  const reasoningSummaries = new Map();
  const fileChanges = new Map();

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
    let source = item;
    if ((item?.type === 'fileChange' || item?.type === 'file_change') && item?.id && fileChanges.has(String(item.id))) {
      source = { ...item, changes: fileChanges.get(String(item.id)) };
    }
    const tool = toolOf(source);
    if (!tool) return null;
    if (tool.id) {
      const known = tools.get(tool.id);
      // createStepSink хранит shallow-копию: мутация `known` после emit не
      // обновила бы ни SSE, ни историю. Первый emitted tool поэтому неизменяем.
      if (known) return known;
    }
    const step = { k: 'tool', ...tool };
    if (tool.id) tools.set(tool.id, step);
    out.push(step);
    return step;
  }

  function append(map, id, delta, limit = STEP_THINK_LIMIT * 2) {
    if (!id || !delta) return;
    map.set(String(id), `${map.get(String(id)) || ''}${String(delta)}`.slice(0, limit));
  }

  function completeItem(item, out) {
    if (!item || typeof item !== 'object') return;
    const id = item.id ? String(item.id) : '';

    if ((item.type === 'fileChange' || item.type === 'file_change')
      && id && Array.isArray(item.changes)) {
      if (item.changes.length || !fileChanges.has(id)) fileChanges.set(id, item.changes);
    }

    if (item.type === 'agentMessage') {
      const text = textOf(item.text || agentMessages.get(id) || '');
      agentMessages.delete(id);
      if (item.phase === 'commentary' && text.trim()) {
        out.push({ k: 'text', text: cut(text, 4000) });
      }
      return;
    }

    if (item.type === 'plan') {
      const text = textOf(item.text);
      if (text.trim()) out.push({ k: 'note', text: cut(text) });
      return;
    }

    if (item.type === 'reasoning' || item.type === 'agent_reasoning') {
      const text = reasoningSummary(item) || reasoningSummaries.get(id) || '';
      reasoningSummaries.delete(id);
      if (text.trim()) out.push({ k: 'think', text: cut(text, STEP_THINK_LIMIT) });
      return;
    }

    let completed = item;
    if ((item.type === 'commandExecution' || item.type === 'command_execution') && id) {
      const streamed = commandOutputs.get(id) || '';
      if (!resultOf(item) && streamed) completed = { ...item, aggregatedOutput: streamed };
      commandOutputs.delete(id);
    }
    const tool = ensureTool(completed, out);
    if (!tool) return;
    const text = resultOf(completed);
    const ok = itemOk(completed);
    out.push({
      k: 'res', id: tool.id, ok,
      text: cut(text, ok ? 400 : 600), lines: lineCount(text),
    });
  }

  return function toCodexSteps(event) {
    const out = [];
    if (!event || typeof event !== 'object') return out;

    const method = String(event.method || '');
    const params = event.params && typeof event.params === 'object' ? event.params : {};

    if ([
      'thread/started', 'turn/started', 'item/started', 'item/completed',
    ].includes(method)) {
      begin(params, out);
    }

    if (method === 'item/started') {
      const item = params.item || {};
      const id = item.id ? String(item.id) : '';
      if (item.type === 'agentMessage' && id) agentMessages.set(id, textOf(item.text));
      if ((item.type === 'fileChange' || item.type === 'file_change') && id) {
        fileChanges.set(id, Array.isArray(item.changes) ? item.changes : []);
      }
      // У app-server `started` часто содержит changes:[], а развёрнутый патч приходит
      // отдельным `patchUpdated`. Не отправляем пустой вызов инструмента, который потом нельзя
      // безопасно дополнить в уже сохранённой поверхностной копии.
      if (item.type !== 'fileChange' && item.type !== 'file_change') ensureTool(item, out);
      return out;
    }

    if (method === 'item/agentMessage/delta') {
      append(agentMessages, params.itemId, params.delta, 8_000);
      return out;
    }

    if (method === 'item/reasoning/summaryTextDelta') {
      append(reasoningSummaries, params.itemId, params.delta);
      return out;
    }

    // Raw reasoning text (`item/reasoning/textDelta`) намеренно не сохраняем:
    // клиентский контракт разрешает показывать summary, но не приватную цепочку.
    if (method === 'item/reasoning/textDelta' || method === 'item/reasoning/summaryPartAdded') {
      return out;
    }

    if (method === 'item/commandExecution/outputDelta') {
      append(commandOutputs, params.itemId, params.delta, STEP_TEXT_LIMIT * 4);
      return out;
    }

    if (method === 'item/fileChange/patchUpdated') {
      const id = params.itemId ? String(params.itemId) : '';
      const changes = Array.isArray(params.changes) ? params.changes : [];
      if (id) fileChanges.set(id, changes);
      if (changes.some((change) => (
        change?.path || change?.file_path || change?.move_path
      ))) {
        ensureTool({ type: 'fileChange', id, changes, status: 'inProgress' }, out);
      }
      return out;
    }

    if (method === 'turn/plan/updated') {
      const text = planText(params);
      if (text) out.push({ k: 'note', text: cut(text) });
      return out;
    }

    if (method === 'item/completed') {
      completeItem(params.item || {}, out);
      return out;
    }

    if (method === 'error') {
      const text = textOf(params.error ?? params.message ?? 'Ошибка Codex');
      out.push({ k: 'note', level: 'warn', text: cut(text, 600) });
      return out;
    }

    // Legacy `codex exec --json` оставляем для сохранённых fixture и внешних
    // потребителей normalizer-а. Рабочий transport executor-а использует app-server.
    if (['thread.started', 'turn.started', 'item.started', 'item.completed'].includes(event.type)) {
      begin(event, out);
    }

    if (event.type === 'item.started') {
      ensureTool(event.item, out);
      return out;
    }

    if (event.type === 'item.completed') {
      completeItem(event.item || {}, out);
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
