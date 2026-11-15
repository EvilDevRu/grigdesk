import type { RouteGraphDef } from '../../../../shared/pipeline/routeGraphView.ts';
import { nodeGeom } from '../../shared/graphGeom.ts';
import type { NodeCanvasPoint } from './routeCommands.ts';

export interface CanvasTransform {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

/**
 * JSON-документ редактора и каталог ролей могут быть Vue proxy.
 * Команды получают plain snapshot, который безопасно копируется structuredClone.
 */
export function plainRouteValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Фиксирует обратную screen CTM один раз на жест, не сохраняя DOMMatrix в реактивном state.
 * Fallback учитывает preserveAspectRatio xMidYMid meet; без layout используется identity.
 */
export function captureCanvasTransform(svg: SVGSVGElement | null): CanvasTransform {
  try {
    const inverse = svg?.getScreenCTM?.()?.inverse();

    if (inverse) {
      const result = {
        a: inverse.a,
        b: inverse.b,
        c: inverse.c,
        d: inverse.d,
        e: inverse.e,
        f: inverse.f,
      };

      if (Object.values(result).every(Number.isFinite)) {
        return result;
      }
    }
  } catch {
    // Невырожденная раскладка ниже остаётся доступна при отсутствии SVG CTM.
  }

  const rect = svg?.getBoundingClientRect();
  const box = (svg?.getAttribute('viewBox') ?? '').trim().split(/\s+/).map(Number);
  const [x, y, width, height] = box;

  if (rect && rect.width > 0 && rect.height > 0 && box.length === 4
    && box.every(Number.isFinite) && width! > 0 && height! > 0) {
    const scale = Math.min(rect.width / width!, rect.height / height!);
    const padX = (rect.width - width! * scale) / 2;
    const padY = (rect.height - height! * scale) / 2;

    return {
      a: 1 / scale,
      b: 0,
      c: 0,
      d: 1 / scale,
      e: x! - (rect.left + padX) / scale,
      f: y! - (rect.top + padY) / scale,
    };
  }

  return {
    a: 1,
    b: 0,
    c: 0,
    d: 1,
    e: 0,
    f: 0
  };
}

/**
 * Преобразует экранную точку через зафиксированную affine-матрицу.
 * Функция общая для клика, перемещения и выбора цели исхода.
 */
export function canvasPoint(
  event: Pick<MouseEvent, 'clientX' | 'clientY'>,
  matrix: CanvasTransform,
): NodeCanvasPoint {
  return {
    x: matrix.a * event.clientX + matrix.c * event.clientY + matrix.e,
    y: matrix.b * event.clientX + matrix.d * event.clientY + matrix.f,
  };
}

/**
 * Находит цель внутри той же прямоугольной hit-area, которую рисует FactoryGraph.
 * Пустое пространство рядом с узлом не считается попаданием; source исключён явно.
 */
export function canvasNodeAt(
  graph: RouteGraphDef,
  point: NodeCanvasPoint,
  sourceId: string,
): string | null {
  let best: { id: string; distance: number } | null = null;

  for (const [displayId, origin] of Object.entries(graph.nodeOrigins)) {
    if (!origin.executable || !origin.originId || origin.originId === sourceId
      || !graph.pos[displayId] || !graph.nodes[displayId]) {
      continue;
    }

    const shape = nodeGeom(displayId, graph.pos, graph.nodes);

    if (point.x < shape.cx - shape.hw || point.x > shape.cx + shape.hw
      || point.y < shape.top - 4 || point.y > shape.bottom) {
      continue;
    }

    const distance = Math.hypot(point.x - shape.cx, point.y - shape.cy);

    if (!best || distance < best.distance
      || (distance === best.distance && origin.originId < best.id)) {
      best = { id: origin.originId, distance };
    }
  }

  return best?.id ?? null;
}

/**
 * Выбирает ближайший геометрически центр строго слева от точки на показанной схеме.
 * Все manual/auto точки уже сведены построителем; недоступное место не подменяется другим.
 */
export function leftCanvasNeighbour(graph: RouteGraphDef, point: NodeCanvasPoint): string | null {
  let best: { id: string; distance: number } | null = null;

  for (const [displayId, origin] of Object.entries(graph.nodeOrigins)) {
    const position = graph.pos[displayId];

    if (!origin.executable || !origin.originId || !position || position[0] >= point.x) {
      continue;
    }

    const distance = Math.hypot(point.x - position[0], point.y - position[1]);

    if (!best || distance < best.distance
      || (distance === best.distance && origin.originId < best.id)) {
      best = { id: origin.originId, distance };
    }
  }

  return best?.id ?? null;
}
