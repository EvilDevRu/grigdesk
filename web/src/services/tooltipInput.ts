/**
 * Отделяем касание от указателей, у которых есть настоящее наведение.
 * Обычные Event без pointerType считаются не сенсорными.
 */
export function isTouchPointer(event: Event): boolean {
  return (event as PointerEvent).pointerType === 'touch';
}

/**
 * Браузер определяет клавиатурный фокус через focus-visible.
 * Среда без поддержки селектора получает совместимое поведение.
 */
export function isKeyboardFocus(event: Event): boolean {
  try {
    return (event.target as Element).matches(':focus-visible');
  } catch {
    return true;
  }
}
