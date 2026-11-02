import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { ComputedRef } from 'vue';

export interface BoardPhonePage {
  id: 'mine' | 'related' | 'own';
  label: string;
  count: number;
  loading?: boolean;
}

/**
 * Телефон перелистывает существующие панели, сохраняя их формы и вертикальную прокрутку.
 * Выбор живёт только в доске; обновление счётчиков не возвращает человека на первый экран.
 */
export function useBoardPhonePages(pages: ComputedRef<BoardPhonePage[]>) {
  const phone = ref(window.matchMedia('(max-width: 600px)').matches);
  const activePage = ref<BoardPhonePage['id']>('mine');
  const track = ref<HTMLElement | null>(null);
  let pageChosen = false;

  /**
   * Ширина страницы равна ширине трека, поэтому выбор вкладки не прокручивает всю оболочку.
   * Нулевая ширина скрытого desktop-трека не меняет выбор и не запускает анимацию.
   */
  function alignPage(): void {
    const element = track.value;
    const index = pages.value.findIndex((page) => page.id === activePage.value);

    if (!phone.value || !element || element.clientWidth <= 0 || index < 0) {
      return;
    }

    element.scrollLeft = index * element.clientWidth;
  }

  /**
   * UiTabs сохраняет обычную клавиатуру и один выбранный раздел.
   * Переход не фокусирует поиск и не вызывает нативную клавиатуру.
   */
  function selectPage(value: string | number): void {
    const page = pages.value.find((entry) => entry.id === value);

    if (!page) {
      return;
    }

    pageChosen = true;
    activePage.value = page.id;
    alignPage();
  }

  /**
   * Нативный scroll-snap ведёт жест; обработчик отражает ближайшую страницу во вкладках.
   * Обратного выравнивания здесь нет, чтобы не мешать движению пальца и инерции.
   */
  function onScroll(): void {
    const element = track.value;

    if (!phone.value || !element || element.clientWidth <= 0) {
      return;
    }

    const index = Math.max(0, Math.min(pages.value.length - 1,
      Math.round(element.scrollLeft / element.clientWidth)));
    const page = pages.value[index];

    if (page && page.id !== activePage.value) {
      pageChosen = true;
      activePage.value = page.id;
    }
  }

  /**
   * Поворот меняет размеры трека, но сохраняет выбранный раздел и экземпляры форм.
   * После применения responsive DOM возвращаем его к соответствующей границе страницы.
   */
  async function updateViewport(): Promise<void> {
    phone.value = window.matchMedia('(max-width: 600px)').matches;
    await nextTick();
    alignPage();
  }

  watch(() => pages.value.map((page) => page.id).join(','), async () => {
    if (!pageChosen || !pages.value.some((page) => page.id === activePage.value)) {
      activePage.value = pages.value[0]?.id ?? 'own';
    }

    await nextTick();
    alignPage();
  }, { immediate: true });

  onMounted(() => {
    window.addEventListener('resize', updateViewport, { passive: true });
    void updateViewport();
  });

  onBeforeUnmount(() => {
    window.removeEventListener('resize', updateViewport);
  });

  return {
    phone,
    activePage,
    track,
    selectPage,
    onScroll,
  };
}
