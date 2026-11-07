import { ref, watch } from 'vue';
import { locales } from '../../../shared/i18n/catalogs.ts';
import { resolveLocale } from '../../../shared/i18n/core.ts';
import { setUiLocale, t, uiLocale } from '../ui.ts';
import type { useShellStore } from '../stores/shell.ts';
import type { ShellState } from '../../../shared/client/clientShell.ts';
import { connectUiLocalePort } from './uiLocalePort.ts';
import { setAlertsLocale } from './alerts.ts';
import { shellAction } from './shellClient.ts';

export const UI_LANGUAGE_KEY = 'grigdesk-ui-language';
export const uiLanguage = ref('system');
export const uiLanguageBusy = ref(false);
export const uiLanguageError = ref('');
let targetWindow: Window | undefined;
let targetShell: ReturnType<typeof useShellStore> | undefined;
let systemLanguage = '';

function validPreference(value: unknown): value is string {
  return value === 'system' || locales.some((item) => item.id === value);
}

function display(): void {
  const locale = resolveLocale(uiLanguage.value, systemLanguage, locales);

  setUiLocale(locale);

  if (targetWindow) {
    targetWindow.document.documentElement.lang = locale;
  }
}

/**
 * Подключение явно вызывается до первого mount и не создаёт собственного опроса.
 * Старые оболочки без locale используют системный язык и storage браузера.
 */
export function bootstrapUiLocale(options: {
  window: Window;
  shell?: ReturnType<typeof useShellStore>;
}): () => void {
  targetWindow = options.window;
  setAlertsLocale(uiLocale);
  connectUiLocalePort(uiLocale);
  targetShell = options.shell;
  systemLanguage = options.window.navigator.language;
  uiLanguage.value = 'system';
  uiLanguageBusy.value = false;
  uiLanguageError.value = '';

  try {
    const stored = options.window.localStorage.getItem(UI_LANGUAGE_KEY);

    uiLanguage.value = validPreference(stored) ? stored : 'system';
  } catch {
    // Запрещённое хранилище не мешает первому показу приложения.
  }

  const apply = (snapshot: ShellState | null | undefined) => {
    if (snapshot?.locale && !uiLanguageBusy.value) {
      uiLanguage.value = snapshot.locale.preference;
      systemLanguage = snapshot.locale.systemLanguage;
      display();
    }
  };

  apply(options.shell?.snapshot);
  display();

  const stop = options.shell
    ? watch(() => options.shell?.snapshot, apply, { flush: 'sync' }) : () => {};
  /**
   * Событие другого окна меняет только предпочтение браузера и не пишет его обратно.
   * Локаль оболочки и незавершённая собственная запись имеют приоритет над storage.
   */
  const storage = (event: StorageEvent) => {
    if (event.key === UI_LANGUAGE_KEY && !targetShell?.snapshot?.locale && !uiLanguageBusy.value) {
      uiLanguage.value = validPreference(event.newValue) ? event.newValue : 'system';
      display();
    }
  };

  options.window.addEventListener('storage', storage);

  return () => {
    stop();
    setAlertsLocale(null);
    connectUiLocalePort();
    options.window.removeEventListener('storage', storage);
  };
}

/**
 * Язык сохраняется немедленно и не входит в черновик общих настроек.
 * На время записи старый poll не откатывает выбор; отказ возвращает принятый язык.
 */
export async function setUiLanguage(preference: string): Promise<void> {
  if (uiLanguageBusy.value || !validPreference(preference)) {
    return;
  }

  const previous = uiLanguage.value;

  uiLanguageBusy.value = true;
  uiLanguageError.value = '';
  uiLanguage.value = preference;
  display();

  try {
    if (targetShell?.snapshot?.locale) {
      const snapshot = await shellAction('POST', '/locale', { preference }) as ShellState;

      targetShell.apply(snapshot);
      uiLanguage.value = snapshot.locale?.preference ?? preference;
      systemLanguage = snapshot.locale?.systemLanguage ?? systemLanguage;
    } else {
      targetWindow?.localStorage.setItem(UI_LANGUAGE_KEY, preference);
    }
  } catch (cause) {
    uiLanguage.value = previous;
    uiLanguageError.value = cause instanceof Error ? cause.message : t('core.saveFailure');
  } finally {
    uiLanguageBusy.value = false;
    display();
  }
}
