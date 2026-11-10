/**
 * Геометрия и проекция сна используют готовую страницу без сетевого поиска.
 * Отдельный объект на фикстуру сохраняет scrollTop, не разделяя состояние между окнами.
 */
export function chatListPagingStub() {
  const page = {
    loaded: true,
    loading: false,
    error: '',
    stale: false,
    hasMore: false,
    nextCursor: null,
    scrollTop: 0,
  };

  return {
    pageFor: () => page,
    beginChatSearch() {},
    async searchChats() {},
    async ensureChatPage() {},
    async loadChatPage() {},
    async refreshChatPage() {},
  };
}
