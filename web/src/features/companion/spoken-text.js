import { marked } from 'marked';

// Готовит безопасный ограниченный текст ответа для браузерной озвучки.
export const SPOKEN_TEXT_LIMITS = Object.freeze({ sentences: 3, codePoints: 480 });
export const SPOKEN_TEXT_SUFFIX = 'Подробности оставил в чате.';

const CONTROL_OR_BIDI = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const URL = /\b(?:[a-z][a-z0-9+.-]{1,15}:\/\/|www\.|mailto:)[^\s<>()]+/giu;
const MAIL_ADDRESS = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
// Приватность важнее точного сохранения пунктуации: после POSIX-, дискового или UNC-префикса
// поглощаем весь токен без пробелов. Попытка сохранить закрывающую скобку раскрывала суффиксы
// корректных имён наподобие `a(b)c.txt`; озвучиванию эти разделители не нужны.
const ABSOLUTE_PATH = /(^|[^\p{L}\p{N}_])(?:[a-z]:\\|\\\\|\/)\S+/giu;
const QUOTED_ABSOLUTE_PATH = /(^|[^\p{L}\p{N}_])(?:"(?:[a-z]:\\|\\\\|\/)[^"\r\n]*"|'(?:[a-z]:\\|\\\\|\/)[^'\r\n]*')/giu;
const ENV_ASSIGNMENT = /\b[A-Z_][A-Z0-9_]{0,63}\s*=\s*[^\s,;]+/giu;
const QUOTED_ENV_ASSIGNMENT = /\b[A-Z_][A-Z0-9_]{0,63}\s*=\s*(?:"[^"\r\n]*"|'[^'\r\n]*')/giu;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/giu;
const JWT_TOKEN = /\b[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/gu;
const OPAQUE = /\b(?:[a-f0-9]{32,}|[A-Za-z0-9_-]{48,})\b/giu;

function redactSensitive(value) {
  return String(value || '')
    .replace(CONTROL_OR_BIDI, '')
    .replace(URL, ' ')
    .replace(MAIL_ADDRESS, ' ')
    .replace(QUOTED_ABSOLUTE_PATH, '$1 ')
    .replace(ABSOLUTE_PATH, '$1 ')
    .replace(QUOTED_ENV_ASSIGNMENT, ' ')
    .replace(ENV_ASSIGNMENT, ' ')
    .replace(BEARER_TOKEN, ' ')
    .replace(JWT_TOKEN, ' ')
    .replace(OPAQUE, ' ');
}

function inlineText(token) {
  if (!token || ['codespan', 'html'].includes(token.type)) return '';
  if (token.type === 'br') return ' ';
  if (token.type === 'image') return '';
  if (token.type === 'link' && /^(?:[a-z][a-z0-9+.-]{1,15}:\/\/|www\.|mailto:|[^@\s]+@)/iu.test(String(token.text || ''))) return '';
  if (Array.isArray(token.tokens)) return token.tokens.map(inlineText).join('');
  // `marked` делит UNC-префикс на текстовый токен и токен экранирования и кодирует
  // окружающую кавычку в `.text` как сущность. Склейка `.raw` возвращает исходные два
  // обратных слеша, чтобы расположенный ниже редактор приватности увидел полный путь.
  if (['text', 'escape'].includes(token.type) && typeof token.raw === 'string') return token.raw;
  return token.text || '';
}

function blockText(token) {
  if (!token || ['space', 'hr', 'code', 'html'].includes(token.type)) return '';
  if (token.type === 'list') return (token.items || []).map(blockText).filter(Boolean).join(' ');
  if (token.type === 'table') {
    return [...(token.header || []), ...(token.rows || []).flat()]
      .map(inlineText).filter(Boolean).join(' ');
  }
  if (Array.isArray(token.tokens)) {
    if (['paragraph', 'heading', 'text'].includes(token.type)) return token.tokens.map(inlineText).join('');
    return token.tokens.map((item) => blockText(item) || inlineText(item)).filter(Boolean).join(' ');
  }
  return token.type === 'text' ? (token.text || '') : '';
}

function sentences(value) {
  return value.match(/[^.!?…]+(?:[.!?…]+[»”"']*|$)/gu)?.map((part) => part.trim()).filter(Boolean) || [];
}

function capCodePoints(value, limit) {
  const points = Array.from(value);
  if (points.length <= limit) return { value, truncated: false };
  let cut = points.slice(0, limit).join('').trimEnd();
  const boundary = cut.lastIndexOf(' ');
  if (boundary >= Math.floor(limit * 0.6)) cut = cut.slice(0, boundary);
  return { value: cut.replace(/[,:;\s]+$/u, '').trim(), truncated: true };
}

/** Ограниченный текст для озвучивания с учётом Markdown; он никогда не проходит через готовый HTML. */
export function spokenText(source) {
  let text = '';
  try {
    text = marked.lexer(String(source || ''), { gfm: true, breaks: true })
      .map(blockText).filter(Boolean).join(' ');
  } catch {
    return '';
  }
  text = redactSensitive(text)
    .replace(/\s+/gu, ' ')
    .trim();
  if (!text) return '';

  const parts = sentences(text);
  const sentenceTruncated = parts.length > SPOKEN_TEXT_LIMITS.sentences;
  const selected = parts.slice(0, SPOKEN_TEXT_LIMITS.sentences).join(' ').trim();
  const capped = capCodePoints(selected, SPOKEN_TEXT_LIMITS.codePoints);
  if (!capped.value) return '';
  return sentenceTruncated || capped.truncated
    ? `${capped.value} ${SPOKEN_TEXT_SUFFIX}`
    : capped.value;
}
