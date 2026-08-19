// Мост «файловая ссылка агента → панель „Код“». Абсолютный путь из сообщения чата
// сопоставляется с известными деревьями репозиториев (GET /api/code/roots), и клик
// открывает файл в панели вместо мёртвой вкладки. Как и у документов, это удобство
// навигации, а не граница безопасности: чтение всё равно идёт обычными роутами
// плагина «Код» с их проверками root/скрытых каталогов.
import { ref } from 'vue';
import { api } from '../../shared/api-client.js';
import { documentRouteHref } from '../documents/links.js';

const CONTROL_RE = /[\u0000-\u001f\u007f]/;
// Внутренности гита и конвенция «.state = секреты» закрыты сервером «Кода» —
// такую ссылку честнее сразу показать текстом, а не кнопкой к отказу.
const HIDDEN_SEGMENTS = new Set(['.git', '.state']);
const LINE_SUFFIX = /^(.*):(\d+)(?::\d+)?$/;

function decodePath(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function normalizeAbsolute(value) {
  const parts = [];
  for (const part of value.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}

// ── Карта деревьев с сервера. Живёт на модуле: чатов и окон много, карта одна. ──
export const codeRoots = ref([]);
const ROOTS_TTL = 60_000;
let rootsLoadedAt = 0;
let rootsLoading = null;

/** Подтягивает карту деревьев (с TTL). Отказ — не ошибка: ссылки остаются текстом. */
export function loadCodeRoots({ force = false } = {}) {
  if (rootsLoading) return rootsLoading;
  if (!force && rootsLoadedAt && Date.now() - rootsLoadedAt < ROOTS_TTL) return Promise.resolve(codeRoots.value);
  rootsLoading = api.get('/api/code/roots')
    .then((data) => { codeRoots.value = Array.isArray(data?.roots) ? data.roots : []; })
    .catch(() => { /* выключенный плагин «Код» или сеть: мост просто молчит */ })
    .finally(() => { rootsLoadedAt = Date.now(); rootsLoading = null; })
    .then(() => codeRoots.value);
  return rootsLoading;
}

/** Похож ли href на локальный файловый путь (а не URL/якорь/query). */
export function looksLikeLocalPath(href) {
  const raw = String(href || '').trim();
  if (!raw || CONTROL_RE.test(raw)) return false;
  if (/^file:\/\//i.test(raw)) return true;
  if (raw.startsWith('#') || raw.startsWith('?')) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) return false;
  return true;
}

/** Абсолютный путь → {project, repo, root, path, line} по известным деревьям, иначе null. */
export function parseCodeTarget(href, roots) {
  let raw = String(href || '').trim();
  if (!raw || CONTROL_RE.test(raw)) return null;
  if (/^file:\/\//i.test(raw)) {
    try { raw = new URL(raw).pathname; } catch { return null; }
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) {
    return null;
  }
  raw = decodePath(raw.split('#', 1)[0]);
  let line = 0;
  const lineMatch = raw.match(LINE_SUFFIX);
  if (lineMatch && !lineMatch[1].endsWith('/')) {
    raw = lineMatch[1];
    line = Number(lineMatch[2]) || 0;
  }
  if (!raw.startsWith('/')) return null;
  const absolute = normalizeAbsolute(raw);
  if (absolute.split('/').some((seg) => HIDDEN_SEGMENTS.has(seg))) return null;
  // Самый длинный совпавший корень: worktree может лежать внутри другого дерева.
  let best = null;
  for (const root of Array.isArray(roots) ? roots : []) {
    const base = String(root?.root || '');
    if (!base || absolute === base || !absolute.startsWith(`${base}/`)) continue;
    if (!best || base.length > String(best.root).length) best = root;
  }
  if (!best) return null;
  return {
    project: String(best.project),
    repo: String(best.repo),
    root: String(best.root),
    path: absolute.slice(String(best.root).length + 1),
    line,
  };
}

/** Файловый href → внутренний route панели «Код», либо пустая строка. */
export function codeRouteHref(href, { roots = codeRoots.value } = {}) {
  const target = parseCodeTarget(href, roots);
  if (!target) return '';
  const query = new URLSearchParams({
    project: target.project, repo: target.repo, root: target.root, path: target.path,
  });
  if (target.line) query.set('line', String(target.line));
  return `#/code?${query}`;
}

/**
 * Общий резолвер файловых ссылок чата: .md/.txt → просмотрщик документов, файл под
 * известным деревом → панель «Код», остальные локальные пути — false (текстом):
 * синяя ссылка не имеет права обещать открытие, которого не будет.
 */
export function chatFileLinkHref(href, { roots = codeRoots.value } = {}) {
  const doc = documentRouteHref(href);
  if (doc) return doc;
  const code = codeRouteHref(href, { roots });
  if (code) return code;
  return looksLikeLocalPath(href) ? false : '';
}

/** Разбирает только внутренний route панели, не принимая произвольный URL. */
export function parseCodeRouteHref(href) {
  const raw = String(href || '').trim();
  const marker = '#/code?';
  const at = raw.indexOf(marker);
  if (at < 0 || CONTROL_RE.test(raw)) return null;
  const query = new URLSearchParams(raw.slice(at + marker.length));
  const project = query.get('project') || '';
  const repo = query.get('repo') || '';
  const root = query.get('root') || '';
  const filePath = query.get('path') || '';
  if (!project || !repo || !root || !filePath) return null;
  return {
    project, repo, root, path: filePath,
    line: Math.max(0, Number.parseInt(query.get('line'), 10) || 0),
  };
}

/** Цель открытия только для обычного клика по ссылке на файл кода. */
export function codeLinkFromClick(event) {
  if (event?.defaultPrevented || event?.button !== 0
      || event?.metaKey || event?.ctrlKey || event?.shiftKey || event?.altKey) return null;
  const anchor = event?.target?.closest?.('a[data-code-link="true"]');
  const href = anchor?.getAttribute?.('href') || '';
  return parseCodeRouteHref(href);
}
