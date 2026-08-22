// Единый реестр реально видимых chat surfaces. Он хранит только exact chat id:
// геометрия bubble/page остаётся у компонентов, а notifications не угадывают её по
// route или legacy boolean.
export function createChatVisibilityRegistry({
  isDocumentVisible = () => typeof document === 'undefined' || !document.hidden,
} = {}) {
  const surfaces = new Map();

  function normalize(value) {
    return {
      chatId: typeof value?.chatId === 'string' && value.chatId ? value.chatId : null,
      visible: value?.visible === true,
    };
  }

  function register(owner, initial = {}) {
    const token = Symbol(String(owner || 'chat-surface'));
    const surface = normalize(initial);
    surfaces.set(token, surface);
    let disposed = false;

    return Object.freeze({
      update(next = {}) {
        if (disposed || surfaces.get(token) !== surface) return false;
        Object.assign(surface, normalize(next));
        return true;
      },
      dispose() {
        if (disposed || surfaces.get(token) !== surface) return false;
        disposed = true;
        surfaces.delete(token);
        return true;
      },
    });
  }

  function isVisible(chatId) {
    const exact = typeof chatId === 'string' ? chatId : '';
    if (!exact || !isDocumentVisible()) return false;
    return [...surfaces.values()].some((surface) => surface.visible && surface.chatId === exact);
  }

  return Object.freeze({ register, isVisible, size: () => surfaces.size });
}

export const chatVisibility = createChatVisibilityRegistry();
