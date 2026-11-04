import { parseKeyboardLayout } from '../../../shared/desktop/keyboardLayout.ts';
import type { KeyboardLayout } from '../../../shared/desktop/keyboardLayout.ts';

/**
 * Опрос живёт только у видимого активного окна и не читает набранный человеком текст.
 * Скрытие и размонтирование отменяют запрос: поздний ответ не возвращает старую раскладку.
 */
export function observeKeyboardLayout(
  win: Window,
  publish: (layout: KeyboardLayout | null) => void,
): () => void {
  let stopped = false;
  let timer: number | undefined;
  let requestTimeout: number | undefined;
  let request: AbortController | null = null;

  const active = () => !stopped && win.document.visibilityState === 'visible' && win.document.hasFocus();

  /**
   * Освобождает таймер и снимает владение запросом до его отмены.
   * Старый finally после abort уже не может назначить следующий опрос.
   */
  const cancel = () => {
    win.clearTimeout(timer);
    win.clearTimeout(requestTimeout);

    const previous = request;

    request = null;
    previous?.abort();
  };

  /**
   * Единственный запрос получает состояние через защищённую трубу этого окна.
   * Ошибка показывает неизвестную раскладку и не сохраняет последнее успешное значение.
   */
  const refresh = async () => {
    if (!active() || request) {
      return;
    }

    win.clearTimeout(timer);

    const controller = new AbortController();
    const timeout = win.setTimeout(() => controller.abort(), 2000);

    requestTimeout = timeout;
    request = controller;

    try {
      const response = await win.fetch('/__shell/keyboard-layout', {
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal,
      });
      const body = response.ok ? await response.json() as { layout?: unknown } | null : null;

      if (request === controller && active()) {
        publish(parseKeyboardLayout(body?.layout));
      }
    } catch {
      if (request === controller && active()) {
        publish(null);
      }
    } finally {
      win.clearTimeout(timeout);

      if (request === controller) {
        request = null;

        if (active()) {
          timer = win.setTimeout(() => void refresh(), 500);
        }
      }
    }
  };

  /**
   * При возвращении в окно раскладка перечитывается до очередного интервала.
   * В фоне значение сбрасывается, чтобы не показывать состояние чужого активного окна.
   */
  const sync = () => {
    cancel();
    publish(null);
    void refresh();
  };

  win.addEventListener('focus', sync);
  win.addEventListener('blur', sync);
  win.document.addEventListener('visibilitychange', sync);
  void refresh();

  return () => {
    stopped = true;
    cancel();
    win.removeEventListener('focus', sync);
    win.removeEventListener('blur', sync);
    win.document.removeEventListener('visibilitychange', sync);
  };
}
