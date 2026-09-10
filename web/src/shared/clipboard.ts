/**
 * HTTP-доступ к Cockpit не даёт secure Clipboard API. Единственный невидимый
 * textarea fallback живёт здесь, чтобы product-компоненты не создавали DOM-контролы.
 */
function copyWithLegacyTextarea(text: string): boolean {
  // Возврат фокуса обязателен: невидимый textarea забирает его у поля, в котором
  // человек работал, и без восстановления курсор «прыгает» после каждого копирования.
  const focusTarget = document.activeElement as HTMLElement | null;
  let area: HTMLTextAreaElement | null = null;

  try {
    area = document.createElement('textarea');
    area.value = text;
    area.readOnly = true;
    area.tabIndex = -1;
    area.setAttribute('aria-hidden', 'true');
    area.style.cssText = [
      'position:fixed',
      'inset:0 auto auto 0',
      'width:1px',
      'height:1px',
      'opacity:0',
      'pointer-events:none',
    ].join(';');
    document.body.appendChild(area);
    area.select();

    return document.execCommand('copy') === true;
  } catch {
    return false;
  } finally {
    area?.remove();

    try {
      focusTarget?.focus?.({ preventScroll: true });
    } catch {
      focusTarget?.focus?.();
    }
  }
}

/**
 * Сначала использует асинхронный Clipboard API, а при его отсутствии или отказе
 * возвращает результат старого синхронного пути. Ошибки наружу не протекают.
 */
export async function writeClipboardText(value: unknown): Promise<boolean> {
  const text = String(value ?? '');

  try {
    const writeText = globalThis.navigator?.clipboard?.writeText;

    if (typeof writeText === 'function') {
      await writeText.call(globalThis.navigator.clipboard, text);

      return true;
    }
  } catch {
    // Отказ Clipboard API ожидаем в HTTP-контексте: ниже остаётся legacy fallback.
  }

  return copyWithLegacyTextarea(text);
}
