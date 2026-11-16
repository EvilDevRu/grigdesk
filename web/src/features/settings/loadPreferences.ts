import { watch } from 'vue';
import { isRecord } from '../../../../shared/lib/objects.ts';
import type { JsonValue } from './contracts.ts';
import { useSettingsStore } from '../../stores/settings.ts';
import { useProvidersStore } from '../../stores/providers.ts';
import { useChatStore } from '../../stores/chat.ts';
import { api, failureText } from '../../shared/apiClient.ts';
import { uiLocale } from '../../ui.ts';
import { SETTINGS_FIELDS } from './catalog.ts';
import { createPreferencesAdapter } from './resources/preferences.ts';

/**
 * Страницы используют один prefs-адаптер с общим порядком HTTP/SSE политики.
 * Открытая форма получает внешний снимок без перезаписи неприменённых намерений.
 */
export async function loadPreferences(): Promise<void> {
  const settings = useSettingsStore();
  const providers = useProvidersStore();
  const chat = useChatStore();
  const opening = settings.snapshot.sessionId;

  /**
   * Поздний prefs ACK не отменяет более новую ревизию из другого окна.
   * В результат формы возвращается тот же принятый режим, чтобы ACK не откатил baseline.
   */
  function projectPolicy(values: Record<string, JsonValue>, payload: unknown) {
    if (typeof values.providerUsageAutoRefresh !== 'boolean' || !isRecord(payload)) {
      return values;
    }

    providers.applyUsagePolicy(values.providerUsageAutoRefresh, payload.providerUsagePolicyRevision);

    return {
      ...values,
      providerUsageAutoRefresh: providers.usageAutoRefresh ?? values.providerUsageAutoRefresh,
    };
  }

  const adapter = createPreferencesAdapter(api, (values) => {
    if (typeof values.chatAutoCompactWindow === 'number') {
      chat.compactWindow = values.chatAutoCompactWindow;
    }

    if (typeof values.showAllModels === 'boolean') {
      providers.showAllModels = values.showAllModels;
    }
  }, uiLocale, projectPolicy);

  settings.registerResource(adapter, SETTINGS_FIELDS.filter((field) => field.resourceId === 'prefs'));

  if (settings.resourceDetails.prefsPolicy?.error) {
    settings.acceptSnapshot('prefs', await adapter.read(new AbortController().signal), opening);
    settings.resourceDetails = { ...settings.resourceDetails, prefsPolicy: { error: '' } };
  }

  await settings.loadResource('prefs');

  if (!settings.isOpen || settings.snapshot.sessionId !== opening) {
    return;
  }

  settings.bindSession('prefs:usage-policy', () => {
    const controller = new AbortController();
    let request = 0;
    const stop = watch(() => providers.usagePolicyRevision, () => {
      const selected = ++request;

      void adapter.read(controller.signal).then((values) => {
        if (selected === request && !controller.signal.aborted) {
          settings.acceptSnapshot('prefs', values, opening);
          settings.resourceDetails = { ...settings.resourceDetails, prefsPolicy: { error: '' } };
        }
      }).catch((cause) => {
        if (!controller.signal.aborted && selected === request) {
          settings.resourceDetails = {
            ...settings.resourceDetails, prefsPolicy: { error: failureText(cause) },
          };
        }
      });
    }, { flush: 'sync' });

    return () => {
      request += 1;
      stop();
      controller.abort();
    };
  });
}
