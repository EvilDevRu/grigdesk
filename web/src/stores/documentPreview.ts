import { defineStore } from 'pinia';
import { localeTranslator } from '../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from '../shared/uiLocalePort.ts';

const translateUi = localeTranslator(uiLocalePort);


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
  // Картинки той же ленты в порядке показа: по ним листают стрелками просмотра.
  gallery: PreviewMedia[];
}

export interface PreviewMediaInput {
  src?: string;
  name?: string;
  mime?: string;
}

/**
 * Адрес из DOM приходит абсолютным, а из API — относительным: сравниваются полные адреса.
 * Неразбираемая строка сравнивается как есть, чтобы не уронить просмотр.
 */
function sameSource(left: string, right: string): boolean {
  const base = globalThis.location?.href || 'http://localhost/';

  try {
    return new URL(left, base).href === new URL(right, base).href;
  } catch {
    return left === right;
  }
}

/**
 * Набор ленты принимается, только если в нём есть открываемая картинка: иначе стрелки
 * листали бы чужую последовательность. Пустые адреса и повторы отбрасываются.
 */
function galleryOf(current: PreviewMedia, items: PreviewMediaInput[]): PreviewMedia[] {
  const gallery: PreviewMedia[] = [];

  for (const item of items) {
    const src = String(item.src || '').trim();

    if (src && !gallery.some((entry) => sameSource(entry.src, src))) {
      gallery.push({
        src,
        name: String(item.name || translateUi('core.chatIzobrazhenie')),
        mime: String(item.mime || ''),
      });
    }
  }

  return gallery.length > 1 && gallery.some((entry) => sameSource(entry.src, current.src)) ? gallery : [];
}

export const useDocumentPreviewStore = defineStore('document-preview', {
  state: (): DocumentPreviewState => ({
    href: '',
    image: null,
    video: null,
    gallery: [],
  }),
  getters: {
    visible: (state): boolean => Boolean(state.href || state.image || state.video),
    galleryIndex: (state): number => state.image
      ? state.gallery.findIndex((entry) => sameSource(entry.src, state.image?.src || '')) : -1,
  },
  actions: {
    /**
     * Документ по адресу. Картинка, видео и набор ленты гасятся: открыто ровно одно,
     * и стрелки просмотра не должны пережить переход к документу.
     */
    show(href: string): void {
      this.image = null;
      this.video = null;
      this.gallery = [];
      this.href = String(href || '');
    },

    /**
     * Картинка поверх экрана. Пустой адрес не открывает пустую модалку: показывать
     * там нечего, а закрывать её человеку пришлось бы вручную.
     */
    showImage(
      { src, name = '', mime = '' }: PreviewMediaInput = {},
      gallery: PreviewMediaInput[] = [],
    ): void {
      const safeSrc = String(src || '').trim();

      if (!safeSrc) {
        return;
      }

      this.image = {
        src: safeSrc,
        name: String(name || translateUi('core.chatIzobrazhenie')),
        mime: String(mime || ''),
      };
      this.gallery = galleryOf(this.image, gallery);
      this.href = '';
      this.video = null;
    },

    /**
     * Шаг по картинкам ленты. На краях шаг не перескакивает в начало: счётчик «5 из 5»
     * должен значить, что дальше картинок нет.
     */
    stepImage(delta: number): void {
      const next = this.gallery[this.galleryIndex + delta];

      if (this.galleryIndex >= 0 && next) {
        this.image = { ...next };
      }
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
        name: String(name || translateUi('core.navVideo')),
        mime: String(mime || ''),
      };
      this.href = '';
      this.image = null;
      this.gallery = [];
    },

    /**
     * Закрытие просмотра сбрасывает всё сразу, включая набор ленты:
     * следующая картинка откроется со своим набором, а не с прошлым.
     */
    close(): void {
      this.href = '';
      this.image = null;
      this.video = null;
      this.gallery = [];
    },
  },
});
