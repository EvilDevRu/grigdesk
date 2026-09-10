// Досье прерванного хода: что агент успел сделать до нажатия «стоп».
//
// Запасная память Kimi-сессии. Обычный путь после «стопа» — resume той же ACP
// session с полным контекстом (покрыто tools/kimi-resume-smoke.mjs). Но если
// возобновление проглотило prompt
// (empty-run), binding инвалидируется и следующее сообщение стартует ЧИСТУЮ
// session: память диалога теряется, а изменения на диске — нет. Чтобы агент не
// повторял уже сделанную работу и не спорил с ней, первый ход новой сессии
// получает эту выжимку служебным блоком перед сообщением пользователя.
// Вызывается только при мёртвом binding (см. modules/chat).
//
// Источник — последнее assistant-сообщение истории: остановленный ход клиент
// сохраняет с флагом `stopped` и лентой шагов. Чаты, сохранённые до появления
// флага (2026-08), распознаём по тексту-заглушке «⏹ Ход остановлен.».

import { cut } from './streamSteps.ts';
import type { ChatStep } from './streamSteps.ts';

// Сообщение истории в том минимуме, который читает досье прерванного хода.
export interface BriefMessage {
  role?: string;
  text?: unknown;
  stopped?: unknown;
  steps?: ChatStep[];
}

const STOP_REPLY_TEXT = '⏹ Ход остановлен.';
// Явный «сброс памяти» из UI: после него досье воскрешало бы то, что человек
// просил забыть, — note с этим текстом позже stopped-сообщения отменяет выжимку.
const USER_RESET_NOTE = 'Память агента сброшена';
// Хвост важнее начала: у длинного хода досье описывает, к чему агент пришёл.
const STEP_LINES_LIMIT = 20;
const STEP_LINE_LIMIT = 160;
const PARTIAL_TEXT_LIMIT = 800;

function isStoppedAssistant(message: BriefMessage | null | undefined): boolean {
  if (message?.role !== 'assistant') return false;
  if (message.stopped === true) return true;
  return String(message.text || '').trim() === STOP_REPLY_TEXT;
}

// Одна строка досье на шаг. «Работа» — это действия и провалы; размышления,
// планы и успешные итоги в выжимку не входят: они не меняли состояние.
function stepLine(step: ChatStep | null | undefined): string {
  if (step?.k === 'tool') {
    const name = String(step.name || 'Действие');
    const title = String(step.title || '');
    return `- ${name}${title && title !== name ? `: ${title}` : ''}`;
  }
  if (step?.k === 'res' && step.ok === false) {
    // На провал агенту важно не натолкнуться повторно вслепую.
    return `- Ошибка: ${String(step.text || '').split('\n')[0]}`;
  }
  return '';
}

/**
 * Выжимка остановленного хода для первого сообщения новой сессии.
 * Срабатывает один раз: после любого успешного ответа последним assistant-
 * сообщением становится обычное, без признака остановки. Пустая строка —
 * досье не нужно (нечего сказать, остановки не было или память сброшена явно).
 */
export function stoppedTurnBrief(messages: BriefMessage[] | null | undefined): string {
  if (!Array.isArray(messages) || !messages.length) return '';
  const lastIndex = messages.findLastIndex((m) => m?.role === 'assistant');
  const last = lastIndex >= 0 ? messages[lastIndex] : null;
  if (!isStoppedAssistant(last)) return '';
  // Стоп, а потом явный сброс памяти — намерения человека противоположные;
  // побеждает более позднее (сброс).
  const wipedAfter = messages.slice(lastIndex + 1).some((m) => (
    m?.role === 'note' && String(m.text || '').includes(USER_RESET_NOTE)
  ));
  if (wipedAfter) return '';

  const lines: string[] = [];
  for (const step of Array.isArray(last?.steps) ? last.steps : []) {
    const line = stepLine(step);
    // Дубли подряд — шум от tool_call/tool_call_update одного действия.
    if (line && lines.at(-1) !== line) lines.push(line);
  }
  const omitted = Math.max(0, lines.length - STEP_LINES_LIMIT);
  const kept = lines.slice(-STEP_LINES_LIMIT).map((line) => cut(line, STEP_LINE_LIMIT));

  // Сегодня ответ остановленного хода — всегда заглушка-маркер; нестандартный
  // текст (если появится) передаём как частичный ответ.
  const partial = String(last?.text || '').trim();
  const partialBlock = partial && partial !== STOP_REPLY_TEXT
    ? `\n\nЧастичный ответ агента перед остановкой:\n${cut(partial, PARTIAL_TEXT_LIMIT)}`
    : '';
  if (!kept.length && !partialBlock) return '';

  const stepsBlock = kept.length
    ? `\nОстановленный ход успел выполнить:\n${kept.join('\n')}${omitted ? `\n(и ранее — ещё ${omitted} шагов)` : ''}`
    : '';
  return `[Досье прерванного хода]
Предыдущий ход агента был остановлен пользователем кнопкой «стоп». Сессия агента пересоздана: память разговора утеряна, но все изменения на диске сохранились.${stepsBlock}${partialBlock}
Не повторяй уже выполненную работу — учитывай её вместе с новым сообщением пользователя; если просят продолжить, продолжай с этого места.
[/Досье прерванного хода]`;
}
