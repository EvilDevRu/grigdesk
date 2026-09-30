// Нормализация JSON-RPC notifications `codex app-server` в нейтральную ленту Cockpit.
// Legacy JSONL `codex exec --json` остаётся совместимым для старых fixture/потребителей.
// Показываем только краткое reasoning-поле, которое отдал сам Codex; raw_content
// намеренно игнорируем, чтобы не превращать ленту в раскрытие приватной цепочки мыслей.
import { Buffer } from 'node:buffer';
import {
  base, cut, cutMiddle, lineCount, STEP_DIFF_LIMIT, STEP_TEXT_LIMIT, STEP_THINK_LIMIT,
} from '../chat/streamSteps.ts';
import type { ChatStep } from '../chat/streamSteps.ts';

// Rich fileChange у app-server может содержать сотни файлов и мегабайты unified
// diff. Шаг одновременно уходит в SSE и историю, поэтому лимитируем сам контракт,
// а не только его визуальный preview.
const MAX_CODEX_FILE_CHANGES = 20;
const MAX_CODEX_CHANGE_DIFF_BYTES = 16 * 1024;
const MAX_CODEX_CHANGE_PATH_CHARS = 500;
const DIFF_CUT_MARKER = '\n… сокращено …\n';

// Элемент потока Codex. Форма зависит от типа и версии транспорта (app-server
// либо legacy JSONL), поэтому объявлено ровно то, что читает нормализатор.
interface CodexItem {
  id?: unknown;
  type?: unknown;
  text?: unknown;
  summary?: unknown;
  phase?: unknown;
  status?: unknown;
  command?: unknown;
  cmd?: unknown;
  description?: unknown;
  changes?: unknown;
  server?: unknown;
  server_name?: unknown;
  tool?: unknown;
  tool_name?: unknown;
  name?: unknown;
  namespace?: unknown;
  query?: unknown;
  search_query?: unknown;
  arguments?: unknown;
  input?: unknown;
  params?: unknown;
  prompt?: unknown;
  error?: unknown;
  success?: unknown;
  exitCode?: unknown;
  exit_code?: unknown;
  output?: unknown;
  result?: unknown;
  contentItems?: unknown;
  aggregatedOutput?: unknown;
  aggregated_output?: unknown;
  path?: unknown;
  review?: unknown;
  kind?: unknown;
  agentPath?: unknown;
  durationMs?: unknown;
  revisedPrompt?: unknown;
  savedPath?: unknown;
}

// Элементы, у которых нет вызова инструмента. Одни показывают отдельные ветки
// completeItem (ответ, размышление, план), другие — служебной строкой, третьи
// принадлежат человеку. Всё, чего в этом списке нет, обязано попасть в ленту
// хотя бы общей строкой: см. fallbackTool.
const NON_TOOL_ITEMS = new Set([
  'userMessage', 'user_message',
  'agentMessage', 'agent_message',
  'reasoning', 'agent_reasoning',
  'plan',
  'hookPrompt', 'hook_prompt',
  'contextCompaction', 'context_compaction',
  'enteredReviewMode', 'exitedReviewMode',
  'subAgentActivity', 'sub_agent_activity',
]);

// Поля, из которых складывается подпись незнакомого элемента: сначала то, что агент
// попросил, потом то, что получил. Длину режет cut() на выходе.
const DESCRIBE_FIELDS = [
  'arguments', 'prompt', 'input', 'params', 'query', 'path', 'savedPath',
  'revisedPrompt', 'text', 'output', 'result',
] as const;

const SUB_AGENT_ACTIVITY: Record<string, string> = {
  started: 'начал работу',
  interacted: 'получил сообщение',
  interrupted: 'прерван',
  completed: 'закончил',
};

// Правка файла: путь и её unified diff.
interface CodexChange {
  path?: unknown;
  file_path?: unknown;
  move_path?: unknown;
  kind?: unknown;
  type?: unknown;
  diff?: unknown;
  unified_diff?: unknown;
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join('\n');
  if (value && typeof value === 'object') {
    const record = value as { text?: unknown; content?: unknown };
    if (typeof record.text === 'string') return record.text;
    if (typeof record.content === 'string') return record.content;
    try { return JSON.stringify(value); } catch { return ''; }
  }
  return '';
}

function commandOf(item: CodexItem | null | undefined): string {
  const command = item?.command ?? item?.cmd ?? '';
  return Array.isArray(command) ? command.join(' ') : textOf(command);
}

function itemOk(item: CodexItem | null | undefined): boolean {
  if (item?.error) return false;
  if (item?.success === false) return false;
  if (item?.success === true) return true;
  if (typeof item?.exitCode === 'number') return item.exitCode === 0;
  if (typeof item?.exit_code === 'number') return item.exit_code === 0;
  return !['failed', 'error', 'declined', 'cancelled', 'canceled']
    .includes(String(item?.status || '').toLowerCase());
}

function resultOf(item: CodexItem | null | undefined): string {
  return textOf(item?.aggregatedOutput ?? item?.aggregated_output
    ?? item?.output ?? item?.result ?? item?.error ?? item?.contentItems ?? '');
}

function toolCallInputOf(item: CodexItem | null | undefined): string {
  return textOf(item?.arguments ?? item?.input ?? item?.params ?? item?.prompt ?? '');
}

function changeKind(change: CodexChange | null | undefined): string {
  const raw = change?.kind ?? change?.type ?? 'update';
  const kind = typeof raw === 'object' && raw ? (raw as { type?: unknown }).type : raw;
  if (kind === 'create') return 'add';
  if (kind === 'remove') return 'delete';
  return ['add', 'delete', 'update'].includes(String(kind)) ? String(kind) : 'update';
}

function utf8Prefix(buffer: Buffer, maxBytes: number): string {
  let end = Math.min(buffer.length, Math.max(0, maxBytes));
  while (end > 0 && end < buffer.length && (Number(buffer[end]) & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString('utf8');
}

function utf8Suffix(buffer: Buffer, maxBytes: number): string {
  let start = Math.max(0, buffer.length - Math.max(0, maxBytes));
  while (start < buffer.length && (Number(buffer[start]) & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start).toString('utf8');
}

function cutDiffMiddle(value: unknown, maxBytes: number): string {
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

// Патч без единого пути показывать нечем: строка «несколько файлов» без файлов
// ничего не сообщает, а Codex досылает такой набор отдельным уведомлением.
function hasChangePaths(changes: unknown): boolean {
  return (Array.isArray(changes) ? changes : []).some((change: CodexChange) => (
    change?.path || change?.file_path || change?.move_path
  ));
}

/**
 * У app-server поле `diff` — unified patch только у `update`. Для `add` и `delete`
 * Codex кладёт туда СОДЕРЖИМОЕ файла целиком (созданное либо удалённое) без единого
 * знака строки. Лента, читавшая его как patch, считала «+0 −0», теряла строки без
 * отступа, а строки с отступом показывала контекстом в обеих колонках — созданный
 * файл выглядел пустой правкой. Контракт ленты — patch, поэтому содержимое
 * разворачивается в один hunk с нужным знаком; уже готовый patch не оборачиваем.
 */
function patchOf(change: CodexChange | null | undefined, kind: string): string {
  const raw = String(change?.diff || change?.unified_diff || '');
  if (kind === 'update' || !raw || /^(diff --git |@@ -\d)/.test(raw)) return raw;

  const lines = (raw.endsWith('\n') ? raw.slice(0, -1) : raw).split('\n');
  const sign = kind === 'add' ? '+' : '-';
  const header = kind === 'add'
    ? `@@ -0,0 +1,${lines.length} @@`
    : `@@ -1,${lines.length} +0,0 @@`;
  return `${header}\n${lines.map((line) => `${sign}${line}`).join('\n')}\n`;
}

function changeList(item: CodexItem | null | undefined) {
  const raw = (Array.isArray(item?.changes) ? item.changes : []) as CodexChange[];
  const valid = raw.filter((change) => (
    change?.path || change?.file_path || change?.move_path
  ));
  const omittedChanges = Math.max(0, valid.length - MAX_CODEX_FILE_CHANGES);
  const selected = valid.slice(0, MAX_CODEX_FILE_CHANGES);
  let remainingBytes = MAX_CODEX_CHANGE_DIFF_BYTES;

  const changes = selected.map((change, index) => {
    const file = change?.path || change?.file_path || change?.move_path || '';
    const kind = changeKind(change);
    const remainingChanges = selected.length - index;
    const fairShare = Math.floor(remainingBytes / Math.max(1, remainingChanges));
    const diff = cutDiffMiddle(patchOf(change, kind), Math.min(STEP_DIFF_LIMIT, fairShare));
    remainingBytes -= Buffer.byteLength(diff, 'utf8');
    return {
      path: cut(String(file), MAX_CODEX_CHANGE_PATH_CHARS),
      kind,
      diff,
    };
  });
  return { changes, omittedChanges };
}

function describeItem(item: CodexItem): string {
  for (const field of DESCRIBE_FIELDS) {
    const text = textOf((item as Record<string, unknown>)[field]);
    if (text.trim()) return text;
  }
  return '';
}

/**
 * Незнакомый тип элемента обязан деградировать в честную строку ленты, а не исчезать.
 * Codex дописывает типы (`functionCallOutput`, `imageView`, `sleep`, …) быстрее, чем
 * Кокпит разбирает их поимённо, а молча пропущенное действие заставляет человека
 * читать ленту как полный отчёт и верить, что агент сделал меньше, чем сделал.
 */
function fallbackTool(item: CodexItem, id: string): Record<string, unknown> {
  const type = String(item.type);
  const description = describeItem(item);
  return {
    id,
    name: String(item.tool || item.tool_name || item.name || type),
    title: cut(description || type, 200),
    preview: cut(description, 600),
  };
}

/**
 * Событие без вызова и результата: сжатие контекста, режим ревью, работа субагента.
 * Показываем сам факт — именно он объясняет, почему ход выглядит рваным.
 */
function itemNote(item: CodexItem | null | undefined): string {
  const type = String(item?.type || '');
  if (type === 'contextCompaction' || type === 'context_compaction') {
    return 'Codex сжал контекст хода.';
  }
  if (type === 'enteredReviewMode') return `Codex начал ревью: ${textOf(item?.review)}`;
  if (type === 'exitedReviewMode') return `Codex закончил ревью: ${textOf(item?.review)}`;
  if (type === 'subAgentActivity' || type === 'sub_agent_activity') {
    const what = SUB_AGENT_ACTIVITY[String(item?.kind || '')] || String(item?.kind || 'работает');
    return `Субагент ${textOf(item?.agentPath) || '(без имени)'}: ${what}.`;
  }
  return '';
}

function meaningful(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return false;
  return !(Array.isArray(value) && value.length === 0);
}

/**
 * Строка вызова НАКАПЛИВАЕТ знание о нём, а не переписывается последним уведомлением:
 * `item/completed` у Codex часто приходит без аргументов и без описания, и замена
 * обеднила бы уже показанную строку. Пустое поле свежей версии оставляет прежнее.
 */
function mergeTool(known: ChatStep, fresh: Record<string, unknown>): ChatStep {
  const merged: ChatStep = { ...known };
  for (const [field, value] of Object.entries(fresh)) {
    if (meaningful(value)) merged[field] = value;
  }
  return merged;
}

function toolOf(item: CodexItem | null | undefined): Record<string, unknown> | null {
  if (!item || typeof item !== 'object') return null;
  // Элемент без типа приходит из пустого `params.item` — вызова за ним нет.
  if (!item.type) return null;
  if (NON_TOOL_ITEMS.has(String(item.type))) return null;
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
      title: totalChanges === 1 ? base(changes[0]?.path) : `${totalChanges || 'несколько'} файлов`,
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
    const namespace = String(item.namespace || String(item.type).slice(0, -'ToolCall'.length));
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

  return fallbackTool(item, id);
}

function reasoningSummary(item: CodexItem | null | undefined): string {
  // `raw_content` и похожие технические поля сюда не добавляем. `text`/`summary`
  // — единственные явные, предназначенные для клиента поля reasoning item.
  if (typeof item?.text === 'string') return item.text;
  if (typeof item?.summary === 'string') return item.summary;
  if (Array.isArray(item?.summary)) {
    return item.summary.map((part) => textOf(part)).filter(Boolean).join('\n');
  }
  return '';
}

function planText(params: { plan?: unknown } | null | undefined): string {
  const entries = (Array.isArray(params?.plan) ? params.plan : []) as Array<{
    status?: unknown;
    step?: unknown;
    content?: unknown;
    title?: unknown;
  }>;
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
  const tools = new Map<string, ChatStep>();
  const agentMessages = new Map<string, string>();
  const commandOutputs = new Map<string, string>();
  const reasoningSummaries = new Map<string, string>();
  const fileChanges = new Map<string, unknown[]>();

  function begin(
    event: { model?: unknown; thread?: { model?: unknown } } | null | undefined,
    out: ChatStep[],
  ): void {
    if (started) return;
    started = true;
    out.push({
      k: 'start',
      model: event?.model || event?.thread?.model || model || '',
      mode,
      cwd,
    });
  }

  /**
   * Показывает вызов инструмента и обновляет уже показанный, когда Codex дослал
   * подробности: растущий патч, дополненные аргументы. Обновление уходит ОТДЕЛЬНЫМ
   * шагом с тем же id — и SSE, и история хранят поверхностные копии, поэтому
   * починить уже отправленную строку мутацией нельзя. Раньше первый показ был
   * неизменяем, и правка, о которой Codex сообщил в два приёма, оставалась в ленте
   * первым, самым бедным своим вариантом: три файла показывались одним.
   */
  function ensureTool(item: CodexItem | null | undefined, out: ChatStep[]): ChatStep | null {
    let source = item;
    if ((item?.type === 'fileChange' || item?.type === 'file_change')
      && item?.id && fileChanges.has(String(item.id))) {
      source = { ...item, changes: fileChanges.get(String(item.id)) };
    }
    const tool = toolOf(source);
    if (!tool) return null;
    const id = tool.id ? String(tool.id) : '';
    const known = id ? tools.get(id) : null;
    const step: ChatStep = known
      ? mergeTool(known, tool)
      : { k: 'tool', ...tool };
    if (known && JSON.stringify(known) === JSON.stringify(step)) return known;
    if (id) tools.set(id, step);
    out.push(step);
    return step;
  }

  function append(
    map: Map<string, string>,
    id: unknown,
    delta: unknown,
    limit = STEP_THINK_LIMIT * 2,
  ): void {
    if (!id || !delta) return;
    map.set(String(id), `${map.get(String(id)) || ''}${String(delta)}`.slice(0, limit));
  }

  function completeItem(item: CodexItem | null | undefined, out: ChatStep[]): void {
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
        // Id связывает текстовый шаг с видимым блоком ответа: окно показывает блок,
        // а старый клиент продолжает видеть шаг — без дубля у обоих.
        out.push({
          k: 'text',
          id,
          text: cut(text, 4000),
        });
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

    const note = itemNote(item);
    if (note) {
      out.push({ k: 'note', text: cut(note) });
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

  return function toCodexSteps(value: unknown): ChatStep[] {
    const out: ChatStep[] = [];
    if (!value || typeof value !== 'object') return out;

    const event = value as {
      method?: unknown;
      params?: Record<string, unknown>;
      type?: unknown;
      item?: CodexItem;
      error?: unknown;
      message?: unknown;
      reason?: unknown;
    };
    const method = String(event.method || '');
    const params = (event.params && typeof event.params === 'object'
      ? event.params
      : {}) as Record<string, unknown>;

    if ([
      'thread/started', 'turn/started', 'item/started', 'item/completed',
    ].includes(method)) {
      begin(params, out);
    }

    if (method === 'item/started') {
      const item = (params.item || {}) as CodexItem;
      const id = item.id ? String(item.id) : '';
      if (item.type === 'agentMessage' && id) agentMessages.set(id, textOf(item.text));
      if ((item.type === 'fileChange' || item.type === 'file_change') && id) {
        fileChanges.set(id, Array.isArray(item.changes) ? item.changes : []);
      }
      // 0.15x кладёт полный патч уже в `started`, ранние версии досылают его отдельным
      // `patchUpdated`. Показываем правку, как только известен хоть один файл, и
      // дополняем её потом (ensureTool умеет обновлять). Пустой вызов не показываем:
      // «несколько файлов» без единого пути ничего не сообщает. Ждать `completed`
      // нельзя — патч к этому моменту уже на диске, и оборванный ход прятал бы
      // применённую правку целиком.
      const emptyPatch = (item.type === 'fileChange' || item.type === 'file_change')
        && !hasChangePaths(item.changes);
      if (!emptyPatch) ensureTool(item, out);
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
      const changes = (Array.isArray(params.changes) ? params.changes : []) as CodexChange[];
      if (id) fileChanges.set(id, changes);
      if (hasChangePaths(changes)) {
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
      completeItem((params.item || {}) as CodexItem, out);
      return out;
    }

    if (method === 'error') {
      // `params.error` — объект TurnError. Раньше он уезжал в ленту целиком через
      // JSON.stringify, и штатный ретрай сети читался как поломка: человек видел
      // сырой `{"message":"Reconnecting… 2/5","codexErrorInfo":…}`.
      const error = (params.error && typeof params.error === 'object'
        ? params.error
        : {}) as { message?: unknown; additionalDetails?: unknown };
      const message = textOf(error.message ?? params.error ?? params.message ?? 'Ошибка Codex');
      const details = typeof error.additionalDetails === 'string' ? error.additionalDetails : '';
      const retry = params.willRetry === true ? 'Codex повторит запрос. ' : '';
      out.push({
        k: 'note',
        level: 'warn',
        text: cut(`${retry}${message}${details ? `\n${details}` : ''}`, 600),
      });
      return out;
    }

    // Служебные уведомления хода: молчать о них нельзя. Подменённая модель и сжатие
    // контекста объясняют и рваную ленту, и внезапно другое поведение агента.
    if (method === 'model/rerouted') {
      const from = textOf(params.fromModel);
      const to = textOf(params.toModel);
      out.push({
        k: 'note',
        level: 'warn',
        text: cut(`Codex переключил модель: ${from || '?'} → ${to || '?'}`
          + `${params.reason ? ` (${textOf(params.reason)})` : ''}`, 600),
      });
      return out;
    }

    if (method === 'thread/compacted') {
      out.push({ k: 'note', text: 'Codex сжал контекст хода.' });
      return out;
    }

    if (method === 'warning' || method === 'guardianWarning') {
      const text = textOf(params.message);
      if (text.trim()) out.push({ k: 'note', level: 'warn', text: cut(text, 600) });
      return out;
    }

    // Legacy `codex exec --json` оставляем для сохранённых fixture и внешних
    // потребителей normalizer-а. Рабочий transport executor-а использует app-server.
    if ([
      'thread.started', 'turn.started', 'item.started', 'item.completed',
    ].includes(String(event.type))) {
      begin(event as { model?: unknown }, out);
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

    if (['error', 'turn.failed', 'turn.error'].includes(String(event.type))) {
      const text = textOf(event.error ?? event.message ?? event.reason ?? 'Ошибка Codex');
      out.push({ k: 'note', level: 'warn', text: cut(text, 600) });
    }

    return out;
  };
}
