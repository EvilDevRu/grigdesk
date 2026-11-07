import type { Directive } from 'vue';

interface PixelSnapBinding {
  schedule: () => void;
  stop: () => void;
}

const bindings = new WeakMap<HTMLElement, PixelSnapBinding>();
const offsets = new WeakMap<SVGSVGElement, number>();

/**
 * Привязывает левую границу видимого SVG к физическим пикселям без изменения масштаба.
 * Вертикальную ось сохраняет flex-строка: округление верхних границ разводит знаки разной высоты.
 * Прежний горизонтальный сдвиг исключается из расчёта, чтобы повторные замеры не давали дрожания.
 */
function alignSvgLeftEdges(root: HTMLElement): void {
  const density = window.devicePixelRatio || 1;
  const corrections = [];

  for (const svg of root.querySelectorAll<SVGSVGElement>('svg')) {
    const matrix = svg.getScreenCTM();

    if (!matrix || !svg.isConnected) {
      continue;
    }

    const box = svg.getBBox();
    const stroke = Number(svg.getAttribute('stroke-width') || 0) / 2;
    const previous = offsets.get(svg) ?? 0;
    const left = (box.x - stroke) * matrix.a + matrix.e - previous;
    const x = Math.round(left * density) / density - left;

    if (Math.abs(x - previous) < 0.001) {
      continue;
    }

    corrections.push({
      svg,
      x,
    });
  }

  for (const { svg, x } of corrections) {
    offsets.set(svg, x);

    svg.style.transform = `translateX(${x}px)`;
  }
}

/**
 * Один наблюдатель обслуживает весь ряд: новые знаки и изменения раскладки пересчитываются вместе.
 * Отрисовка объединяется в кадр; смена плотности дисплея обновляет привязку без изменения размеров.
 */
function mountPixelSnap(root: HTMLElement): void {
  let frame = 0;
  let densityQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);

  const schedule = () => {
    if (frame) {
      return;
    }

    frame = window.requestAnimationFrame(() => {
      frame = 0;
      alignSvgLeftEdges(root);
    });
  };

  // Запрос разрешения перестаёт совпадать после смены плотности экрана.
  // Заменяем его запросом для новой плотности, чтобы отследить и следующее переключение.
  const densityChanged = () => {
    densityQuery.removeEventListener('change', densityChanged);
    densityQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    densityQuery.addEventListener('change', densityChanged);
    schedule();
  };

  const observer = new ResizeObserver(schedule);

  observer.observe(root);

  if (root.parentElement) {
    observer.observe(root.parentElement);
  }

  window.addEventListener('resize', schedule);
  densityQuery.addEventListener('change', densityChanged);
  bindings.set(root, {
    schedule,
    stop: () => {
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      densityQuery.removeEventListener('change', densityChanged);
      window.cancelAnimationFrame(frame);
    },
  });

  schedule();
}

/**
 * Директива предназначена для ряда логотипов, чьи SVG не задают собственный transform.
 * Обновление Vue подхватывает добавление знаков; удаление ряда освобождает наблюдатель и события.
 */
export const vSvgPixelSnap: Directive<HTMLElement> = {
  mounted: mountPixelSnap,
  updated: (root) => bindings.get(root)?.schedule(),
  unmounted: (root) => {
    bindings.get(root)?.stop();
    bindings.delete(root);
  },
};
