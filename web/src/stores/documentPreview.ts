import { defineStore } from 'pinia';

// Глобальный viewer нужен, чтобы ссылка из любого чата открывалась поверх текущего
// экрана и не разрушала навигационный контекст страницы. Он же показывает картинки и
// куски записи из разбора встречи: заводить рядом второй такой же значит и городить
// вторую модалку, и разойтись с ней в поведении Escape и возврата фокуса.

// Показываемое вложение. `mime` бывает пустым: сервер не всегда его знает, и это не
// повод отказываться показывать — браузер разберётся по самому файлу.
export interface PreviewMedia {
  src: string;
  name: string;
  mime: string;
}

// Открыто ровно одно: адрес документа, картинка ИЛИ видео. Три поля вместо одного
// объединения — так их читает разметка, и переписывать её ради формы состояния незачем.
export interface DocumentPreviewState {
  href: string;
  image: PreviewMedia | null;
  video: PreviewMedia | null;
}

export interface PreviewMediaInput {
  src?: string;
  name?: string;
  mime?: string;
}

export const useDocumentPreviewStore = defineStore('document-preview', {
  state: (): DocumentPreviewState => ({
    href: '',
    image: null,
    video: null,
  }),
  getters: {
    visible: (state): boolean => Boolean(state.href || state.image || state.video),
  },
  actions: {
    show(href: string): void {
      this.image = null;
      this.video = null;
      this.href = String(href || '');
    },

    /**
     * Картинка поверх экрана. Пустой адрес не открывает пустую модалку: показывать
     * там нечего, а закрывать её человеку пришлось бы вручную.
     */
    showImage({ src, name = '', mime = '' }: PreviewMediaInput = {}): void {
      const safeSrc = String(src || '').trim();

      if (!safeSrc) {
        return;
      }

      this.image = {
        src: safeSrc,
        name: String(name || 'Изображение'),
        mime: String(mime || ''),
      };
      this.href = '';
      this.video = null;
    },

    /**
     * Видео поверх экрана: фрагмент записи из разбора встречи. Пустой адрес,
     * как и у картинки, ничего не открывает — показывать там нечего.
     */
    showVideo({ src, name = '', mime = '' }: PreviewMediaInput = {}): void {
      const safeSrc = String(src || '').trim();

      if (!safeSrc) {
        return;
      }

      this.video = {
        src: safeSrc,
        name: String(name || 'Видео'),
        mime: String(mime || ''),
      };
      this.href = '';
      this.image = null;
    },

    close(): void {
      this.href = '';
      this.image = null;
      this.video = null;
    },
  },
});
