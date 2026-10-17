let activeClose: (() => void) | null = null;

/**
 * Топбар раскрывает только одну плитку: новая закрывает предыдущую без возврата фокуса.
 * Повторный claim того же владельца безопасен и не запускает цикл закрытий.
 */
export function claimTopbarPanel(close: () => void): void {
  if (activeClose === close) {
    return;
  }

  const previous = activeClose;

  activeClose = close;
  previous?.();
}

/**
 * Закрывающаяся или размонтированная плитка освобождает только своё владение.
 * Запоздалое закрытие предыдущего индикатора не затрагивает уже открытый соседний.
 */
export function releaseTopbarPanel(close: () => void): void {
  if (activeClose === close) {
    activeClose = null;
  }
}
