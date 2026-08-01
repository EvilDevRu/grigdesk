// Единственная точка, где локальный файловый href превращается в web-route Cockpit.
// Сервер всё равно заново проверяет тип, realpath и разрешённый корень: эта функция —
// удобство навигации, а не граница безопасности.
const DOCUMENT_EXT = /\.(?:md|markdown|txt)$/i;
const LINE_SUFFIX = /^(.*\.(?:md|markdown|txt)):(\d+)(?::\d+)?$/i;

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

function dirname(value) {
  const at = value.lastIndexOf('/');
  return at <= 0 ? '/' : value.slice(0, at);
}

export function parseDocumentHref(href, { basePath = '' } = {}) {
  let raw = String(href || '').trim();
  if (!raw || /[\u0000-\u001f\u007f]/.test(raw)) return null;

  // file:///... иногда приходит из вручную написанного Markdown. Остальные схемы
  // являются внешними URL и не должны превращаться в чтение серверного диска.
  if (/^file:\/\//i.test(raw)) {
    try { raw = new URL(raw).pathname; } catch { return null; }
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) {
    return null;
  }

  let anchor = '';
  const hashAt = raw.indexOf('#');
  if (hashAt >= 0) {
    anchor = decodePath(raw.slice(hashAt + 1));
    raw = raw.slice(0, hashAt);
  }
  if (!raw && basePath && anchor) raw = basePath;

  raw = decodePath(raw);
  let line = 0;
  const lineMatch = raw.match(LINE_SUFFIX);
  if (lineMatch) {
    raw = lineMatch[1];
    line = Number(lineMatch[2]) || 0;
  }
  if (!DOCUMENT_EXT.test(raw)) return null;

  let absolute = raw;
  if (!absolute.startsWith('/')) {
    if (!basePath || !basePath.startsWith('/')) return null;
    absolute = `${dirname(basePath)}/${absolute}`;
  }
  absolute = normalizeAbsolute(absolute);
  return { path: absolute, line, anchor };
}

export function documentRouteHref(href, options) {
  const target = parseDocumentHref(href, options);
  if (!target) return '';
  const query = new URLSearchParams({ open: target.path });
  if (target.line) query.set('line', String(target.line));
  if (target.anchor) query.set('anchor', target.anchor);
  return `#/documents?${query}`;
}

function relativeDocumentTarget(href, basePath) {
  let raw = String(href || '').trim();
  if (!raw || /[\u0000-\u001f\u007f]/.test(raw)) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) return null;
  if (raw.startsWith('/')) return { absoluteHref: raw };

  let anchor = '';
  const hashAt = raw.indexOf('#');
  if (hashAt >= 0) {
    anchor = decodePath(raw.slice(hashAt + 1));
    raw = raw.slice(0, hashAt);
  }
  const sameDocument = !raw && !!anchor;
  if (sameDocument) raw = basePath;
  raw = decodePath(raw);
  let line = 0;
  const lineMatch = raw.match(LINE_SUFFIX);
  if (lineMatch) {
    raw = lineMatch[1];
    line = Number(lineMatch[2]) || 0;
  }
  if (!DOCUMENT_EXT.test(raw)) return null;

  const stack = sameDocument ? [] : dirname(basePath).split('/').filter(Boolean);
  const parts = raw.split('/');
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!stack.length) return null;
      stack.pop();
    } else stack.push(part);
  }
  return { path: stack.join('/'), line, anchor };
}

/** Ссылки внутри уже открытого DocumentRef не возвращаются к абсолютным host paths. */
export function documentRefRouteHref(href, { source, basePath } = {}) {
  if (!source || !basePath) return '';
  const target = relativeDocumentTarget(href, basePath);
  if (!target) return '';
  if (target.absoluteHref) return documentRouteHref(target.absoluteHref);
  const query = new URLSearchParams({ source, path: target.path });
  if (target.line) query.set('line', String(target.line));
  if (target.anchor) query.set('anchor', target.anchor);
  return `#/documents?${query}`;
}
