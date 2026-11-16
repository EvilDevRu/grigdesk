
import { localeTranslator } from '../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from './uiLocalePort.ts';

const translateUi = localeTranslator(uiLocalePort);

interface TitleSession {
  title?: string;
  messages?: Array<{ role?: string }>;
}

// Короткое имя нового чата из первого запроса. Это локальная эвристика: название
// появляется сразу и не тратит отдельный вызов модели.
const NOISE_WORDS = new Set(`
  а без бы в вам вас ведь во возможно вы где да для до если есть же за и из или к как когда
  ли мне можно можешь можете мы на надо нам не но нужно о об от по пожалуйста при про с скажи
  скажите так то у хочу что чтобы это я
  добавь добавить объясни исправь исправить напиши написать помоги покажи показать проверь
  проверить реализуй реализовать расскажи сделай сделать создай создать
  a an and can could do for from help how i in is it me need of on or please the this to want
  with would you change create explain fix implement make show write
`.trim().split(/\s+/));

// Пути, имена файлов, версии и технологии вроде C++ оставляем одним словом.
const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}+#@._/-]*/gu;

function wordsOf(text: unknown): string[] {
  return (String(text || '').replace(/https?:\/\//giu, '').match(WORD_RE) || [])
    .map((word) => word.replace(/[./_-]+$/u, ''))
    .filter(Boolean);
}

/**
 * До трёх значимых слов из запроса. Если весь короткий запрос состоит из служебных
 * слов, возвращаем его как есть — выдумывать тему за пользователя хуже.
 */
export function chatTitleFromMessage(text: unknown): string {
  const words = wordsOf(text);

  if (!words.length) {
    return '';
  }

  const indexed = words.map((word, index) => ({ word, index }));
  const picked = indexed
    .filter(({ word }) => !NOISE_WORDS.has(word.toLocaleLowerCase('ru-RU')))
    .slice(0, 3);

  // Для короткой фразы добираем отброшенные слова, чтобы название по возможности
  // состояло ровно из трёх слов, но сохраняло исходный порядок.
  const target = Math.min(3, indexed.length);
  const used = new Set(picked.map(({ index }) => index));

  for (const token of indexed) {
    if (picked.length >= target) {
      break;
    }
    if (!used.has(token.index)) {
      picked.push(token);
      used.add(token.index);
    }
  }

  picked.sort((a, b) => a.index - b.index);

  const title = picked.map(({ word }) => word).join(' ');

  return title.replace(/^\p{Ll}/u, (letter) => letter.toLocaleUpperCase('ru-RU'));
}

/**
 * Запрашивает семантическое название только для первого хода безымянного чата.
 * Ручное имя и уже начатый разговор всегда сохраняют своё название.
 */
export function shouldRequestChatTitle(session: TitleSession | null | undefined): boolean {
  if (!session || String(session.title || '').trim()) {
    return false;
  }

  return !(session.messages || []).some((message) => message?.role === 'user');
}

/**
 * Даёт мгновенный заголовок до ответа серверного хука.
 * Вложения без текста получают прежнюю нейтральную подпись.
 */
export function provisionalChatTitle(
  text: unknown,
  { hasAttachments = false }: { hasAttachments?: boolean } = {},
): string {
  const source = String(text || '').trim();

  if (source) {
    return chatTitleFromMessage(source);
  }

  return hasAttachments ? translateUi('core.chatTitleChatWithAnAttachment') : '';
}

/**
 * Автоимя допустимо только до первого сообщения пользователя и только пока чат
 * действительно безымянный: ручное имя или заголовок задачи не перетираем.
 */
export function firstMessageTitle(
  session: TitleSession | null | undefined,
  text: unknown,
  attachments: unknown[] = [],
): string {
  if (!shouldRequestChatTitle(session)) {
    return '';
  }

  return provisionalChatTitle(text, { hasAttachments: attachments.length > 0 });
}

/**
 * Семантический ответ сервера заменяет только наше временное имя. Если человек
 * успел переименовать чат, его выбор всегда сильнее хука.
 */
export function applyGeneratedChatTitle(
  session: TitleSession | null | undefined,
  generated: unknown,
  provisional = '',
): boolean {
  if (!session || !String(generated || '').trim()) {
    return false;
  }

  const current = String(session.title || '').trim();

  if (current && current !== provisional) {
    return false;
  }

  session.title = String(generated).trim();

  return true;
}
