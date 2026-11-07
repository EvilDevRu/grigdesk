import type { UiText } from '../../../shared/i18n/core.ts';

import type { Component, ComponentPublicInstance, Ref, VNode } from 'vue';
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
// media — просмотр картинки или видео во весь экран: без поверхности окна, с глубоким затемнением.
export type UiDialogSize = 'compact' | 'content' | 'workspace' | 'media';
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

export type UiDialogIconName = 'ask' | 'alert' | 'trash' | 'download';

export interface ConfirmDialogOptions {
  title?: UiText;
  // Строка под заголовком: что произойдёт после согласия.
  subtitle?: UiText;
  // Значок слева от заголовка: имя из набора kit или компонент потребителя, например знак исполнителя.
  icon?: UiDialogIconName | Component;
  // Цвет значка-компонента, например фирменный цвет исполнителя из реестра.
  iconColor?: string;
  // Команда или путь показываются моноширинным блоком как данные, без перевода.
  code?: string;
  // Длинные технические данные доступны только после явного раскрытия.
  details?: { label: UiText; text: string };
  okText?: UiText;
  cancelText?: UiText;
  danger?: boolean;
  touchTargets?: boolean;
  action?: DialogAction<true>;
}

export interface PromptDialogOptions {
  multiline?: boolean;
  title?: UiText;
  text?: UiText;
  placeholder?: UiText;
  okText?: UiText;
  cancelText?: UiText;
  value?: string;
  danger?: boolean;
  action?: DialogAction<string>;
}

export interface AlertDialogOptions {
  title?: UiText;
  okText?: UiText;
  danger?: boolean;
  action?: DialogAction<void>;
}

export interface ConfirmDialogRequest {
  readonly id: number;
  readonly kind: 'confirm';
  readonly text: UiText;
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
  readonly text: UiText;
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
