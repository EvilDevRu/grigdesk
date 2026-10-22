interface SurfaceInput {
  chatId?: unknown;
  visible?: unknown;
}

// Единый реестр реально видимых chat surfaces. Он хранит только exact chat id:
// геометрия bubble/page остаётся у компонентов, а notifications не угадывают её по
// route или legacy boolean.
export function createChatVisibilityRegistry({
  isDocumentVisible = () => typeof document === 'undefined' || !document.hidden,
}: { isDocumentVisible?: () => boolean } = {}) {
  const surfaces = new Map<symbol, { chatId: string | null; visible: boolean }>();

  function normalize(value: SurfaceInput) {
    return {
      chatId: typeof value?.chatId === 'string' && value.chatId ? value.chatId : null,
      visible: value?.visible === true,
    };
  }

  /**
   * Каждый показ владеет своим токеном, даже если владельцы имеют одинаковое имя.
   * Позднее закрытие старого показа не удаляет новый видимый чат.
   */
  function register(owner: unknown, initial: SurfaceInput = {}) {
    const token = Symbol(String(owner || 'chat-surface'));
    const surface = normalize(initial);

    surfaces.set(token, surface);

    let disposed = false;


    return Object.freeze({
      update(next: SurfaceInput = {}): boolean {
        if (disposed || surfaces.get(token) !== surface) {
          return false;
        }

        Object.assign(surface, normalize(next));

        return true;
      },
      /**
       * Удаляет только запись своего показа и помечает ручку закрытой.
       * Повторное освобождение не затрагивает остальные поверхности.
       */
      dispose() {
        if (disposed || surfaces.get(token) !== surface) {
          return false;
        }

        disposed = true;
        surfaces.delete(token);

        return true;
      },
    });
  }

  /**
   * Проверяет точный чат и видимость документа без догадок по текущему маршруту.
   * Несколько поверхностей могут одновременно показывать один разговор.
   */
  function isVisible(chatId: unknown): boolean {
    const exact = typeof chatId === 'string' ? chatId : '';

    if (!exact || !isDocumentVisible()) {
      return false;
    }

    return [...surfaces.values()].some((surface) => surface.visible && surface.chatId === exact);
  }

  return Object.freeze({
    register,
    isVisible,
    size: () => surfaces.size,
  });
}

export const chatVisibility = createChatVisibilityRegistry();
