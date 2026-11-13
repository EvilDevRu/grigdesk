import { inject, provide, type InjectionKey } from 'vue';
import type { UiTabsActivation } from '../types/uiSelection';
import { t } from '../services/locale.ts';

export interface UiTabRegistration {
  value: string | number;
  element: HTMLElement | null;
  disabled: boolean;
}

export interface UiTabsContext {
  modelValue(): string | number | null;
  activation(): UiTabsActivation;
  select(value: string | number): void;
  register(token: symbol, tab: UiTabRegistration): void;
  update(token: symbol, tab: UiTabRegistration): void;
  unregister(token: symbol): void;
}

const UI_TABS_CONTEXT: InjectionKey<UiTabsContext> = Symbol('ui-tabs-context');

export function provideUiTabsContext(context: UiTabsContext): void {
  provide(UI_TABS_CONTEXT, context);
}

/**
 * Контекст вкладок читается только внутри UiTabs: без провайдера
 * вкладка не может ни активироваться, ни зарегистрироваться.
 */
export function useUiTabsContext(): UiTabsContext {
  const context = inject(UI_TABS_CONTEXT, null);

  if (!context) {
    throw new Error(t('core.coreUitabDolzhenNahoditsyaVnutri'));
  }

  return context;
}
