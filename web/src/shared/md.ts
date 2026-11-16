// Общий безопасный Markdown-рендерер для ответов чата, документов этапов и триажа.
// По умолчанию raw HTML показывается текстом. Только read-only viewer документов может
// включить allowHtml: тогда итог всё равно проходит строгий allowlist перед v-html.
import { marked, Renderer } from 'marked';
import { measureChatPerformance, startChatPerformance } from './chatPerformance.ts';
import type { Token, Tokens } from 'marked';
import { localeTranslator } from '../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from './uiLocalePort.ts';

const t = localeTranslator(uiLocalePort);

// Расширение ссылок вызывающим кодом. Строгий `false` — вердикт «ведёт в никуда»:
// такую ссылку рендерим текстом, чтобы синий цвет не обещал открытие.
export type HrefResolver = (href: string) => string | false | null | undefined;

// Настройки рендера. `sanitizerDocument` подменяется в тестах: вне браузера
// санитизировать нечем, и raw HTML тогда не включается вовсе.
export interface MarkdownOptions {
  resolveHref?: HrefResolver;
  resolveImageHref?: HrefResolver;
  allowHtml?: boolean;
  sanitizerDocument?: Document | null;
}

/** Пять символов, которыми текст перестаёт быть текстом внутри HTML. */
function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Allowlist адресов. Разрешено ровно перечисленное, всё прочее становится пустой
 * строкой: `javascript:` и `data:` не должны доехать до атрибута ни в каком виде,
 * включая замаскированный HTML-сущностями.
 */
function safeHref(value: unknown, { image = false }: { image?: boolean } = {}): string {
  const href = String(value || '').trim();

  if (!href || /[\u0000-\u001f\u007f]/.test(href)) {
    return '';
  }

  if (/^https?:\/\//i.test(href)) {
    return href;
  }

  if (!image && /^mailto:/i.test(href)) {
    return href;
  }

  if (/^(?:#|\?|\/(?!\/)|\.{1,2}\/)/.test(href)) {
    return href;
  }

  // Обычный относительный путь без схемы. HTML-сущности в схеме не разрешаем:
  // браузер не должен получить замаскированный javascript:/data: URL.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('//') && !href.includes('&#')) {
    return href;
  }

  return '';
}

/**
 * Расширение ссылки вызывающим кодом. Отказ резолвера не роняет рендер: исходный
 * адрес честнее пустоты, а строгий `false` — отдельный вердикт «ведёт в никуда».
 */
function resolveUrl(href: string, resolver?: HrefResolver): string | false {
  if (typeof resolver !== 'function') {
    return href;
  }

  let resolved: string | false | null | undefined;

  try {
    resolved = resolver(href);
  } catch {
    return href;
  }

  // Строгий false — вердикт резолвера «ссылка ведёт в никуда»: рендерим текстом,
  // чтобы синий цвет не обещал открытие, которого не будет.
  if (resolved === false) {
    return false;
  }

  return resolved || href;
}

/**
 * То же для картинки, но без исходного адреса как фоллбэка: нерасширенный путь
 * приведёт к битому изображению, а пустая строка — к честному alt.
 */
function resolveImageUrl(href: string, resolver?: HrefResolver): string {
  if (typeof resolver !== 'function') {
    return href;
  }

  try {
    return resolver(href) || '';
  } catch {
    return '';
  }
}

/** Внутренняя ссылка на документ этапа: её перехватывает роутер, а не браузер. */
function isDocumentLink(href: unknown): boolean {
  return String(href || '').startsWith('#/documents?');
}

/** Внутренняя ссылка на файл в плагине «Код» — тоже своя навигация. */
function isCodeLink(href: unknown): boolean {
  return String(href || '').startsWith('#/code?');
}

/**
 * Атрибуты ссылки. Внутренние помечаются данными для перехвата, внешние получают
 * `noopener` — без него открытая вкладка получает доступ к `window.opener`.
 */
function linkAttributes(href: string): string {
  if (isDocumentLink(href)) {
    return ' data-document-link="true"';
  }

  if (isCodeLink(href)) {
    return ' data-code-link="true"';
  }

  return ' target="_blank" rel="noopener noreferrer"';
}

const ALERT_TITLES: Record<string, string> = {
  get note() {
    return t('core.mdZametka');
  },
  get tip() {
    return t('core.mdSovet');
  },
  get important() {
    return t('core.mdVazhno');
  },
  get warning() {
    return t('core.mdVnimanie');
  },
  get caution() {
    return t('core.mdOstorozhno');
  },
};

/**
 * Снимает только первую строку маркера из уже разобранной цитаты.
 * Остальные inline-токены сохраняют ссылки-сноски и структуру исходного документа.
 */
function alertBody(tokens: Token[]): Token[] {
  const first = tokens[0];

  if (first?.type !== 'paragraph') {
    return tokens;
  }

  const paragraph = first as Tokens.Paragraph;
  const inline = paragraph.tokens.slice(1);

  if (inline[0]?.type === 'br') {
    inline.shift();
  }

  return inline.length ? [{ ...paragraph, tokens: inline }, ...tokens.slice(1)] : tokens.slice(1);
}

/**
 * Рендерер marked с нашими правилами: raw HTML по умолчанию показывается текстом,
 * а каждая ссылка и картинка проходят allowlist уже ПОСЛЕ расширения — резолвер
 * не должен уметь обойти базовую защиту.
 */
function createRenderer({
  resolveHref,
  resolveImageHref,
  allowHtml = false,
}: MarkdownOptions = {}) {
  const renderer = new Renderer();

  renderer.html = ({ text }) => (allowHtml ? text : escapeHtml(text));

  renderer.blockquote = function ({ text, tokens }) {
    const kind = text.split('\n')[0]?.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*$/i)
      ?.[1]?.toLowerCase();

    if (!kind) {
      return `<blockquote>\n${this.parser.parse(tokens)}</blockquote>\n`;
    }

    const body = this.parser.parse(alertBody(tokens));

    return `<blockquote class="md-alert md-alert--${kind}">\n` +
      `<p class="md-alert__title">${ALERT_TITLES[kind]}</p>\n${body}</blockquote>\n`;
  };

  renderer.link = function ({ href, title, tokens }) {
    const text = this.parser.parseInline(tokens);
    const resolved = resolveUrl(href, resolveHref);

    if (resolved === false) {
      return text;
    }

    // Результат расширения проходит тот же allowlist: resolver не может подсунуть
    // javascript:/data: и обойти базовую защиту Markdown-рендерера.
    const safe = safeHref(resolved);

    if (!safe) {
      return text;
    }

    const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';

    return `<a href="${escapeHtml(safe)}"${titleAttr}${linkAttributes(safe)}>${text}</a>`;
  };

  renderer.image = ({ href, title, text }) => {
    const safe = safeHref(resolveImageUrl(href, resolveImageHref), { image: true });

    if (!safe) {
      return escapeHtml(text || '');
    }

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

const MARKDOWN_OPTIONS = {
  gfm: true,
  breaks: true,
} as const;

/**
 * Разбирает Markdown с общими настройками показа и разрешает ссылки-сноски.
 * Готовые токены можно передавать рендереру частями без повторного разбора текста.
 */
export function lexMarkdown(src: unknown): Token[] {
  return measureChatPerformance('markdown.lex', () => marked.lexer(String(src || ''), MARKDOWN_OPTIONS),
    () => ({ chars: typeof src === 'string' ? src.length : 0 }));
}

/**
 * Рендерит готовые токены с теми же защитами, что и целый документ.
 * Raw HTML включается только явно и только при наличии документа для санитизации.
 */
export function mdTokensToHtml(tokens: Token[], options: MarkdownOptions = {}): string {
  const finish = startChatPerformance('markdown.render');
  const sanitizerDocument = options.sanitizerDocument || globalThis.document;
  const allowHtml = !!options.allowHtml && !!sanitizerDocument?.createElement;
  const html = marked.parser(tokens, {
    ...MARKDOWN_OPTIONS,
    renderer: createRenderer({ ...options, allowHtml }),
    async: false,
  });

  const result = allowHtml ? sanitizeRenderedHtml(html, options) : html;

  finish();

  return result;
}

/**
 * Целое из атрибута в объявленных границах или пустая строка. Границы обязательны:
 * `width="999999"` в чужом HTML — это не размер, а способ подвесить раскладку.
 */
function safeInteger(value: unknown, { min = 1, max = 4096 }: {
  min?: number;
  max?: number;
} = {}): string {
  const number = Number.parseInt(String(value), 10);

  return Number.isFinite(number) && number >= min && number <= max ? String(number) : '';
}

/**
 * Один элемент после marked: все атрибуты снимаются, а затем возвращаются только
 * разрешённые и проверенные. Снятие первым шагом принципиально — иначе достаточно
 * одного незнакомого атрибута вроде `onerror`, чтобы allowlist перестал что-то значить.
 */
function sanitizeElement(element: Element, {
  resolveHref,
  resolveImageHref,
}: MarkdownOptions = {}): void {
  const tag = element.tagName.toLowerCase();
  const attrs = Object.fromEntries(
    [...element.attributes].map(({ name, value }) => [name.toLowerCase(), value]),
  );

  for (const { name } of [...element.attributes]) {
    element.removeAttribute(name);
  }

  const id = String(attrs.id || '').trim();

  if (id && id.length <= 160 && /^[\p{L}\p{N}_.:-]+$/u.test(id)) {
    element.setAttribute('id', id);
  }

  const align = String(attrs.align || '').toLowerCase();

  if (ALIGN_TAGS.has(tag) && ['left', 'center', 'right'].includes(align)) {
    element.setAttribute('align', align);
  }

  const alertClasses = String(attrs.class || '').split(/\s+/).filter((name) => {
    if (tag === 'p') {
      return name === 'md-alert__title';
    }

    return tag === 'blockquote' && (name === 'md-alert' ||
      /^md-alert--(?:note|tip|important|warning|caution)$/.test(name));
  });

  if (alertClasses.length) {
    element.setAttribute('class', alertClasses.join(' '));
  }

  if (tag === 'a') {
    const resolved = resolveUrl(String(attrs.href || ''), resolveHref);

    if (resolved === false) {
      // Живой NodeList нельзя разворачивать прямо в replaceWith: он меняется по ходу.
      element.replaceWith(...[...element.childNodes]);

      return;
    }

    const safe = safeHref(resolved);

    if (safe) {
      element.setAttribute('href', safe);

      if (isDocumentLink(safe)) {
        element.setAttribute('data-document-link', 'true');
      } else if (isCodeLink(safe)) {
        element.setAttribute('data-code-link', 'true');
      } else {
        element.setAttribute('target', '_blank');
        element.setAttribute('rel', 'noopener noreferrer');
      }
    }

    if (attrs.title) {
      element.setAttribute('title', attrs.title.slice(0, 500));
    }
  } else if (tag === 'img') {
    const safe = safeHref(
      resolveImageUrl(String(attrs.src || ''), resolveImageHref),
      { image: true },
    );

    if (!safe) {
      element.replaceWith(element.ownerDocument.createTextNode(attrs.alt || ''));

      return;
    }

    element.setAttribute('src', safe);
    element.setAttribute('alt', String(attrs.alt || '').slice(0, 500));
    element.setAttribute('loading', 'lazy');

    if (attrs.title) {
      element.setAttribute('title', attrs.title.slice(0, 500));
    }

    const width = safeInteger(attrs.width);
    const height = safeInteger(attrs.height);

    if (width) {
      element.setAttribute('width', width);
    }

    if (height) {
      element.setAttribute('height', height);
    }
  } else if (tag === 'code') {
    const language = String(attrs.class || '')
      .match(/(?:^|\s)(language-[a-z0-9_-]+)(?:\s|$)/i)?.[1];

    if (language) {
      element.setAttribute('class', language.toLowerCase());
    }
  } else if (tag === 'ol') {
    const start = safeInteger(attrs.start, { min: 1, max: 100000 });

    if (start) {
      element.setAttribute('start', start);
    }
  } else if (tag === 'td' || tag === 'th') {
    const colspan = safeInteger(attrs.colspan, { min: 1, max: 100 });
    const rowspan = safeInteger(attrs.rowspan, { min: 1, max: 100 });

    if (colspan) {
      element.setAttribute('colspan', colspan);
    }

    if (rowspan) {
      element.setAttribute('rowspan', rowspan);
    }
  }
}

/**
 * Санитизация идёт ПОСЛЕ marked: так она одинаково покрывает и raw HTML, и то, что
 * породил сам Markdown. Без документа санитизировать нечем — тогда весь ввод уходит
 * экранированным текстом, а не рискует пройти мимо проверки.
 */
export function sanitizeRenderedHtml(html: unknown, options: MarkdownOptions = {}): string {
  const documentImpl = options.sanitizerDocument || globalThis.document;

  if (!documentImpl?.createElement) {
    return escapeHtml(html);
  }

  const template = documentImpl.createElement('template');

  template.innerHTML = String(html || '');

  for (const element of [...template.content.querySelectorAll('*')]) {
    // Замена запрещённого узла уносит его потомков: проверять их отдельно уже нечего.
    if (!template.content.contains(element)) {
      continue;
    }

    const tag = element.tagName.toLowerCase();

    if (!ALLOWED_HTML_TAGS.has(tag)) {
      element.replaceWith(documentImpl.createTextNode(element.outerHTML));

      continue;
    }

    sanitizeElement(element, options);
  }

  return template.innerHTML;
}

/**
 * Markdown → HTML для показа. Raw HTML включается только явной просьбой и только
 * там, где есть чем санитизировать: вне браузера правило fail closed.
 */
export function mdToHtml(src: unknown, options: MarkdownOptions = {}): string {
  return mdTokensToHtml(lexMarkdown(src), options);
}

// Однострочные превью не должны показывать служебный синтаксис Markdown:
// у ссылки оставляем подпись, у картинки — alt, у выделения и кода — содержимое.
// Разбираем Markdown тем же lexer'ом, что и основное сообщение, вместо набора regex:
// так вложенные конструкции и незакрытая разметка деградируют предсказуемо.
/**
 * Текст строчного токена. Формы токенов marked различаются полями, поэтому читаем их
 * словарём: разбирать весь union ради превью в одну строку дороже, чем оно стоит.
 */
function inlineTokenText(value: Token | null | undefined): string {
  const token = value as (Record<string, unknown> & { type?: string }) | null | undefined;

  if (!token) {
    return '';
  }

  if (token.type === 'br') {
    return ' ';
  }

  if (token.type === 'image') {
    return String(token.text || '');
  }

  if (Array.isArray(token.tokens)) {
    return token.tokens.map(inlineTokenText).join('');
  }

  return String(token.text || '');
}

/**
 * Текст блочного токена. Списки и таблицы разворачиваются в одну строку, а пустые
 * блоки исчезают: превью должно читаться, а не повторять структуру документа.
 */
function blockTokenText(value: Token | Tokens.ListItem | null | undefined): string {
  const token = value as (Record<string, unknown> & { type?: string }) | null | undefined;

  if (!token || token.type === 'space' || token.type === 'hr') {
    return '';
  }

  if (token.type === 'list') {
    return ((token.items || []) as Token[]).map(blockTokenText).filter(Boolean).join(' ');
  }
  if (token.type === 'table') {
    return [
      ...((token.header || []) as Token[]),
      ...((token.rows || []) as Token[][]).flat(),
    ].map(inlineTokenText).filter(Boolean).join(' ');
  }

  if (['paragraph', 'heading', 'text'].includes(String(token.type)) && Array.isArray(token.tokens)) {
    return token.tokens.map(inlineTokenText).join('');
  }

  if (Array.isArray(token.tokens)) {
    const nested = token.tokens.map(blockTokenText).filter(Boolean).join(' ');

    return nested || token.tokens.map(inlineTokenText).join('');
  }

  return String(token.text || '');
}

/**
 * Однострочное превью без служебного синтаксиса. Разбирается тем же lexer'ом, что и
 * основное сообщение: вложенные конструкции и незакрытая разметка тогда деградируют
 * предсказуемо, а не по-разному в наборе регулярок.
 */
export function mdToText(src: unknown): string {
  const tokens = marked.lexer(String(src || ''), { gfm: true, breaks: true });

  return tokens
    .map(blockTokenText)
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}
