// Provider-neutral хук короткого названия чата. Cockpit добавляет инструкцию только
// в первый ход безымянного чата, а затем вырезает служебный маркер из ответа и ленты.
const TITLE_MARKER_RE = /\[\[COCKPIT_CHAT_TITLE\s*[|:]\s*([\s\S]*?)\]\]/giu;
const TITLE_WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}+#@._/-]*/gu;

const TITLE_HOOK = `[Служебный хук Cockpit: название чата]
Это первый ход нового безымянного чата. По смыслу пользовательской просьбы придумай краткое название разговора.
Название должно отражать именно просьбу пользователя, а не служебные блоки контекста Cockpit.
В самом конце финального ответа на отдельной строке добавь ровно один маркер:
[[COCKPIT_CHAT_TITLE|Три Смысловых Слова]]
Внутри маркера должно быть ровно три слова без кавычек и конечной точки, на языке пользователя.
Маркер служебный: не объясняй и не упоминай его в обычном ответе. Добавь его только в этом ходе.
[/Служебный хук Cockpit]`;

/** Добавить служебную инструкцию в тот же модельный ход — отдельного вызова модели нет. */
export function withChatTitleHook(message, enabled) {
  if (!enabled) return message;
  // Ставим хук после UI-контекста, вложений и самой просьбы: на длинном запросе
  // модель не должна забыть вернуть метаданные к моменту финального ответа.
  return `${message}\n\n${TITLE_HOOK}`;
}

/** Строгая граница протокола: наружу проходит только безопасное название ровно из трёх слов. */
export function normalizeChatTitle(value) {
  const words = (String(value || '').match(TITLE_WORD_RE) || [])
    .map((word) => word.replace(/[./_-]+$/u, ''))
    .filter(Boolean);
  if (words.length !== 3) return '';
  const title = words.join(' ');
  if (title.length > 96) return '';
  return title.replace(/^\p{Ll}/u, (letter) => letter.toLocaleUpperCase('ru-RU'));
}

/**
 * Извлечь название и убрать все варианты служебного маркера. Даже некорректный
 * маркер не должен попасть пользователю в ответ.
 */
export function readChatTitle(reply, enabled) {
  const original = String(reply || '');
  if (!enabled) return { reply: original, title: '' };
  let title = '';
  const clean = original.replace(TITLE_MARKER_RE, (_marker, candidate) => {
    // По протоколу настоящий маркер стоит в конце: если модель сначала процитировала
    // пример из инструкции, последнее валидное значение должно победить.
    title = normalizeChatTitle(candidate) || title;
    return '';
  }).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { reply: clean, title };
}

/** Скрыть маркер из живого text-шага Claude до отправки по SSE. */
export function visibleChatTitleStep(step, enabled) {
  if (!enabled || step?.k !== 'text' || typeof step.text !== 'string') return step;
  const { reply: text } = readChatTitle(step.text, true);
  return text ? { ...step, text } : null;
}

/** Финальная обработка provider-neutral результата и сохранённой ленты хода. */
export function finishChatTitleHook(result, enabled) {
  if (!enabled || !result) return result;
  const parsed = readChatTitle(result.reply, true);
  const steps = (result.steps || [])
    .map((step) => visibleChatTitleStep(step, true))
    .filter(Boolean);
  return {
    ...result,
    reply: parsed.reply,
    steps,
    ...(parsed.title ? { title: parsed.title } : {}),
  };
}
