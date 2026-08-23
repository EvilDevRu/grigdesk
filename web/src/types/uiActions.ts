export const UI_ACTION_VARIANTS = ['solid', 'outline', 'ghost', 'text'] as const;
export const UI_ACTION_TONES = ['neutral', 'accent', 'success', 'warning', 'danger'] as const;

export type UiActionVariant = (typeof UI_ACTION_VARIANTS)[number];
export type UiActionTone = (typeof UI_ACTION_TONES)[number];
export type UiButtonType = 'button' | 'submit' | 'reset';
export type UiIconRole = 'peer' | 'embedded' | 'rail' | 'stepper';
export type UiSpinnerRole = 'inline' | 'standalone' | 'large';

export interface UiActionHandle<T extends HTMLElement = HTMLElement> {
  readonly el: T | null;
  focus(options?: FocusOptions): void;
  click(): void;
}

export function normalizeActionVariant(value: unknown): UiActionVariant {
  return UI_ACTION_VARIANTS.includes(value as UiActionVariant)
    ? value as UiActionVariant
    : 'outline';
}

export function normalizeActionTone(value: unknown): UiActionTone {
  return UI_ACTION_TONES.includes(value as UiActionTone)
    ? value as UiActionTone
    : 'neutral';
}
