import { computed, onScopeDispose, ref, watch, type Ref } from 'vue';

interface Point {
  x: number;
  y: number;
}

interface Gesture {
  center: Point;
  distance: number;
  scale: number;
  offset: Point;
}

/**
 * Жесты меняют только картинку: шапка, стрелки и счётчик остаются в масштабе интерфейса.
 * Смещение ограничено краями изображения; смена числа пальцев начинает новый отсчёт без скачка.
 */
export function useMediaImageZoom(stage: Ref<HTMLElement | null>, image: Ref<HTMLImageElement | null>) {
  const scale = ref(1);
  const offset = ref<Point>({ x: 0, y: 0 });
  const pointers = new Map<number, Point>();
  const enlarged = computed(() => scale.value > 1);
  const style = computed(() => ({
    transform: `translate(${offset.value.x}px, ${offset.value.y}px) scale(${scale.value})`,
  }));

  let gesture: Gesture | null = null;
  let moved = false;
  let backgroundPress = false;
  let observer: ResizeObserver | null = null;

  /**
   * Незанятая ось остаётся по центру, а увеличенная доходит до обоих краёв сцены.
   * Размеры берутся до transform, чтобы масштаб не умножался повторно при каждом движении.
   */
  function constrain(next: Point): void {
    const width = stage.value?.clientWidth || 0;
    const height = stage.value?.clientHeight || 0;
    const limitX = Math.max(0, ((image.value?.clientWidth || 0) * scale.value - width) / 2);
    const limitY = Math.max(0, ((image.value?.clientHeight || 0) * scale.value - height) / 2);

    offset.value = {
      x: Math.max(-limitX, Math.min(limitX, next.x)),
      y: Math.max(-limitY, Math.min(limitY, next.y)),
    };
  }

  /**
   * Координаты указателя переводятся в систему с началом в центре сцены.
   * Так место под пальцами сохраняется при увеличении вне центра картинки.
   */
  function localPoint(point: Point): Point {
    const bounds = stage.value!.getBoundingClientRect();

    return {
      x: point.x - bounds.left - bounds.width / 2,
      y: point.y - bounds.top - bounds.height / 2,
    };
  }

  /**
   * Жест хранит начальный масштаб и середину первых двух указателей.
   * Один оставшийся палец продолжает перетаскивание от текущего положения.
   */
  function beginGesture(): void {
    const [first, second = first] = [...pointers.values()];

    gesture = first ? {
      center: localPoint({ x: (first.x + second!.x) / 2, y: (first.y + second!.y) / 2 }),
      distance: Math.hypot(first.x - second!.x, first.y - second!.y),
      scale: scale.value,
      offset: { ...offset.value },
    } : null;
  }

  /**
   * Верхняя граница допускает чтение мелких деталей и настоящий размер больших файлов.
   * Минимум равен вписанному изображению, поэтому уменьшение не оставляет пустой экран.
   */
  function boundedScale(next: number): number {
    const actual = (image.value?.naturalWidth || 0) / (image.value?.clientWidth || 1);

    return Math.max(1, Math.min(Math.max(8, actual), next));
  }

  /**
   * Сброс снимает захват до замены изображения или закрытия окна.
   * Отложенные события прежнего жеста не должны сдвинуть следующую картинку.
   */
  function reset(): void {
    const captured = [...pointers.keys()];

    pointers.clear();
    gesture = null;
    moved = false;
    backgroundPress = false;
    scale.value = 1;
    offset.value = { x: 0, y: 0 };

    for (const id of captured) {
      if (stage.value?.hasPointerCapture(id)) {
        stage.value.releasePointerCapture(id);
      }
    }
  }

  /**
   * Кнопка возвращает вписанный вид из любого увеличения либо включает размер 1:1.
   * Двойное нажатие увеличивает минимум вдвое вокруг выбранного места.
   */
  function toggle(point?: Point): void {
    if (enlarged.value) {
      reset();

      return;
    }

    const actual = (image.value?.naturalWidth || 0) / (image.value?.clientWidth || 1);

    scale.value = boundedScale(point ? Math.max(2, Math.min(3, actual)) : actual);
    constrain(point ? { x: point.x * (1 - scale.value), y: point.y * (1 - scale.value) }
      : { x: 0, y: 0 });
  }

  /**
   * Сцена захватывает указатели, включая пальцы на полях рядом с картинкой.
   * Системное масштабирование запрещено touch-action только внутри этой сцены.
   */
  function pointerDown(event: PointerEvent): void {
    if (!image.value || event.button !== 0) {
      return;
    }

    if (pointers.size === 0) {
      moved = false;
      backgroundPress = event.target === stage.value;
    } else {
      moved = true;
    }

    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    stage.value?.setPointerCapture(event.pointerId);
    beginGesture();
  }

  /**
   * Pinch сохраняет точку под серединой пальцев и учитывает их совместный перенос.
   * После достижения границы масштаб ограничивается до вычисления смещения.
   */
  function pointerMove(event: PointerEvent): void {
    if (!pointers.has(event.pointerId) || !gesture) {
      return;
    }

    event.preventDefault();
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    const [first, second = first] = [...pointers.values()];
    const center = localPoint({ x: (first!.x + second!.x) / 2, y: (first!.y + second!.y) / 2 });
    const distance = Math.hypot(first!.x - second!.x, first!.y - second!.y);

    moved ||= Math.hypot(center.x - gesture.center.x, center.y - gesture.center.y) > 4;
    scale.value = boundedScale(gesture.distance ? gesture.scale * distance / gesture.distance : scale.value);

    const ratio = scale.value / gesture.scale;

    constrain({
      x: center.x - (gesture.center.x - gesture.offset.x) * ratio,
      y: center.y - (gesture.center.y - gesture.offset.y) * ratio,
    });
  }

  function pointerEnd(event: PointerEvent): void {
    if (pointers.delete(event.pointerId)) {
      beginGesture();
    }
  }

  function doubleClick(event: MouseEvent): void {
    if (image.value && !moved) {
      toggle(localPoint({ x: event.clientX, y: event.clientY }));
    }
  }

  /**
   * Колесо увеличивает картинку вокруг курсора и не прокручивает фон модального окна.
   * Видео не участвует: его собственные элементы управления сохраняют стандартный ввод.
   */
  function wheel(event: WheelEvent): void {
    if (!image.value) {
      return;
    }

    event.preventDefault();

    const point = localPoint({ x: event.clientX, y: event.clientY });
    const previous = scale.value;

    scale.value = boundedScale(previous * Math.exp(-Math.max(-100, Math.min(100, event.deltaY)) * 0.01));

    const ratio = scale.value / previous;

    constrain({
      x: point.x - (point.x - offset.value.x) * ratio,
      y: point.y - (point.y - offset.value.y) * ratio,
    });
  }

  function canClose(event: MouseEvent): boolean {
    return event.target === stage.value && backgroundPress && !enlarged.value && !moved;
  }

  watch(stage, (element) => {
    observer?.disconnect();
    observer = element ? new ResizeObserver(() => {
      constrain(offset.value);
      beginGesture();
    }) : null;
    observer?.observe(element!);
  });

  onScopeDispose(() => {
    observer?.disconnect();
    reset();
  });

  return {
    enlarged,
    style,
    reset,
    toggle,
    pointerDown,
    pointerMove,
    pointerEnd,
    doubleClick,
    wheel,
    canClose,
  };
}
