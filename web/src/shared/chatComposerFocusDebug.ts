import { summarizeWebError } from './webDiagnostics.ts';

interface FocusDebugWindow extends Window {
  __grigDeskLog?: { mark(text: string): unknown };
}

/**
 * AGENT-DBG: временная трасса неожиданного ухода фокуса во время набора.
 * Наблюдает только события и признаки DOM; содержимое поля и клавиши не сохраняет.
 */
export function installChatComposerFocusDebug(
  element: HTMLTextAreaElement,
  now: () => number = Date.now,
): () => void {
  const doc = element.ownerDocument;
  const win = doc.defaultView as FocusDebugWindow | null;
  let editingAt = -Infinity;
  let lastReportAt = -Infinity;
  let intended = false;
  let pending = false;
  let disposed = false;

  function onInput(): void {
    editingAt = now();
    intended = false;
  }

  function onPointerdown(): void {
    intended = true;
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Tab' || event.key === 'Escape' || event.ctrlKey || event.altKey || event.metaKey) {
      intended = true;
    }
  }

  /**
   * Синхронный стек сохраняет источник программного focus, microtask — итоговую цель.
   * Явный клик, навигационная клавиша, давний набор и повторы не создают отметок.
   */
  function onFocusLost(event: Event): void {
    const at = now();

    if (pending || intended || at - editingAt > 3000 || at - lastReportAt < 60_000) {
      return;
    }

    const stack = summarizeWebError(new Error()).stack || '';
    const cause = event.type === 'blur' ? 'window' : 'element';

    pending = true;
    queueMicrotask(() => {
      pending = false;

      if (disposed) {
        return;
      }

      lastReportAt = at;

      const tag = doc.activeElement?.tagName || 'NONE';
      const state = {
        cause,
        active: ['BODY', 'BUTTON', 'INPUT', 'TEXTAREA', 'IFRAME', 'A', 'SELECT', 'DIV', 'NONE']
          .includes(tag) ? tag : 'OTHER',
        connected: element.isConnected,
        disabled: element.disabled,
        focused: doc.hasFocus(),
        visible: doc.visibilityState === 'visible',
        editingMs: Math.max(0, at - editingAt),
      };
      const text = `AGENT-DBG chat-composer-focus ${JSON.stringify(state)} ${stack}`.slice(0, 500);

      try {
        if (win?.__grigDeskLog?.mark(text)) {
          console.warn(text);
        }
      } catch {
        // Диагностика не вмешивается во ввод при отказе журнала.
      }
    });
  }

  element.addEventListener('input', onInput);
  element.addEventListener('focusout', onFocusLost);
  doc.addEventListener('pointerdown', onPointerdown, true);
  doc.addEventListener('keydown', onKeydown, true);
  win?.addEventListener('blur', onFocusLost);

  return () => {
    disposed = true;
    element.removeEventListener('input', onInput);
    element.removeEventListener('focusout', onFocusLost);
    doc.removeEventListener('pointerdown', onPointerdown, true);
    doc.removeEventListener('keydown', onKeydown, true);
    win?.removeEventListener('blur', onFocusLost);
  };
}
