export type UiTextInputType =
  | 'text'
  | 'email'
  | 'password'
  | 'search'
  | 'tel'
  | 'url'
  | 'date'
  | 'time'
  | 'datetime-local'
  | 'month'
  | 'week';

export type UiTextValue = string | number | null;
export type UiNumberValue = number | null | '';
export type UiSelectValue = string | number | null;

export interface UiModelModifiers {
  trim?: boolean;
  number?: boolean;
  lazy?: boolean;
}

export interface UiFieldHandle<T extends HTMLElement> {
  readonly el: T | null;
  focus(options?: FocusOptions): void;
  select?(): void;
}

export interface UiFileInputHandle {
  readonly el: HTMLInputElement | null;
  focus(options?: FocusOptions): void;
  open(): void;
  reset(): void;
}

export interface UiSettingOption {
  value: string | number;
  label: string;
  disabled?: boolean;
}

export type UiSettingDescriptor =
  | { type: 'toggle'; label: string; description?: string }
  | { type: 'text'; label: string; description?: string; placeholder?: string }
  | { type: 'number'; label: string; description?: string; min?: number; max?: number; step?: number }
  | { type: 'select'; label: string; description?: string; options: UiSettingOption[] }
  | { type: 'button'; label: string; description?: string; tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger' }
  | { type: 'link'; label: string; description?: string; href: string; external?: boolean };
