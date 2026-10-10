import type { ComponentPublicInstance, Ref, VNode } from 'vue';
import type { UiLayerName } from './uiLayers';

export type UiOverlayPlacement =
  | 'top'
  | 'top-start'
  | 'top-end'
  | 'right'
  | 'right-start'
  | 'right-end'
  | 'bottom'
  | 'bottom-start'
  | 'bottom-end'
  | 'left'
  | 'left-start'
  | 'left-end';

export type UiOverlayAlign = 'start' | 'center' | 'end';
export type UiPopoverHasPopup = 'dialog' | 'menu' | 'listbox';
export type UiPopoverFocusPolicy = 'auto' | 'surface' | 'none';
export type UiPopoverTriggerMode = 'click' | 'hover' | 'both';
export type UiPopoverCloseReason = 'escape' | 'outside' | 'trigger' | 'action' | 'programmatic';

export type UiDialogCloseReason = 'escape' | 'backdrop' | 'action' | 'programmatic';
export type UiDialogSize = 'compact' | 'content' | 'workspace';
export type UiDialogRole = 'dialog' | 'alertdialog';

export interface UiFocusableHandle {
  focus(options?: FocusOptions): void;
  element?: HTMLElement | null;
}

export type UiFocusTarget =
  | HTMLElement
  | ComponentPublicInstance
  | UiFocusableHandle
  | Ref<UiFocusTarget | null>
  | string
  | null;

export type UiInitialFocus = UiFocusTarget | (() => UiFocusTarget);

export interface UiOverlayTriggerSlotProps {
  open: boolean;
  toggle(): void;
  close(): void;
}

export interface UiOverlayContentSlotProps extends UiOverlayTriggerSlotProps {
  close(reason?: UiPopoverCloseReason): void;
}

export interface UiTooltipSlots {
  trigger?(props: UiOverlayTriggerSlotProps): VNode[];
  default?(props: UiOverlayTriggerSlotProps): VNode[];
  tip?(): VNode[];
  content?(): VNode[];
}

export interface UiPopoverSlots {
  trigger(props: UiOverlayTriggerSlotProps): VNode[];
  default(props: UiOverlayContentSlotProps): VNode[];
}

export type DialogAction<Value> = (value: Value) => void | Promise<void>;

export interface ConfirmDialogOptions {
  title?: string;
  okText?: string;
  cancelText?: string;
  danger?: boolean;
  touchTargets?: boolean;
  action?: DialogAction<true>;
}

export interface PromptDialogOptions {
  title?: string;
  text?: string;
  placeholder?: string;
  okText?: string;
  cancelText?: string;
  value?: string;
  danger?: boolean;
  action?: DialogAction<string>;
}

export interface AlertDialogOptions {
  title?: string;
  okText?: string;
  danger?: boolean;
  action?: DialogAction<void>;
}

export interface ConfirmDialogRequest {
  readonly id: number;
  readonly kind: 'confirm';
  readonly text: string;
  readonly options: Readonly<ConfirmDialogOptions>;
}

export interface PromptDialogRequest {
  readonly id: number;
  readonly kind: 'prompt';
  readonly options: Readonly<PromptDialogOptions>;
}

export interface AlertDialogRequest {
  readonly id: number;
  readonly kind: 'alert';
  readonly text: string;
  readonly options: Readonly<AlertDialogOptions>;
}

export type DialogHostRequest = ConfirmDialogRequest | PromptDialogRequest | AlertDialogRequest;
export type DialogResult = boolean | string | null | undefined;

export interface UiDialogPublicProps {
  open: boolean;
  role?: UiDialogRole;
  layer?: UiLayerName;
  size?: UiDialogSize;
  title?: string;
  description?: string;
  label?: string;
  dismissible?: boolean;
  persistent?: boolean;
  busy?: boolean;
  initialFocus?: UiInitialFocus;
  mobileFullscreen?: boolean;
  fadeOnly?: boolean;
}
