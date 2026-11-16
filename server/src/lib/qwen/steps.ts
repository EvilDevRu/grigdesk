import { randomUUID } from 'node:crypto';

import { isRecord, recordOrNull } from '../../../../shared/lib/objects.ts';
import {
  acpToolStep, firstString, parseAcpContent, type AcpToolState,
} from '../chat/acpSteps.ts';
import {
  cut, lineCount, STEP_TEXT_LIMIT, STEP_THINK_LIMIT, type ChatStep,
} from '../chat/streamSteps.ts';

/**
 * ACP передаёт дельты текста, а лента хранит законченные смысловые блоки.
 * Каналы могут чередоваться внутри слова, поэтому только явная граница закрывает блоки.
 */
export function createQwenTextSteps(now: () => number = Date.now) {
  const prefix = randomUUID();
  let sequence = 0;
  const pending = new Map<'think' | 'text', { text: string; at: number }>();

  /**
   * Хвост выпускается один раз, включая завершение с ошибкой или отменой.
   * Порядок первых дельт сохраняет место каждого канала перед следующим действием.
   */
  function flush(): ChatStep[] {
    const steps: ChatStep[] = [];

    for (const [kind, block] of pending) {
      const text = block.text.trim();

      if (text) {
        steps.push({
          k: kind,
          id: `${prefix}-${++sequence}`,
          text: cut(text, kind === 'think' ? STEP_THINK_LIMIT : STEP_TEXT_LIMIT),
          at: block.at,
        });
      }
    }

    pending.clear();

    return steps;
  }

  /**
   * Пробелы между дельтами сохраняются, каждый канал ограничен лимитом предпросмотра.
   * Полный ответ отдельно собирает runtime; этот буфер не определяет его длину.
   */
  function append(next: 'think' | 'text', text: string): ChatStep[] {
    if (!text) {
      return [];
    }

    let block = pending.get(next);

    if (!block) {
      block = { text: '', at: now() };
      pending.set(next, block);
    }

    const limit = next === 'think' ? STEP_THINK_LIMIT : STEP_TEXT_LIMIT;

    block.text = (block.text + text).slice(0, limit + 1);

    return [];
  }

  return { append, flush };
}

/**
 * Native LSP может вернуть диагностическую ошибку со статусом completed.
 * Учитываем его формат только при builtin identity, не по тексту файлов или MCP.
 */
export function qwenToolFailed(update: Record<string, unknown>): boolean {
  if (update.status === 'failed') {
    return true;
  }

  const meta = isRecord(update._meta) ? update._meta : {};

  return update.status === 'completed' && meta.toolName === 'lsp' && meta.provenance === 'builtin'
    && typeof update.rawOutput === 'string' && /^LSP [^\r\n:]+ failed: /.test(update.rawOutput);
}

/**
 * Итог инструмента Qwen для ленты: человеческий текст вместо wire-JSON,
 * картинка заглушкой, пределы 400/600 как у остальных исполнителей.
 * Исход определяет qwenToolFailed, включая LSP completed-but-failed.
 */
export function qwenToolResult(update: Record<string, unknown>): ChatStep {
  const failed = qwenToolFailed(update);
  const parsed = parseAcpContent(update.content);
  const text = parsed.text || parsed.diffs.map((diff) => diff.path).filter(Boolean).join('\n');

  return {
    k: 'res',
    id: String(update.toolCallId || ''),
    text: cut(text, failed ? 600 : 400),
    lines: lineCount(text),
    ok: !failed,
    error: failed,
  };
}

/**
 * Коллектор строк и итогов инструментов Qwen, общий для живого хода и фонового
 * цикла. Строка выпускается по первой дельте и обновляется тем же id при изменении
 * ограниченной проекции; итог выпускается один раз на toolCallId человеческим
 * текстом, а не wire-JSON.
 */
export function createQwenToolSteps() {
  const tools = new Map<string, AcpToolState & {
    lastStep: string;
    currentPath: string;
  }>();
  const results = new Set<string>();

  /**
   * Принимает дельту ACP и отдаёт шаги ленты: строка вызова выпускается сразу
   * и обновляется тем же id при досылке аргументов; итог один раз на вызов.
   */
  function observe(update: Record<string, unknown>): ChatStep[] {
    const kind = String(update.sessionUpdate || '');
    const id = String(update.toolCallId || '');

    if (!id || (kind !== 'tool_call' && kind !== 'tool_call_update')) {
      return [];
    }

    const parsed = parseAcpContent(update.content);
    const terminal = ['completed', 'failed'].includes(String(update.status));
    const state = tools.get(id) || {
      id,
      kind: '',
      title: '',
      rawInput: {},
      locations: [],
      text: '',
      diffs: [],
      lastStep: '',
      currentPath: '',
    };

    if (typeof update.kind === 'string' && update.kind.trim()) {
      const nextKind = update.kind.trim();

      if (nextKind.toLowerCase() !== 'other' || !state.kind || state.kind.toLowerCase() === 'other') {
        state.kind = nextKind;
      }
    }
    if (typeof update.title === 'string' && update.title.trim()) {
      const nextTitle = update.title.trim();

      if (nextTitle.toLowerCase() !== 'other' || !state.title) {
        state.title = nextTitle;
      }
    }

    const raw = recordOrNull(update.rawInput);

    if (raw) {
      state.rawInput = { ...state.rawInput, ...raw };
    }

    const locations = Array.isArray(update.locations) ? update.locations : [];
    const currentLocation = locations.find((location) => {
      const path = (location as { path?: unknown } | null)?.path;

      return typeof path === 'string' && Boolean(path.trim());
    });
    const nextPath = firstString(
      (currentLocation as { path?: unknown } | null)?.path,
      raw?.path,
      raw?.file_path,
    );

    if (nextPath) {
      state.currentPath = nextPath;
    }

    const readPath = state.kind === 'read' ? state.currentPath : '';

    if (readPath) {
      state.locations = [{ path: readPath }];
    }

    for (const location of readPath ? [] : locations) {
      const path = String((location as { path?: unknown } | null)?.path || '');

      if (path && !state.locations.some((known) => String(known?.path || '') === path)) {
        state.locations.push(location as { path?: unknown });
      }
    }

    if (parsed.text && !terminal) {
      state.text = parsed.text;
    }

    for (const diff of parsed.diffs) {
      const duplicate = state.diffs.some((known) => (
        known.path === diff.path && known.old === diff.old && known.new === diff.new
      ));

      if (!duplicate) {
        state.diffs.push(diff);
      }
    }

    tools.set(id, state);

    const out: ChatStep[] = [];
    const step = {
      command: '',
      lang: '',
      sub: '',
      preview: '',
      files: [],
      changes: [],
      omittedChanges: 0,
      ...acpToolStep(state),
    };
    const snapshot = JSON.stringify(step);

    if (snapshot !== state.lastStep) {
      state.lastStep = snapshot;
      out.push(step);
    }

    if (terminal && !results.has(id)) {
      results.add(id);
      out.push(qwenToolResult(update));
    }

    return out;
  }

  return { observe };
}
