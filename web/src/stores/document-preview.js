import { defineStore } from 'pinia';

// Глобальный viewer нужен, чтобы ссылка из любого чата открывалась поверх текущего
// экрана и не разрушала навигационный контекст страницы. Он же показывает картинки и
// куски записи из разбора встречи: заводить рядом второй такой же значит и городить
// вторую модалку, и разойтись с ней в поведении Escape и возврата фокуса.
export const useDocumentPreviewStore = defineStore('document-preview', {
  state: () => ({ href: '', image: null, video: null }),
  getters: {
    visible: (state) => !!state.href || !!state.image || !!state.video,
  },
  actions: {
    show(href) {
      this.image = null;
      this.video = null;
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
      this.video = null;
    },
    /** Видео поверх экрана: фрагмент записи из разбора встречи. */
    showVideo({ src, name = '', mime = '' } = {}) {
      const safeSrc = String(src || '').trim();
      if (!safeSrc) return;
      this.video = {
        src: safeSrc,
        name: String(name || 'Видео'),
        mime: String(mime || ''),
      };
      this.href = '';
      this.image = null;
    },
    close() {
      this.href = '';
      this.image = null;
      this.video = null;
    },
  },
});
