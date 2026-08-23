import type { CSSProperties } from 'vue';

/**
 * Семантические уровни Cockpit. Числа остаются внутренней деталью runtime и CSS.
 */
export type UiLayerName =
  | 'tools'
  | 'dock'
  | 'companion'
  | 'dialog'
  | 'diff-workspace'
  | 'document'
  | 'banner'
  | 'tooltip'
  | 'popover'
  | 'confirm';

export type UiLayerCloseHandler = (event: KeyboardEvent) => boolean | void;

export interface UiLayerRegistrationOptions {
  name: UiLayerName;
  close: UiLayerCloseHandler;
  enabled?: () => boolean;
  element?: () => HTMLElement | null;
}

export interface UiLayerStyle extends CSSProperties {
  '--ui-layer-z': string;
}

export interface UiLayerRootProps {
  'data-ui-layer': UiLayerName;
  style: UiLayerStyle;
}

export interface UiLayerHandle {
  readonly token: symbol;
  readonly id: string;
  readonly name: UiLayerName;
  readonly priority: number;
  isTop(): boolean;
  refresh(): void;
  unregister(): void;
}
