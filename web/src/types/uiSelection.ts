export type UiSelectionValue = string | number | boolean | object | null;

export type UiCheckboxModel = UiSelectionValue | UiSelectionValue[] | undefined;

export interface UiSelectionOption<T = UiSelectionValue> {
  value: T;
  label: string;
  disabled?: boolean;
  description?: string;
  badge?: string | number;
}

export type UiTabsActivation = 'automatic' | 'manual';
export type UiChoiceMode = 'single' | 'multiple';
