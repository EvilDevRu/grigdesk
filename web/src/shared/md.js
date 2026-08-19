// Общий безопасный Markdown-рендерер для ответов чата, документов этапов и триажа.
// По умолчанию raw HTML показывается текстом. Только read-only viewer документов может
// включить allowHtml: тогда итог всё равно проходит строгий allowlist перед v-html.
import { marked, Renderer } from 'marked';

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeHref(value, { image = false } = {}) {
  const href = String(value || '').trim();
  if (!href || /[\u0000-\u001f\u007f]/.test(href)) return '';
  if (/^https?:\/\//i.test(href)) return href;
  if (!image && /^mailto:/i.test(href)) return href;
  if (/^(?:#|\?|\/(?!\/)|\.{1,2}\/)/.test(href)) return href;
  // Обычный относительный путь без схемы. HTML-сущности в схеме не разрешаем:
  // браузер не должен получить замаскированный javascript:/data: URL.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('//') && !href.includes('&#')) {
    return href;
  }
  return '';
}

function resolveUrl(href, resolver) {
  if (typeof resolver !== 'function') return href;
  let resolved;
  try { resolved = resolver(href); } catch { return href; }
  // Строгий false — вердикт резолвера «ссылка ведёт в никуда»: рендерим текстом,
  // чтобы синий цвет не обещал открытие, которого не будет.
  if (resolved === false) return false;
  return resolved || href;
}

function resolveImageUrl(href, resolver) {
  if (typeof resolver !== 'function') return href;
  try { return resolver(href) || ''; } catch { return ''; }
}

function isDocumentLink(href) {
  return String(href || '').startsWith('#/documents?');
}

function isCodeLink(href) {
  return String(href || '').startsWith('#/code?');
}

function linkAttributes(href) {
  if (isDocumentLink(href)) return ' data-document-link="true"';
  if (isCodeLink(href)) return ' data-code-link="true"';
  return ' target="_blank" rel="noopener noreferrer"';
}

function createRenderer({ resolveHref, resolveImageHref, allowHtml = false } = {}) {
  const renderer = new Renderer();
  renderer.html = ({ text }) => (allowHtml ? text : escapeHtml(text));
  renderer.link = function ({ href, title, tokens }) {
    const text = this.parser.parseInline(tokens);
    const resolved = resolveUrl(href, resolveHref);
    if (resolved === false) return text;
    // Результат расширения проходит тот же allowlist: resolver не может подсунуть
    // javascript:/data: и обойти базовую защиту Markdown-рендерера.
    const safe = safeHref(resolved);
    if (!safe) return text;
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
    return `<a href="${escapeHtml(safe)}"${titleAttr}${linkAttributes(safe)}>${text}</a>`;
  };
  renderer.image = ({ href, title, text }) => {
    const safe = safeHref(resolveImageUrl(href, resolveImageHref), { image: true });
    if (!safe) return escapeHtml(text || '');
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
    return `<img src="${escapeHtml(safe)}" alt="${escapeHtml(text || '')}"${titleAttr} loading="lazy">`;
  };
  return renderer;
}

const ALLOWED_HTML_TAGS = new Set([
  'a', 'b', 'blockquote', 'br', 'code', 'del', 'details', 'div', 'em', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'hr', 'i', 'img', 'kbd', 'li', 'ol', 'p', 'pre', 's', 'span', 'strong',
  'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul',
]);
const ALIGN_TAGS = new Set(['div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'td', 'th']);

function safeInteger(value, { min = 1, max = 4096 } = {}) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) && number >= min && number <= max ? String(number) : '';
}

function sanitizeElement(element, { resolveHref, resolveImageHref } = {}) {
  const tag = element.tagName.toLowerCase();
  const attrs = Object.fromEntries([...element.attributes].map(({ name, value }) => [name.toLowerCase(), value]));
  for (const { name } of [...element.attributes]) element.removeAttribute(name);

  const id = String(attrs.id || '').trim();
  if (id && id.length <= 160 && /^[\p{L}\p{N}_.:-]+$/u.test(id)) element.setAttribute('id', id);
  const align = String(attrs.align || '').toLowerCase();
  if (ALIGN_TAGS.has(tag) && ['left', 'center', 'right'].includes(align)) element.setAttribute('align', align);

  if (tag === 'a') {
    const resolved = resolveUrl(attrs.href, resolveHref);
    if (resolved === false) {
      // Живой NodeList нельзя разворачивать прямо в replaceWith: он меняется по ходу.
      element.replaceWith(...[...element.childNodes]);
      return;
    }
    const safe = safeHref(resolved);
    if (safe) {
      element.setAttribute('href', safe);
      if (isDocumentLink(safe)) element.setAttribute('data-document-link', 'true');
      else if (isCodeLink(safe)) element.setAttribute('data-code-link', 'true');
      else {
        element.setAttribute('target', '_blank');
        element.setAttribute('rel', 'noopener noreferrer');
      }
    }
    if (attrs.title) element.setAttribute('title', attrs.title.slice(0, 500));
  } else if (tag === 'img') {
    const safe = safeHref(resolveImageUrl(attrs.src, resolveImageHref), { image: true });
    if (!safe) {
      element.replaceWith(element.ownerDocument.createTextNode(attrs.alt || ''));
      return;
    }
    element.setAttribute('src', safe);
    element.setAttribute('alt', String(attrs.alt || '').slice(0, 500));
    element.setAttribute('loading', 'lazy');
    if (attrs.title) element.setAttribute('title', attrs.title.slice(0, 500));
    const width = safeInteger(attrs.width);
    const height = safeInteger(attrs.height);
    if (width) element.setAttribute('width', width);
    if (height) element.setAttribute('height', height);
  } else if (tag === 'code') {
    const language = String(attrs.class || '').match(/(?:^|\s)(language-[a-z0-9_-]+)(?:\s|$)/i)?.[1];
    if (language) element.setAttribute('class', language.toLowerCase());
  } else if (tag === 'ol') {
    const start = safeInteger(attrs.start, { min: 1, max: 100000 });
    if (start) element.setAttribute('start', start);
  } else if (tag === 'td' || tag === 'th') {
    const colspan = safeInteger(attrs.colspan, { min: 1, max: 100 });
    const rowspan = safeInteger(attrs.rowspan, { min: 1, max: 100 });
    if (colspan) element.setAttribute('colspan', colspan);
    if (rowspan) element.setAttribute('rowspan', rowspan);
  }
}

/** Санитизация нужна после marked: так она одинаково покрывает raw HTML и Markdown. */
export function sanitizeRenderedHtml(html, options = {}) {
  const documentImpl = options.sanitizerDocument || globalThis.document;
  if (!documentImpl?.createElement) return escapeHtml(html);
  const template = documentImpl.createElement('template');
  template.innerHTML = String(html || '');
  for (const element of [...template.content.querySelectorAll('*')]) {
    if (!template.content.contains(element)) continue;
    const tag = element.tagName.toLowerCase();
    if (!ALLOWED_HTML_TAGS.has(tag)) {
      element.replaceWith(documentImpl.createTextNode(element.outerHTML));
      continue;
    }
    sanitizeElement(element, options);
  }
  return template.innerHTML;
}

export function mdToHtml(src, options = {}) {
  const sanitizerDocument = options.sanitizerDocument || globalThis.document;
  // Вне браузера fail closed: raw HTML не включаем, если его нечем санитизировать.
  const allowHtml = !!options.allowHtml && !!sanitizerDocument?.createElement;
  const html = marked.parse(String(src || ''), {
    renderer: createRenderer({ ...options, allowHtml }),
    gfm: true,
    breaks: true,
    async: false,
  });
  return allowHtml ? sanitizeRenderedHtml(html, options) : html;
}

// Однострочные превью не должны показывать служебный синтаксис Markdown:
// у ссылки оставляем подпись, у картинки — alt, у выделения и кода — содержимое.
// Разбираем Markdown тем же lexer'ом, что и основное сообщение, вместо набора regex:
// так вложенные конструкции и незакрытая разметка деградируют предсказуемо.
function inlineTokenText(token) {
  if (!token) return '';
  if (token.type === 'br') return ' ';
  if (token.type === 'image') return token.text || '';
  if (Array.isArray(token.tokens)) return token.tokens.map(inlineTokenText).join('');
  return token.text || '';
}

function blockTokenText(token) {
  if (!token || token.type === 'space' || token.type === 'hr') return '';
  if (token.type === 'list') return (token.items || []).map(blockTokenText).filter(Boolean).join(' ');
  if (token.type === 'table') {
    return [
      ...(token.header || []),
      ...(token.rows || []).flat(),
    ].map(inlineTokenText).filter(Boolean).join(' ');
  }
  if (['paragraph', 'heading', 'text'].includes(token.type) && Array.isArray(token.tokens)) {
    return token.tokens.map(inlineTokenText).join('');
  }
  if (Array.isArray(token.tokens)) {
    const nested = token.tokens.map(blockTokenText).filter(Boolean).join(' ');
    return nested || token.tokens.map(inlineTokenText).join('');
  }
  return token.text || '';
}

export function mdToText(src) {
  const tokens = marked.lexer(String(src || ''), { gfm: true, breaks: true });
  return tokens
    .map(blockTokenText)
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}
