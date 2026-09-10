import {
  base, cut, cutMiddle, lineCount, STEP_TEXT_LIMIT, STEP_THINK_LIMIT,
} from '../chat/streamSteps.ts';
import type { ChatStep } from '../chat/streamSteps.ts';

const KIMI_CHANGE_LIMIT = 20;
const KIMI_DIFF_TEXT_BUDGET = 16 * 1024;
const KIMI_CHANGE_PATH_LIMIT = 500;
const MIDDLE_MARKER = '\n… сокращено …\n';

/**
 * Блоки content ACP: текст и структурный diff. Форма диффа — `{type:'diff', path,
 * oldText, newText}`; поля `diff` у него нет, и чтение несуществующего поля
 * оставляло правку файла в ленте пустой строкой.
 */
// Структурная правка файла из блока content ACP.
interface KimiDiff {
  path: string;
  old: string;
  new: string;
}

// Разобранный content дельты: текст и все её правки.
interface ParsedContent {
  text: string;
  diffs: KimiDiff[];
}

// Дельта ACP: форма зависит от sessionUpdate, поэтому все поля необязательны.
export interface KimiUpdate {
  sessionUpdate?: string;
  toolCallId?: unknown;
  kind?: unknown;
  title?: unknown;
  status?: unknown;
  rawInput?: unknown;
  locations?: unknown;
  content?: unknown;
  entries?: unknown;
}

// Накопленное состояние одного вызова инструмента между дельтами.
interface ToolState {
  id: unknown;
  kind: string;
  title: string;
  rawInput: Record<string, unknown>;
  locations: Array<{ path?: unknown } | null>;
  text: string;
  diffs: KimiDiff[];
  status: string;
  emitted: boolean;
  resultEmitted: boolean;
}

function splitContent(content: unknown): ParsedContent {
  const list = (Array.isArray(content) ? content : []) as Array<{
    type?: string;
    path?: unknown;
    oldText?: unknown;
    newText?: unknown;
    content?: { type?: string; text?: unknown };
  } | null>;
  const texts: string[] = [];
  const diffs: KimiDiff[] = [];
  for (const entry of list) {
    if (entry?.type === 'diff') {
      diffs.push({
        path: String(entry.path || ''),
        old: String(entry.oldText ?? ''),
        new: String(entry.newText ?? ''),
      });
      continue;
    }
    if (entry?.type === 'content' && entry.content?.type === 'text') {
      const text = String(entry.content.text || '');
      if (text.trim()) texts.push(text);
    }
  }
  return { text: texts.join('\n'), diffs };
}

function firstString(...values: unknown[]): string {
  return String(values.find((value) => typeof value === 'string' && value.trim()) || '');
}

function objectInput(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function uniquePaths(values: unknown[]): string[] {
  return [...new Set(values.map((value) => String(value || '')).filter(Boolean))];
}

function boundedPath(value: unknown): string {
  const path = String(value || '');
  if (path.length <= KIMI_CHANGE_PATH_LIMIT) return path;
  return `${path.slice(0, KIMI_CHANGE_PATH_LIMIT - 1)}…`;
}

function meaningfulKind(value: unknown): string {
  const kind = typeof value === 'string' ? value.trim() : '';
  return kind && kind.toLowerCase() !== 'other' ? kind : '';
}

function utf8Prefix(value: unknown, byteLimit: number): string {
  const chars: string[] = [];
  let bytes = 0;
  for (const char of String(value ?? '')) {
    const size = Buffer.byteLength(char);
    if (bytes + size > byteLimit) break;
    chars.push(char);
    bytes += size;
  }
  return chars.join('');
}

function utf8Suffix(value: unknown, byteLimit: number): string {
  const source = Array.from(String(value ?? ''));
  const chars: string[] = [];
  let bytes = 0;
  for (let index = source.length - 1; index >= 0; index--) {
    const char = String(source[index]);
    const size = Buffer.byteLength(char);
    if (bytes + size > byteLimit) break;
    chars.push(char);
    bytes += size;
  }
  return chars.reverse().join('');
}

function cutMiddleBytes(value: unknown, byteLimit: number): string {
  const text = String(value ?? '');
  if (Buffer.byteLength(text) <= byteLimit) return text;
  const markerBytes = Buffer.byteLength(MIDDLE_MARKER);
  if (byteLimit <= markerBytes) return utf8Prefix(text, byteLimit);
  const available = byteLimit - markerBytes;
  const head = Math.ceil(available / 2);
  return `${utf8Prefix(text, head)}${MIDDLE_MARKER}${utf8Suffix(text, available - head)}`;
}

function boundedDiff(diff: KimiDiff, byteBudget: number): { old: string; new: string } {
  const old = String(diff.old ?? '');
  const next = String(diff.new ?? '');
  const oldBytes = Buffer.byteLength(old);
  const newBytes = Buffer.byteLength(next);
  if (oldBytes + newBytes <= byteBudget) return { old, new: next };

  let oldBudget = old ? Math.floor(byteBudget / 2) : 0;
  let newBudget = next ? byteBudget - oldBudget : 0;
  if (!old) newBudget = byteBudget;
  if (!next) oldBudget = byteBudget;
  if (oldBytes < oldBudget) {
    newBudget += oldBudget - oldBytes;
    oldBudget = oldBytes;
  }
  if (newBytes < newBudget) {
    oldBudget += newBudget - newBytes;
    newBudget = newBytes;
  }
  return {
    old: cutMiddleBytes(old, oldBudget),
    new: cutMiddleBytes(next, newBudget),
  };
}

function boundedChanges(diffs: KimiDiff[]) {
  const selected = diffs.slice(0, KIMI_CHANGE_LIMIT);
  let remaining = KIMI_DIFF_TEXT_BUDGET;
  return selected.map((diff, index) => {
    const slots = selected.length - index;
    const budget = Math.floor(remaining / slots);
    const bounded = boundedDiff(diff, budget);
    remaining -= Buffer.byteLength(bounded.old) + Buffer.byteLength(bounded.new);
    return {
      path: boundedPath(diff.path),
      kind: diffKind(diff),
      diff: bounded,
    };
  });
}

function diffKind(diff: KimiDiff): string {
  if (!diff.old && diff.new) return 'add';
  if (diff.old && !diff.new) return 'delete';
  return 'update';
}

function mergeLocations(current: unknown, incoming: unknown): Array<{ path?: unknown } | null> {
  const out = (Array.isArray(current) ? [...current] : []) as Array<{ path?: unknown } | null>;
  for (const location of Array.isArray(incoming) ? incoming : []) {
    const path = String(location?.path || '');
    if (!path || out.some((known) => String(known?.path || '') === path)) continue;
    out.push(location);
  }
  return out;
}

function canonicalPayload(update: KimiUpdate, parsed: ParsedContent): boolean {
  const kind = typeof update.kind === 'string' ? update.kind.trim().toLowerCase() : '';
  // Lazy ACP-дельта может уже называться `other` и нести обрывок rawInput. Это
  // всё ещё не канонический upgrade: безопасным самостоятельным сигналом без
  // meaningful kind служит только структурный diff.
  if ((!kind || kind === 'other') && !parsed.diffs.length) return false;
  const raw = objectInput(update.rawInput);
  return Boolean(
    (typeof update.title === 'string' && update.title.trim())
    || (raw && Object.keys(raw).length)
    || (Array.isArray(update.locations) && update.locations.length)
    || parsed.diffs.length,
  );
}

function mergeToolUpdate(
  state: ToolState,
  update: KimiUpdate,
  parsed: ParsedContent,
  canonical: boolean,
): ToolState {
  const kind = meaningfulKind(update.kind);
  if (kind) state.kind = kind;
  else if (!state.kind && typeof update.kind === 'string' && update.kind.trim()) {
    state.kind = update.kind;
  }
  const title = typeof update.title === 'string' ? update.title.trim() : '';
  if (title && (title.toLowerCase() !== 'other' || !state.title)) state.title = String(update.title);
  const raw = objectInput(update.rawInput);
  if (raw) state.rawInput = { ...state.rawInput, ...raw };
  state.locations = mergeLocations(state.locations, update.locations);
  if (parsed.text) state.text = parsed.text;
  // Некоторые Edit-вызовы несут точную пару прямо в rawInput, без отдельного
  // ACP content.diff. Это уже rich payload: его можно безопасно показать сразу,
  // сохранив живую строку файла и не дожидаясь terminal fallback.
  const rawOld = raw?.old_string ?? raw?.oldText;
  const rawNew = raw?.new_string ?? raw?.newText;
  if (kind === 'edit' && (rawOld !== undefined || rawNew !== undefined)) {
    const rawChange = {
      path: firstString(raw?.path, raw?.file_path, state.locations[0]?.path),
      old: String(rawOld ?? ''),
      new: String(rawNew ?? ''),
    };
    if (!state.diffs.some((known) => (
      known.path === rawChange.path && known.old === rawChange.old && known.new === rawChange.new
    ))) state.diffs.push(rawChange);
  }
  if (parsed.diffs.length) {
    // Upgrade содержит авторитетный снимок вызова. Sparse diff-дельты до него
    // накапливаем и схлопываем по точному содержимому, чтобы не терять блоки.
    if (canonical && kind) state.diffs = [];
    for (const diff of parsed.diffs) {
      const duplicate = state.diffs.some((known) => (
        known.path === diff.path && known.old === diff.old && known.new === diff.new
      ));
      if (!duplicate) state.diffs.push(diff);
    }
  }
  if (typeof update.status === 'string' && update.status) state.status = update.status;
  return state;
}

/**
 * Шаг ленты из tool_call/tool_call_update. Аргументы берём из `rawInput` — он
 * приходит только на upgrade вызова (`in_progress`), поэтому строку ленты
 * собираем именно тогда, а не на lazy-create первой дельты.
 */
function toolStep(state: ToolState): ChatStep {
  const { id } = state;
  const kind = String(state.kind || 'other');
  const raw = state.rawInput;
  const text = state.text;
  const title = String(state.title || kind);

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

  if (kind === 'edit' || state.diffs.length) {
    const locationPaths = state.locations.map((location) => location?.path);
    const fallback = firstString(locationPaths[0], raw.path, raw.file_path);
    const diffs = state.diffs.map((diff, index) => ({
      ...diff,
      path: firstString(diff.path, locationPaths[index], index === 0 ? fallback : ''),
    }));
    const allFiles = uniquePaths([
      ...diffs.map((diff) => diff.path),
      ...locationPaths,
      raw.path,
      raw.file_path,
    ]);
    const files = allFiles.slice(0, KIMI_CHANGE_LIMIT).map(boundedPath);
    const file = firstString(files[0], boundedPath(fallback));
    const changes = boundedChanges(diffs);
    const omittedChanges = Math.max(
      0,
      diffs.length - changes.length,
      allFiles.length - files.length,
    );
    return {
      k: 'tool', id, name: 'Edit',
      title: file ? base(file) : cut(title, 200),
      sub: file,
      files,
      ...(changes.length ? { changes } : {}),
      ...(omittedChanges
        ? { omittedChanges, preview: `… ещё ${omittedChanges} файлов` }
        : {}),
      ...(!changes.length && !omittedChanges
        ? { preview: cut(text || JSON.stringify(raw), 600) }
        : {}),
    };
  }

  if (kind === 'read') {
    const file = boundedPath(firstString(state.locations[0]?.path, raw.path, raw.file_path));
    return {
      k: 'tool', id, name: 'Read', title: file ? base(file) : cut(title, 200), sub: file,
    };
  }

  if (kind === 'search') {
    return {
      k: 'tool', id, name: 'Grep',
      title: cut(firstString(raw.pattern, raw.query, raw.regex) || title, 200),
      sub: boundedPath(firstString(raw.path, raw.glob)),
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
  const tools = new Map<unknown, ToolState>();

  // Размышление приходит потоком мелких кусков: каждый отдельным шагом превратил бы
  // ленту в лапшу из обрывков. Копим и отдаём одним шагом перед следующим действием
  // агента (и в конце хода — flush()).
  function flushThought(out: ChatStep[]): ChatStep[] {
    const text = thought.trim();
    thought = '';
    if (text) out.push({ k: 'think', text: cut(text, STEP_THINK_LIMIT) });
    return out;
  }

  function normalize(params: { update?: KimiUpdate } | null | undefined): ChatStep[] {
    const update = params?.update;
    if (!update || typeof update !== 'object') return [];
    const out: ChatStep[] = [];
    if (!started && [
      'agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update', 'plan',
    ].includes(String(update.sessionUpdate))) {
      started = true;
      out.push({ k: 'start', model, cwd, mode });
    }

    // Размышление Kimi — то же, что thinking у Claude: это опубликованный агентом
    // текст, а не приватная цепочка. Пряча его за «Kimi анализирует задачу…»,
    // кокпит терял единственное, ради чего ленту и раскрывают.
    if (update.sessionUpdate === 'agent_thought_chunk') {
      const chunk = update.content as { type?: string; text?: unknown } | null;
      const text = chunk?.type === 'text' ? String(chunk.text || '') : '';
      // Потолок вдвое выше лимита шага: хвост всё равно срежет cut, а копить
      // мегабайты в памяти хода незачем.
      if (text) thought = `${thought}${text}`.slice(0, STEP_THINK_LIMIT * 2);
      return out;
    }

    flushThought(out);

    if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      const id = update.toolCallId;
      const parsed = splitContent(update.content);
      const canonical = canonicalPayload(update, parsed);
      const state: ToolState = tools.get(id) || {
        id,
        kind: '',
        title: '',
        rawInput: {},
        locations: [],
        text: '',
        diffs: [],
        status: '',
        emitted: false,
        resultEmitted: false,
      };
      mergeToolUpdate(state, update, parsed, canonical);
      tools.set(id, state);
      const terminal = ['completed', 'failed'].includes(String(update.status));
      // Лента допускает только добавление: уже отданный шаг не исправить. Первый вызов инструмента —
      // это ленивое создание по первой дельте аргументов (без rawInput, с обрезанным
      // именем), поэтому разреженное обновление лишь накапливаем. Строку выпускает
      // каноническое повышение с типом и аргументами либо терминальный запасной путь.
      // У Edit каноническое повышение с kind/rawInput может предшествовать отдельной
      // дельте дифа. Ранний вызов инструмента уже нельзя обогатить, поэтому ждём
      // структурированный диф; терминальный путь остаётся для правок без такого блока.
      const waitsForEditDiff = state.kind === 'edit' && state.diffs.length === 0;
      const ready = update.status !== 'pending' && canonical && !waitsForEditDiff;
      if (!state.emitted && (ready || terminal)) {
        const step = toolStep(state);
        state.emitted = true;
        out.push(step);
      }
      if (terminal && !state.resultEmitted) {
        const result = parsed.text || parsed.diffs.map((diff) => diff.path).filter(Boolean).join('\n');
        state.resultEmitted = true;
        out.push({
          k: 'res', id, ok: update.status === 'completed',
          text: cut(result, update.status === 'completed' ? 400 : 600), lines: lineCount(result),
        });
      }
      return out;
    }

    if (update.sessionUpdate === 'plan') {
      const entries = (Array.isArray(update.entries) ? update.entries : []) as Array<{
        status?: unknown;
        content?: unknown;
        title?: unknown;
      }>;
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
