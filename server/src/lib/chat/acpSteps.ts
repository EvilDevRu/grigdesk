// Provider-neutral разбор content инструментов ACP.
// Qwen и Kimi получают одинаковые блоки: вложенный content, текст и структурные
// диффы. Байты картинки заменяются общей заглушкой и не попадают в ленту и историю.

import { STEP_IMAGE_TEXT } from '../../../../shared/chat/chatSteps.ts';
import { base, cut, cutMiddle, STEP_TEXT_LIMIT, type ChatStep } from './streamSteps.ts';

// Структурная правка файла из блока content ACP.
export interface AcpDiff {
  path: string;
  old: string;
  new: string;
}

// Разобранный content дельты: текст и все её правки.
export interface AcpContent {
  text: string;
  diffs: AcpDiff[];
}

// Накопленное состояние одного вызова инструмента между дельтами ACP.
export interface AcpToolState {
  id: unknown;
  kind: string;
  title: string;
  rawInput: Record<string, unknown>;
  locations: Array<{ path?: unknown } | null>;
  text: string;
  diffs: AcpDiff[];
}

/**
 * Достаёт человеческий текст и диффы из массива блоков content ACP.
 * Пустой текст пропускается, картинка становится заглушкой, незнакомые типы
 * блоков в итог не попадают: лента не должна показывать wire-формат и base64.
 */
export function parseAcpContent(content: unknown): AcpContent {
  const list = (Array.isArray(content) ? content : []) as Array<{
    type?: string;
    path?: unknown;
    oldText?: unknown;
    newText?: unknown;
    content?: { type?: string; text?: unknown };
  } | null>;
  const texts: string[] = [];
  const diffs: AcpDiff[] = [];

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

      if (text.trim()) {
        texts.push(text);
      }

      continue;
    }

    if (entry?.type === 'content' && entry.content?.type === 'image') {
      texts.push(STEP_IMAGE_TEXT);
    }
  }

  return { text: texts.join('\n'), diffs };
}

// Пределы общего нормализатора, унаследованные от Kimi: 20 файлов на шаг,
// 16 КиБ текста диффов и 500 символов пути.
const ACP_CHANGE_LIMIT = 20;
const ACP_DIFF_TEXT_BUDGET = 16 * 1024;
const ACP_CHANGE_PATH_LIMIT = 500;
const ACP_MIDDLE_MARKER = '\n… сокращено …\n';

// Первый непустой строковый аргумент: пути и команды приходят в разных полях
// rawInput, и состав полей зависит от инструмента.
export function firstString(...values: unknown[]): string {
  return String(values.find((value) => typeof value === 'string' && value.trim()) || '');
}

// Пути файла могли прийти из нескольких источников; дубли схлопываются,
// порядок первого появления сохраняется.
function uniquePaths(values: unknown[]): string[] {
  return [...new Set(values.map((value) => String(value || '')).filter(Boolean))];
}

// Длинный путь обрезается с многоточием, чтобы строка ленты не разъезжалась.
function boundedPath(value: unknown): string {
  const path = String(value || '');

  if (path.length <= ACP_CHANGE_PATH_LIMIT) {
    return path;
  }

  return `${path.slice(0, ACP_CHANGE_PATH_LIMIT - 1)}…`;
}

// Префикс строки в пределах байтового бюджета: многобайтные символы
// не разрываются посередине.
function utf8Prefix(value: unknown, byteLimit: number): string {
  const chars: string[] = [];
  let bytes = 0;

  for (const char of String(value ?? '')) {
    const size = Buffer.byteLength(char);

    if (bytes + size > byteLimit) {
      break;
    }

    chars.push(char);
    bytes += size;
  }

  return chars.join('');
}

// Суффикс строки в пределах байтового бюджета: хвост читается с конца,
// многобайтные символы не разрываются.
function utf8Suffix(value: unknown, byteLimit: number): string {
  const chars: string[] = [];
  let bytes = 0;
  const source = Array.from(String(value ?? ''));

  for (let index = source.length - 1; index >= 0; index -= 1) {
    const char = String(source[index] ?? '');
    const size = Buffer.byteLength(char);

    if (bytes + size > byteLimit) {
      break;
    }

    chars.push(char);
    bytes += size;
  }

  return chars.reverse().join('');
}

// Середина длинного текста заменяется маркером, начало и конец сохраняются
// в пределах байтового бюджета.
function cutMiddleBytes(value: unknown, byteLimit: number): string {
  const text = String(value ?? '');

  if (Buffer.byteLength(text) <= byteLimit) {
    return text;
  }

  const markerBytes = Buffer.byteLength(ACP_MIDDLE_MARKER);

  if (byteLimit <= markerBytes) {
    return utf8Prefix(text, byteLimit);
  }

  const available = byteLimit - markerBytes;
  const head = Math.ceil(available / 2);

  return `${utf8Prefix(text, head)}${ACP_MIDDLE_MARKER}${utf8Suffix(text, available - head)}`;
}

// Бюджет делится между сторонами диффа; неиспользованный остаток одной
// стороны отдаётся другой, маркер сокращения остаётся внутри бюджета.
function boundedDiff(diff: AcpDiff, byteBudget: number): { old: string; new: string } {
  const old = String(diff.old ?? '');
  const next = String(diff.new ?? '');
  const oldBytes = Buffer.byteLength(old);
  const newBytes = Buffer.byteLength(next);

  if (oldBytes + newBytes <= byteBudget) {
    return { old, new: next };
  }

  let oldBudget = old ? Math.floor(byteBudget / 2) : 0;
  let newBudget = next ? byteBudget - oldBudget : 0;

  if (!old) {
    newBudget = byteBudget;
  }
  if (!next) {
    oldBudget = byteBudget;
  }
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

// Не более двадцати файлов на шаг; байтовый бюджет делится между оставшимися
// слотами, чтобы сумма диффов не превышала предел хранения.
function boundedChanges(diffs: AcpDiff[]) {
  const selected = diffs.slice(0, ACP_CHANGE_LIMIT);
  let remaining = ACP_DIFF_TEXT_BUDGET;

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

// Вид правки по наличию сторон: пустая старая сторона — создание файла,
// пустая новая — удаление, обе стороны — обычное обновление.
function diffKind(diff: AcpDiff): string {
  if (!diff.old && diff.new) {
    return 'add';
  }
  if (diff.old && !diff.new) {
    return 'delete';
  }

  return 'update';
}

// Правка может прийти парой old/new в rawInput, без блока diff.
// Тогда дифф строится из аргументов; структурные блоки имеют приоритет.
function rawEditDiffs(state: AcpToolState): AcpDiff[] {
  if (state.kind !== 'edit') {
    return [];
  }

  const raw = state.rawInput;
  const old = raw.old_string ?? raw.oldText;
  const next = raw.new_string ?? raw.newText;

  if (old === undefined && next === undefined) {
    return [];
  }

  return [{
    path: firstString(raw.path, raw.file_path, state.locations[0]?.path),
    old: String(old ?? ''),
    new: String(next ?? ''),
  }];
}

/**
 * Строка ленты из вызова ACP: команда, путь, дифф или аргументы по kind.
 * Незнакомый инструмент сохраняет имя и превью аргументов — строка не исчезает.
 */
export function acpToolStep(state: AcpToolState): ChatStep {
  const { id } = state;
  const kind = String(state.kind || 'other');
  const raw = state.rawInput;
  const text = state.text;
  const title = String(state.title || kind);
  const diffs = state.diffs.length ? state.diffs : rawEditDiffs(state);

  if (kind === 'execute') {
    const command = firstString(raw.command, raw.cmd, raw.script) || text;

    return {
      k: 'tool',
      id,
      name: 'Bash',
      lang: 'bash',
      title: cut((command || title).split('\n')[0], 200),
      command: cutMiddle(command, STEP_TEXT_LIMIT),
      preview: command ? '' : cut(title, 200),
    };
  }

  if (kind === 'edit' || diffs.length) {
    const locationPaths = state.locations.map((location) => location?.path);
    const fallback = firstString(locationPaths[0], raw.path, raw.file_path);
    const enriched = diffs.map((diff, index) => ({
      ...diff,
      path: firstString(diff.path, locationPaths[index], index === 0 ? fallback : ''),
    }));
    const allFiles = uniquePaths([
      ...enriched.map((diff) => diff.path),
      ...locationPaths,
      raw.path,
      raw.file_path,
    ]);
    const files = allFiles.slice(0, ACP_CHANGE_LIMIT).map(boundedPath);
    const file = firstString(files[0], boundedPath(fallback));
    const changes = boundedChanges(enriched);
    const omittedChanges = Math.max(
      0,
      enriched.length - changes.length,
      allFiles.length - files.length,
    );

    return {
      k: 'tool',
      id,
      name: 'Edit',
      title: file ? base(file) : cut(title, 200),
      sub: file,
      files,
      preview: cut(text || JSON.stringify(raw), 600),
      ...(changes.length ? { changes, preview: '' } : {}),
      ...(omittedChanges
        ? { omittedChanges, preview: `… ещё ${omittedChanges} файлов` }
        : {}),
    };
  }

  if (kind === 'read') {
    const file = boundedPath(firstString(state.locations[0]?.path, raw.path, raw.file_path));

    return {
      k: 'tool',
      id,
      name: 'Read',
      title: file ? base(file) : cut(title, 200),
      sub: file,
    };
  }

  if (kind === 'search') {
    return {
      k: 'tool',
      id,
      name: 'Grep',
      title: cut(firstString(raw.pattern, raw.query, raw.regex) || title, 200),
      sub: boundedPath(firstString(raw.path, raw.glob)),
    };
  }

  const args = Object.keys(raw).length ? JSON.stringify(raw) : text;

  return {
    k: 'tool',
    id,
    name: title,
    title: cut(title, 200),
    preview: cut(args, 600),
  };
}
