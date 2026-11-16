import { recordOrNull } from '../../../../shared/lib/objects.ts';

import { cut, lineCount, STEP_THINK_LIMIT } from '../chat/streamSteps.ts';
import {
  acpToolStep, firstString, parseAcpContent, type AcpDiff, type AcpContent,
} from '../chat/acpSteps.ts';
import type { ChatStep } from '../chat/streamSteps.ts';

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
  diffs: AcpDiff[];
  status: string;
  emitted: boolean;
  resultEmitted: boolean;
}

function meaningfulKind(value: unknown): string {
  const kind = typeof value === 'string' ? value.trim() : '';
  return kind && kind.toLowerCase() !== 'other' ? kind : '';
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

// Каноническое повышение sparse-дельты: осмысленный kind или структурный diff
// плюс содержательные title/rawInput/locations; иначе строку рано выпускать.
function canonicalPayload(update: KimiUpdate, parsed: AcpContent): boolean {
  const kind = typeof update.kind === 'string' ? update.kind.trim().toLowerCase() : '';
  // Lazy ACP-дельта может уже называться `other` и нести обрывок rawInput. Это
  // всё ещё не канонический upgrade: безопасным самостоятельным сигналом без
  // meaningful kind служит только структурный diff.
  if ((!kind || kind === 'other') && !parsed.diffs.length) return false;
  const raw = recordOrNull(update.rawInput);
  return Boolean(
    (typeof update.title === 'string' && update.title.trim())
    || (raw && Object.keys(raw).length)
    || (Array.isArray(update.locations) && update.locations.length)
    || parsed.diffs.length,
  );
}

// Накопление состояния вызова между дельтами: kind, title, rawInput, locations;
// диффы дополняются, канонический снимок их заменяет; дельта other не понижает тип.
function mergeToolUpdate(
  state: ToolState,
  update: KimiUpdate,
  parsed: AcpContent,
  canonical: boolean,
): ToolState {
  const kind = meaningfulKind(update.kind);
  if (kind) state.kind = kind;
  else if (!state.kind && typeof update.kind === 'string' && update.kind.trim()) {
    state.kind = update.kind;
  }
  const title = typeof update.title === 'string' ? update.title.trim() : '';
  if (title && (title.toLowerCase() !== 'other' || !state.title)) state.title = String(update.title);
  const raw = recordOrNull(update.rawInput);
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
    // GrigDesk терял единственное, ради чего ленту и раскрывают.
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
      const parsed = parseAcpContent(update.content);
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
        const step = acpToolStep(state);
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

/**
 * Серверный output бывает строкой, ACP-массивом, прямым блоком или content-объектом.
 * Известные блоки разбираются общим парсером; неизвестный объект сохраняет поля
 * в JSON, а не превращается в object Object. Обрезку выполняет вызывающий.
 */
function kimiServerOutputText(output: unknown): string {
  if (typeof output === 'string') {
    return output;
  }

  const record = recordOrNull(output);
  const content = Array.isArray(output)
    ? output
    : Array.isArray(record?.content) ? record.content : [output];
  const blocks = content.map((value) => {
    const block = recordOrNull(value);

    return block && ['text', 'image'].includes(String(block.type))
      ? { type: 'content', content: block }
      : value;
  });
  const parsed = parseAcpContent(blocks);

  if (parsed.text) {
    return parsed.text;
  }
  if (parsed.diffs.length) {
    return parsed.diffs.map((diff) => diff.path).filter(Boolean).join('\n');
  }
  if (record) {
    return typeof record.text === 'string' ? record.text : JSON.stringify(record);
  }

  return Array.isArray(output) ? '' : String(output ?? '');
}

/**
 * Итог инструмента серверного web-потока Kimi получает текст без wire-обёрток;
 * пределы 400/600 и счётчик строк, как у ленты ACP.
 */
export function kimiServerResultStep(payload: Record<string, unknown>): ChatStep {
  const ok = payload.isError !== true && payload.is_error !== true;
  const text = kimiServerOutputText(payload.output);

  return {
    k: 'res',
    id: String(payload.toolCallId || payload.tool_call_id || ''),
    ok,
    text: cut(text, ok ? 400 : 600),
    lines: lineCount(text),
  };
}
