import type { UiOverlayPlacement } from '../types/uiOverlays.ts';

export interface OverlayRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface OverlayPlacementInput {
  trigger: OverlayRect;
  surface: {
    width: number;
    height: number;
  };
  viewport: {
    width: number;
    height: number;
  };
  placement: UiOverlayPlacement;
  offset: number;
  edge?: number;
}

export interface OverlayPlacementResult {
  placement: UiOverlayPlacement;
  left: number;
  top: number;
  anchorX: number;
  anchorY: number;
}

function axisPlacement(
  placement: UiOverlayPlacement,
): 'top' | 'right' | 'bottom' | 'left' {
  return placement.split('-')[0] as 'top' | 'right' | 'bottom' | 'left';
}

/**
 * Start/end выравнивают tooltip по поперечной оси trigger-а.
 * Placement без суффикса получает симметричное центрирование.
 */
function alignedCoordinate(
  start: number,
  triggerSize: number,
  surfaceSize: number,
  placement: UiOverlayPlacement,
): number {
  if (placement.endsWith('-start')) {
    return start;
  }
  if (placement.endsWith('-end')) {
    return start + triggerSize - surfaceSize;
  }

  return start + (triggerSize - surfaceSize) / 2;
}

/**
 * Противоположная сторона сохраняет исходный start/end-суффикс.
 * Благодаря этому flip не меняет ожидаемое поперечное выравнивание.
 */
function flippedPlacement(placement: UiOverlayPlacement): UiOverlayPlacement {
  if (placement.startsWith('top')) {
    return placement.replace('top', 'bottom') as UiOverlayPlacement;
  }
  if (placement.startsWith('bottom')) {
    return placement.replace('bottom', 'top') as UiOverlayPlacement;
  }
  if (placement.startsWith('left')) {
    return placement.replace('left', 'right') as UiOverlayPlacement;
  }

  return placement.replace('right', 'left') as UiOverlayPlacement;
}

/**
 * Расчёт не обращается к DOM, поэтому одинаково применяется к обоим видам подсказок.
 * Результат содержит округлённые координаты поверхности и её якоря.
 */
export function computeOverlayPlacement(input: OverlayPlacementInput): OverlayPlacementResult {
  const triggerRect = input.trigger;
  const width = input.surface.width;
  const height = input.surface.height;
  const edge = input.edge ?? 8;
  const gap = Math.max(0, input.offset);
  let placement = input.placement;
  let axis = axisPlacement(placement);

  const room = {
    top: triggerRect.top - edge,
    right: input.viewport.width - triggerRect.right - edge,
    bottom: input.viewport.height - triggerRect.bottom - edge,
    left: triggerRect.left - edge,
  };
  const needed =
    axis === 'top' || axis === 'bottom' ? height + gap : width + gap;
  const opposite =
    axis === 'top'
      ? 'bottom'
      : axis === 'bottom'
        ? 'top'
        : axis === 'left'
          ? 'right'
          : 'left';

  if (room[axis] < needed && room[opposite] > room[axis]) {
    placement = flippedPlacement(placement);
    axis = axisPlacement(placement);
  }

  let left = alignedCoordinate(
    triggerRect.left,
    triggerRect.width,
    width,
    placement,
  );
  let top = alignedCoordinate(
    triggerRect.top,
    triggerRect.height,
    height,
    placement,
  );

  if (axis === 'top') {
    top = triggerRect.top - height - gap;
  } else if (axis === 'bottom') {
    top = triggerRect.bottom + gap;
  } else if (axis === 'left') {
    left = triggerRect.left - width - gap;
  } else {
    left = triggerRect.right + gap;
  }

  left = Math.min(
    Math.max(left, edge),
    Math.max(edge, input.viewport.width - width - edge),
  );
  top = Math.min(
    Math.max(top, edge),
    Math.max(edge, input.viewport.height - height - edge),
  );

  return {
    placement,
    left: Math.round(left),
    top: Math.round(top),
    anchorX: Math.round(triggerRect.left + triggerRect.width / 2 - left),
    anchorY: Math.round(triggerRect.top + triggerRect.height / 2 - top),
  };
}
