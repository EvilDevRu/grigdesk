import { defineStore } from 'pinia';

// Глобальный viewer нужен, чтобы ссылка из любого чата открывалась поверх текущего
// экрана и не разрушала навигационный контекст страницы.
export const useDocumentPreviewStore = defineStore('document-preview', {
  state: () => ({ href: '', image: null }),
  getters: {
    visible: (state) => !!state.href || !!state.image,
  },
  actions: {
    show(href) {
      this.image = null;
      this.href = String(href || '');
    },
    showImage({ src, name = '', mime = '' } = {}) {
      const safeSrc = String(src || '').trim();
      if (!safeSrc) return;
      this.image = {
        src: safeSrc,
        name: String(name || 'Изображение'),
        mime: String(mime || ''),
      };
      this.href = '';
    },
    close() {
      this.href = '';
      this.image = null;
    },
  },
});
