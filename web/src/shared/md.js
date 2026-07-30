// Общий безопасный Markdown-рендерер для ответов чата, документов этапов и триажа.
// Raw HTML показываем текстом, а ссылки пропускаем только через явный белый список:
// результат вставляется через v-html, поэтому доверять модельному ответу нельзя.
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

const renderer = new Renderer();

renderer.html = ({ text }) => escapeHtml(text);

renderer.link = function ({ href, title, tokens }) {
  const text = this.parser.parseInline(tokens);
  const safe = safeHref(href);
  if (!safe) return text;
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
  return `<a href="${escapeHtml(safe)}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
};

renderer.image = ({ href, title, text }) => {
  const safe = safeHref(href, { image: true });
  if (!safe) return escapeHtml(text || '');
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
  return `<img src="${escapeHtml(safe)}" alt="${escapeHtml(text || '')}"${titleAttr} loading="lazy">`;
};

export function mdToHtml(src) {
  return marked.parse(String(src || ''), {
    renderer,
    gfm: true,
    breaks: true,
    async: false,
  });
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
