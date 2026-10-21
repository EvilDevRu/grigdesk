import { recordOrNull } from '../../shared/lib/objects.ts';

export interface SurfaceBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface SurfaceGeometry extends SurfaceBounds {
  maximized: boolean;
}
/**
 * Локальные настройки могут быть повреждены; такое значение не достигает Electron.
 * Проверка не меняет старые настройки главного окна и не допускает нулевых размеров.
 */
export function normalizeSurfaceGeometry(value: unknown): SurfaceGeometry | null {
  const item = recordOrNull(value);

  if (!item || !['x', 'y', 'width', 'height'].every((key) =>
    typeof item[key] === 'number' && Number.isFinite(item[key]))) {
    return null;
  }

  const x = Number(item.x);
  const y = Number(item.y);
  const width = Number(item.width);
  const height = Number(item.height);

  if (Math.abs(x) > 100000 || Math.abs(y) > 100000 || width < 1 || height < 1
    || width > 10000 || height > 10000 || typeof item.maximized !== 'boolean') {
    return null;
  }

  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
    maximized: item.maximized,
  };
}
/**
 * Выбирается рабочая область с наибольшим пересечением, иначе первая доступная.
 * Окно уменьшается и сдвигается целиком внутрь области после отключения монитора.
 */
export function fitSurfaceBounds(saved: SurfaceBounds, areas: readonly SurfaceBounds[]): SurfaceBounds {
  const fallback = areas[0];

  if (!fallback) {
    throw new Error('Не найдена рабочая область дисплея.');
  }

  let chosen = fallback;
  let largest = 0;

  for (const area of areas) {
    const width = Math.max(0, Math.min(saved.x + saved.width, area.x + area.width)
      - Math.max(saved.x, area.x));
    const height = Math.max(0, Math.min(saved.y + saved.height, area.y + area.height)
      - Math.max(saved.y, area.y));
    const overlap = width * height;

    if (overlap > largest) {
      largest = overlap;
      chosen = area;
    }
  }

  const width = Math.min(Math.max(600, saved.width), chosen.width);
  const height = Math.min(Math.max(600, saved.height), chosen.height);

  return {
    x: Math.max(chosen.x, Math.min(saved.x, chosen.x + chosen.width - width)),
    y: Math.max(chosen.y, Math.min(saved.y, chosen.y + chosen.height - height)),
    width,
    height,
  };
}

const CASCADE_STEP = 32;
const CASCADE_SIZE = 8;

/**
 * Окна карточек открываются лесенкой и не ложатся точно друг на друга.
 * После восьми окон лесенка начинается заново; вписывание в экран делает fitSurfaceBounds.
 */
export function cascadeSurfaceBounds(saved: SurfaceGeometry, index: number): SurfaceGeometry {
  const offset = CASCADE_STEP * (Math.max(0, Math.trunc(index)) % CASCADE_SIZE);

  return {
    ...saved,
    x: saved.x + offset,
    y: saved.y + offset,
  };
}

/**
 * Сравнение учитывает и положение, и полное перекрытие предыдущего окна новым.
 * Вписывание у края не должно превращать каскад в тот же прямоугольник.
 */
function leavesPreviousVisible(next: SurfaceBounds, previous: SurfaceBounds): boolean {
  const shifted = next.x !== previous.x || next.y !== previous.y;
  const contains = next.x <= previous.x && next.y <= previous.y
    && next.x + next.width >= previous.x + previous.width
    && next.y + next.height >= previous.y + previous.height;

  return shifted && !contains;
}

/**
 * Каскад проверяется после вписывания, включая край монитора и развёрнутое окно.
 * Если все сдвиги схлопнулись, уменьшаем следующее окно внутри доступной области.
 */
export function placeSurfaceBounds(
  saved: SurfaceGeometry,
  index: number,
  areas: readonly SurfaceBounds[],
  previous?: SurfaceBounds | null,
  occupied: readonly SurfaceBounds[] = [],
): SurfaceBounds {
  const candidate = fitSurfaceBounds(cascadeSurfaceBounds(saved, index), areas);
  const available = (bounds: SurfaceBounds) => (!previous || leavesPreviousVisible(bounds, previous))
    && occupied.every((other) => bounds.x !== other.x || bounds.y !== other.y);

  if (available(candidate) || !previous) {
    return candidate;
  }

  // У края сдвиг назад может совпасть с более ранней карточкой, а не с предыдущей.
  // Проверяем занятые позиции и увеличиваем шаг, пока в лесенке есть свободное место.
  for (let step = 1; step <= occupied.length + 1; step += 1) {
    for (const [dx, dy] of [[32, 32], [-32, -32], [32, -32], [-32, 32]] as const) {
      const shifted = fitSurfaceBounds({
        ...saved,
        x: previous.x + dx * step,
        y: previous.y + dy * step,
      }, areas);

      if (available(shifted)) {
        return shifted;
      }
    }
  }

  const fitted = fitSurfaceBounds(previous, areas);
  const area = areas.find((value) => fitted.x >= value.x && fitted.y >= value.y
    && fitted.x + fitted.width <= value.x + value.width
    && fitted.y + fitted.height <= value.y + value.height) ?? areas[0];

  if (!area) {
    throw new Error('Не найдена рабочая область дисплея.');
  }

  const x = Math.min(Math.max(area.x, previous.x + CASCADE_STEP), area.x + area.width - 1);
  const y = Math.min(Math.max(area.y, previous.y + CASCADE_STEP), area.y + area.height - 1);

  return {
    x,
    y,
    width: Math.min(candidate.width, area.x + area.width - x),
    height: Math.min(candidate.height, area.y + area.height - y),
  };
}
