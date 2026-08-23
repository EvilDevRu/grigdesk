import type { UiLayerName, UiLayerRootProps } from '../../types/uiLayers';

/**
 * Единственная карта уровней. Consumers выбирают смысл слоя, а не z-index.
 */
export const UI_LAYER_PRIORITIES = Object.freeze({
  tools: 70,
  dock: 80,
  companion: 95,
  dialog: 100,
  'diff-workspace': 120,
  document: 180,
  banner: 200,
  tooltip: 300,
  popover: 300,
  confirm: 400,
} satisfies Record<UiLayerName, number>);

const UI_LAYER_NAMES = new Set<UiLayerName>(Object.keys(UI_LAYER_PRIORITIES) as UiLayerName[]);

export function isUiLayerName(value: unknown): value is UiLayerName {
  return typeof value === 'string' && UI_LAYER_NAMES.has(value as UiLayerName);
}

export function normalizeUiLayerName(value: unknown, fallback: UiLayerName = 'dialog'): UiLayerName {
  return isUiLayerName(value) ? value : fallback;
}

export function uiLayerPriority(name: UiLayerName): number {
  return UI_LAYER_PRIORITIES[name];
}

export function uiLayerProps(name: UiLayerName): UiLayerRootProps {
  return {
    'data-ui-layer': name,
    style: { '--ui-layer-z': String(uiLayerPriority(name)) },
  };
}
