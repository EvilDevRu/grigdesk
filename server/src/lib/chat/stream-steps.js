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
// Полный внутренний ход мыслей сюда не передаётся: normalizer берёт только поля,
// которые сам provider предназначил для показа пользователю.

export const MAX_CHAT_STEPS = 400;
export const STEP_TEXT_LIMIT = 1200;
export const STEP_DIFF_LIMIT = 2000;

export function cut(value, limit = STEP_TEXT_LIMIT) {
  const text = String(value ?? '');
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

// Для длинной команды важны обе стороны: начало объясняет запуск, конец —
// цепочку проверок и финальные аргументы, которые не помещаются в строку ленты.
export function cutMiddle(value, limit = STEP_TEXT_LIMIT) {
  const text = String(value ?? '');
  if (text.length <= limit) return text;
  const marker = '\n… сокращено …\n';
  const available = Math.max(0, limit - marker.length);
  const head = Math.ceil(available / 2);
  return `${text.slice(0, head)}${marker}${text.slice(-(available - head))}`;
}

export function base(filePath) {
  return String(filePath || '').split('/').filter(Boolean).pop() || String(filePath || '');
}

export function lineCount(value) {
  return value ? String(value).split('\n').length : 0;
}

/**
 * Принимает уже нормализованные шаги, ставит timestamp, ограничивает хранение и
 * безопасно передаёт поток в SSE. Локальная копия нужна executor-у для истории и
 * для корректного ответа после остановки хода.
 */
export function createStepSink(onStep, {
  limit = MAX_CHAT_STEPS,
  now = () => Date.now(),
} = {}) {
  const steps = [];

  function emit(step) {
    if (!step || typeof step !== 'object' || !step.k) return null;
    const next = {
      ...step,
      at: Number.isFinite(step.at) ? step.at : now(),
    };
    // Лимит ограничивает ХРАНЕНИЕ, а не трансляцию. Раньше он глушил и `onStep`:
    // ход на 400-м шаге переставал слать SSE, и лента в окне замирала навсегда —
    // человек видел вечное «думает…» и считал агента повисшим, хотя тот работал
    // ещё час (у Codex это заметнее: его счётчик токенов тикает только в конце хода,
    // так что других признаков жизни у окна не остаётся вовсе).
    // Окно скользящее: у длинного хода ценен свежий хвост, а не архив начала —
    // именно он восстанавливается в ленте после F5.
    steps.push(next);
    if (steps.length > limit) steps.splice(0, steps.length - limit);
    try { onStep?.(next); } catch { /* лента не должна ронять ход агента */ }
    return next;
  }

  function emitAll(items) {
    if (!Array.isArray(items)) return;
    for (const item of items) emit(item);
  }

  return { steps, emit, emitAll };
}
