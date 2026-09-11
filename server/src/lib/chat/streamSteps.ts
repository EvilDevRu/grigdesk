// Нейтральный контракт ленты хода агента.
//
// Каждый executor переводит собственный поток CLI в короткие шаги этого формата и
// передаёт их в createStepSink(). Здесь НЕТ знания о Claude, Codex или другом
// поставщике: новый ИИ добавляет свой executor и normalizer рядом с ним, не меняя
// modules/chat и Vue-компоненты.
//
// Виды шагов (поле k):
//   start — начало хода; think — опубликованное provider-ом резюме рассуждений;
//   text  — промежуточный текст; tool/res — действие и его итог; note — служебное.
// У шага tool, который меняет файлы, есть необязательное поле files: string[] —
// нормализованные пути изменённых файлов (у одного вызова их может быть несколько).
// Полный внутренний ход мыслей сюда не передаётся: normalizer берёт только поля,
// которые сам provider предназначил для показа пользователю.

export const MAX_CHAT_STEPS = 400;
export const STEP_TEXT_LIMIT = 1200;
export const STEP_DIFF_LIMIT = 2000;
// Размышление — единственный шаг, который человек читает целиком и ради которого
// раскрывает ленту. Общий лимит строки (1200) резал его на полуслове: у Codex и Kimi
// «размышления» выглядели обрывком фразы. Отдельный лимит больше, но не безграничен:
// лента уезжает в SSE и в файл истории чата.
export const STEP_THINK_LIMIT = 6000;

// Шаг ленты в нейтральном контракте: род (`k`) и поля, которые заполняет normalizer
// конкретного исполнителя. Форма намеренно открытая — своё поле добавляет он же.
export interface ChatStep {
  k: string;
  at?: number;
  [field: string]: unknown;
}

// Приёмник ленты: локальная копия для истории плюс трансляция в SSE.
export interface StepSink {
  steps: ChatStep[];
  emit: (step: ChatStep | null | undefined) => ChatStep | null;
  emitAll: (items: unknown) => void;
}

export function cut(value: unknown, limit = STEP_TEXT_LIMIT): string {
  const text = String(value ?? '');
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

// Для длинной команды важны обе стороны: начало объясняет запуск, конец —
// цепочку проверок и финальные аргументы, которые не помещаются в строку ленты.
export function cutMiddle(value: unknown, limit = STEP_TEXT_LIMIT): string {
  const text = String(value ?? '');
  if (text.length <= limit) return text;
  const marker = '\n… сокращено …\n';
  const available = Math.max(0, limit - marker.length);
  const head = Math.ceil(available / 2);
  return `${text.slice(0, head)}${marker}${text.slice(-(available - head))}`;
}

export function base(filePath: unknown): string {
  return String(filePath || '').split('/').filter(Boolean).pop() || String(filePath || '');
}

export function lineCount(value: unknown): number {
  return value ? String(value).split('\n').length : 0;
}

/**
 * Кладёт шаг в ленту и удерживает её в пределах окна.
 *
 * Вытеснение НЕ молчит: место самого старого шага занимает строка-счётчик. Раньше начало
 * длинного хода исчезало бесследно, и человек читал оставшуюся ленту как полный отчёт —
 * агент отчитывался о работе, следов которой в ленте уже не было. Счётчик вытесненного
 * живёт в самой метке, поэтому функция не хранит состояния: следующая метка продолжает
 * счёт предыдущей, а сама меткой не считается.
 *
 * Копия этой арифметики есть у ленты в браузере (`web/src/stores/chat.js`): стор грузят
 * офлайн-тесты подменой импортов, поэтому общий модуль ему не завезёшь.
 */
export function pushChatStep(
  steps: ChatStep[],
  step: ChatStep,
  limit: number,
  now: () => number = () => Date.now(),
): ChatStep[] {
  steps.push(step);
  // В окно меньше двух мест метку не положить: там она вытеснила бы сам шаг.
  if (limit < 2 || steps.length <= limit) return steps;

  const removed = steps.splice(0, steps.length - (limit - 1));
  const dropped = Number(removed.find((old) => old.truncated)?.dropped || 0)
    + removed.filter((old) => !old.truncated).length;
  steps.unshift({
    k: 'note',
    level: 'warn',
    truncated: true,
    dropped,
    text: `… ранние шаги хода скрыты: ${dropped}`,
    at: now(),
  });
  return steps;
}

/**
 * Принимает уже нормализованные шаги, ставит timestamp, ограничивает хранение и
 * безопасно передаёт поток в SSE. Локальная копия нужна executor-у для истории и
 * для корректного ответа после остановки хода.
 */
export function createStepSink(onStep: ((step: ChatStep) => void) | null | undefined, {
  limit = MAX_CHAT_STEPS,
  now = () => Date.now(),
} = {}): StepSink {
  const steps: ChatStep[] = [];

  function emit(step: ChatStep | null | undefined): ChatStep | null {
    if (!step || typeof step !== 'object' || !step.k) return null;
    const next = {
      ...step,
      at: typeof step.at === 'number' && Number.isFinite(step.at) ? step.at : now(),
    };
    // Лимит ограничивает ХРАНЕНИЕ, а не трансляцию. Раньше он глушил и `onStep`:
    // ход на 400-м шаге переставал слать SSE, и лента в окне замирала навсегда —
    // человек видел вечное «думает…» и считал агента повисшим, хотя тот работал
    // ещё час (у Codex это заметнее: его счётчик токенов тикает только в конце хода,
    // так что других признаков жизни у окна не остаётся вовсе).
    // Окно скользящее: у длинного хода ценен свежий хвост, а не архив начала —
    // именно он восстанавливается в ленте после F5. Вытесненное называет счётчик,
    // иначе сохранённая лента выдаёт себя за полный отчёт о ходе.
    pushChatStep(steps, next, limit, now);
    try { onStep?.(next); } catch { /* лента не должна ронять ход агента */ }
    return next;
  }

  function emitAll(items: unknown): void {
    if (!Array.isArray(items)) return;
    for (const item of items) emit(item);
  }

  return { steps, emit, emitAll };
}
