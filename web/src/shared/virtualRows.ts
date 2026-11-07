// Окно виртуального списка: какие строки длинного списка рисовать прямо сейчас.
// Здесь только арифметика, без DOM и Vue, чтобы правило окна проверялось отдельно.

// С этого числа строк список рисует только окно: короче него полная отрисовка дешевле
// замеров и ведёт себя ровно как обычный v-for.
export const VIRTUAL_ROWS_THRESHOLD = 200;

// Запас строк над и под видимой областью: колесо и липкие заголовки групп не должны
// показывать пустую распорку до следующего кадра.
export const VIRTUAL_ROWS_OVERSCAN = 12;

export interface VirtualRowsInput {
  // Всего строк в списке.
  count: number;
  // Шаг строки в пикселях — высота вместе с промежутком до следующей.
  rowHeight: number;
  // Верх видимой области относительно начала списка: отрицателен, пока список ниже
  // верхнего края прокрутки, и больше высоты списка, когда он уже уехал вверх.
  viewTop: number;
  viewHeight: number;
  overscan: number;
}

export interface VirtualRowsWindow {
  // Первая рисуемая строка включительно и последняя — исключительно.
  start: number;
  end: number;
  // Высота распорок вместо нерисуемых строк сверху и снизу.
  before: number;
  after: number;
}

/**
 * Считает окно строк, пересекающих видимую область, с запасом с обеих сторон.
 * Инвариант: before + (end − start) × rowHeight + after равен высоте всего списка, поэтому
 * полоса прокрутки и положение остальных строк не зависят от того, какие строки нарисованы.
 */
export function virtualRowsWindow(input: VirtualRowsInput): VirtualRowsWindow {
  const count = Math.max(0, Math.floor(Number(input.count)) || 0);
  const rowHeight = input.rowHeight > 0 ? input.rowHeight : 1;
  const overscan = Math.max(0, Math.floor(Number(input.overscan)) || 0);
  const top = Number.isFinite(input.viewTop) ? input.viewTop : 0;
  const height = Math.max(0, Number(input.viewHeight) || 0);
  const first = Math.floor(top / rowHeight);
  const last = Math.ceil((top + height) / rowHeight);
  const start = Math.min(count, Math.max(0, first - overscan));
  const end = Math.min(count, Math.max(start, last + overscan));

  return {
    start,
    end,
    before: start * rowHeight,
    after: (count - end) * rowHeight,
  };
}

/**
 * Шаг строки по нарисованному окну: расстояние от низа верхней распорки до верха нижней,
 * делённое на число строк. Так в шаг входят и margin, и gap контейнера. Без раскладки
 * (скрытая панель, тестовый DOM) замер бессмыслен — тогда остаётся прежний шаг.
 */
export function measuredRowStep(rowsTop: number, rowsBottom: number, rendered: number, fallback: number) {
  const step = (rowsBottom - rowsTop) / rendered;

  if (!rendered || !Number.isFinite(step) || step <= 0) {
    return fallback;
  }

  return step;
}
