// Мост «файловая ссылка агента → панель „Код“». Абсолютный путь из сообщения чата
// сопоставляется с известными деревьями репозиториев (GET /api/code/roots), и клик
// открывает файл в панели вместо мёртвой вкладки. Как и у документов, это удобство
// навигации, а не граница безопасности: чтение всё равно идёт обычными роутами
// плагина «Код» с их проверками root/скрытых каталогов.
import { ref } from 'vue';
import { codeApi } from '../../shared/codeApi.ts';
import type { CodeRoot, CodeTarget } from '../../../../shared/codeContracts.ts';
import { documentRouteHref } from '../documents/links.js';

type LinkRoot = Pick<CodeRoot, 'project' | 'repo' | 'root'>;
interface LinkOptions {
  roots?: readonly LinkRoot[];
}

const CONTROL_RE = /[\u0000-\u001f\u007f]/;
// Внутренности гита и конвенция «.state = секреты» закрыты сервером «Кода» —
// такую ссылку честнее сразу показать текстом, а не кнопкой к отказу.
const HIDDEN_SEGMENTS = new Set(['.git', '.state']);
const LINE_SUFFIX = /^(.*):(\d+)(?::\d+)?$/;

/**
 * Декодирует URL-путь, сохраняя исходный текст при повреждённом escape.
 * Некорректная ссылка не должна прерывать отрисовку сообщения.
 */
function decodePath(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Убирает точки и переходы к родителю до сравнения с картой деревьев.
 * Навигационная нормализация не заменяет серверную проверку доступа к файлу.
 */
function normalizeAbsolute(value: string) {
  const parts: string[] = [];

  for (const part of value.split('/')) {
    if (!part || part === '.') {
      continue;
    }
    if (part === '..') {
      parts.pop();
    } else {
      parts.push(part);
    }
  }

  return `/${parts.join('/')}`;
}

// ── Карта деревьев с сервера. Живёт на модуле: чатов и окон много, карта одна. ──
export const codeRoots = ref<CodeRoot[]>([]);
const ROOTS_TTL = 60_000;
let rootsLoadedAt = 0;
let rootsLoading: Promise<CodeRoot[]> | null = null;

/**
 * Подтягивает общую карту деревьев с TTL и объединяет одновременные запросы.
 * При отказе ссылки остаются текстом; ошибка не мешает работе чата.
 */
export function loadCodeRoots({ force = false } = {}) {
  if (rootsLoading) {
    return rootsLoading;
  }
  if (!force && rootsLoadedAt && Date.now() - rootsLoadedAt < ROOTS_TTL) {
    return Promise.resolve(codeRoots.value);
  }

  rootsLoading = codeApi.roots()
    .then((roots) => {
      codeRoots.value = roots;
    })
    .catch(() => {
      // Выключенный плагин «Код» или сеть: мост просто молчит.
    })
    .finally(() => {
      rootsLoadedAt = Date.now();
      rootsLoading = null;
    })
    .then(() => codeRoots.value);

  return rootsLoading;
}

/**
 * Отделяет локальные файловые пути от URL, якорей и query-ссылок.
 * Управляющие символы не превращаются в интерактивную ссылку.
 */
export function looksLikeLocalPath(href: string) {
  const raw = String(href || '').trim();

  if (!raw || CONTROL_RE.test(raw)) {
    return false;
  }
  if (/^file:\/\//i.test(raw)) {
    return true;
  }
  if (raw.startsWith('#') || raw.startsWith('?')) {
    return false;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) {
    return false;
  }

  return true;
}

/**
 * Сопоставляет абсолютный путь с самым глубоким известным деревом репозитория.
 * Служебные сегменты сразу исключаются из навигационного моста.
 */
export function parseCodeTarget(href: string, roots: readonly LinkRoot[]): CodeTarget | null {
  let raw = String(href || '').trim();

  if (!raw || CONTROL_RE.test(raw)) {
    return null;
  }
  if (/^file:\/\//i.test(raw)) {
    try {
      raw = new URL(raw).pathname;
    } catch {
      return null;
    }
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) {
    return null;
  }

  raw = decodePath(raw.split('#', 1)[0] || '');

  let line = 0;
  const lineMatch = raw.match(LINE_SUFFIX);

  if (lineMatch?.[1] && !lineMatch[1].endsWith('/')) {
    raw = lineMatch[1];
    line = Number(lineMatch[2]) || 0;
  }
  if (!raw.startsWith('/')) {
    return null;
  }

  const absolute = normalizeAbsolute(raw);

  if (absolute.split('/').some((seg) => HIDDEN_SEGMENTS.has(seg))) {
    return null;
  }
  // Самый длинный совпавший корень: worktree может лежать внутри другого дерева.
  let best: LinkRoot | null = null;
  const available: readonly LinkRoot[] = Array.isArray(roots) ? roots : [];

  for (const root of available) {
    const base = String(root?.root || '');

    if (!base || absolute === base || !absolute.startsWith(`${base}/`)) {
      continue;
    }
    if (!best || base.length > String(best.root).length) {
      best = root;
    }
  }

  if (!best) {
    return null;
  }

  return {
    project: String(best.project),
    repo: String(best.repo),
    root: String(best.root),
    path: absolute.slice(String(best.root).length + 1),
    line,
  };
}

/**
 * Создаёт внутренний маршрут панели только для разрешимой файловой ссылки.
 * Параметры кодируются отдельно, сохраняя спецсимволы имени и номер строки.
 */
export function codeRouteHref(href: string, { roots = codeRoots.value }: LinkOptions = {}) {
  const target = parseCodeTarget(href, roots);

  if (!target) {
    return '';
  }

  const query = new URLSearchParams({
    project: target.project,
    repo: target.repo,
    root: target.root,
    path: target.path,
  });

  if (target.line) {
    query.set('line', String(target.line));
  }

  return `#/code?${query}`;
}

/**
 * Общий резолвер файловых ссылок чата: .md/.txt → просмотрщик документов, файл под
 * известным деревом → панель «Код», остальные локальные пути — false (текстом):
 * синяя ссылка не имеет права обещать открытие, которого не будет.
 */
export function chatFileLinkHref(
  href: string,
  { roots = codeRoots.value }: LinkOptions = {},
): string | false {
  const doc = documentRouteHref(href);

  if (doc) {
    return doc;
  }

  const code = codeRouteHref(href, { roots });

  if (code) {
    return code;
  }

  return looksLikeLocalPath(href) ? false : '';
}

/**
 * Извлекает цель из маршрута панели, который может содержать префикс origin.
 * Неполный адрес возвращает null и не открывает пустую панель.
 */
export function parseCodeRouteHref(href: string): CodeTarget | null {
  const raw = String(href || '').trim();
  const marker = '#/code?';
  const at = raw.indexOf(marker);

  if (at < 0 || CONTROL_RE.test(raw)) {
    return null;
  }

  const query = new URLSearchParams(raw.slice(at + marker.length));
  const project = query.get('project') || '';
  const repo = query.get('repo') || '';
  const root = query.get('root') || '';
  const filePath = query.get('path') || '';

  if (!project || !repo || !root || !filePath) {
    return null;
  }

  return {
    project,
    repo,
    root,
    path: filePath,
    line: Math.max(0, Number.parseInt(query.get('line') || '', 10) || 0),
  };
}

/**
 * Перехватывает только обычный клик по размеченной файловой ссылке.
 * Модифицированные клики сохраняют стандартную навигацию браузера.
 */
export function codeLinkFromClick(event: MouseEvent): CodeTarget | null {
  if (event?.defaultPrevented || event?.button !== 0
      || event?.metaKey || event?.ctrlKey || event?.shiftKey || event?.altKey) {
    return null;
  }

  const target = event.target;

  if (!target || !('closest' in target) || typeof target.closest !== 'function') {
    return null;
  }

  const anchor: unknown = target.closest('a[data-code-link="true"]');

  if (typeof anchor !== 'object' || anchor === null
      || !('getAttribute' in anchor) || typeof anchor.getAttribute !== 'function') {
    return null;
  }

  const href: unknown = anchor.getAttribute('href');

  if (typeof href !== 'string') {
    return null;
  }

  return parseCodeRouteHref(href);
}
