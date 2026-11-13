import { api, failureText } from '../../shared/apiClient.ts';
import { useUsageForecastStore } from '../../stores/usageForecast.ts';
import { parseUsageForecastSnapshot } from '../../../../shared/chat/usageForecastContracts.ts';
import { localeTranslator } from '../../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from '../../shared/uiLocalePort.ts';

const translateUi = localeTranslator(uiLocalePort);


/**
 * Свежий снимок прогноза. Проверка формы не формальность: по вердикту человек решает,
 * оставлять ли субагентов на ночь, и непонятный ответ должен стать отказом, а не
 * молчаливым «хватит».
 */
export async function loadUsageForecast(): Promise<void> {
  const store = useUsageForecastStore();

  try {
    const value: unknown = await api.get('/api/usage-forecast');

    store.setSnapshot(parseUsageForecastSnapshot(value));
  } catch (error) {
    store.setError(failureText(error, translateUi('core.loadUsageForecastCouldNotLoadTheUsageForecast')));
  }
}

/**
 * Снимок, который сервер прислал сам по SSE: та же проверка, что и у запроса, — тело
 * события недоверенное. Кривое событие не портит уже показанный снимок.
 */
export function applyUsageForecast(payload: unknown): void {
  const store = useUsageForecastStore();

  try {
    store.setSnapshot(parseUsageForecastSnapshot(payload));
  } catch (error) {
    store.setError(
      failureText(error, translateUi('core.loadUsageForecastTheUsageForecastHasAnUnexpectedFormat')),
    );
  }
}
