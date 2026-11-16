
import { localeTranslator } from '../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from './uiLocalePort.ts';

const translateUi = localeTranslator(uiLocalePort);

interface ModelRun {
  role?: string;
  actualModel?: unknown;
  model?: unknown;
}

/**
 * Последний завершённый ответ, для которого известно хотя бы то, какую модель
 * запросили. Не пропускаем GPT-ходы без `actualModel`: иначе шапка откатывается
 * к старому Claude-ответу и выдаёт его за текущий факт.
 */
export function lastModelRun<T extends ModelRun>(messages: T[] = []): T | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];

    if (message?.role === 'assistant' && (message.actualModel || message.model)) {
      return message;
    }
  }

  return null;
}

/**
 * `actualModel` — модель, которую явно сообщил поток CLI.
 * `model` — модель, переданная исполнителю. Если факта нет, показываем запрос
 * с честной подписью, а не подставляем его в поле «факт».
 */
export function modelRunView(run: ModelRun | null | undefined) {
  const actual = String(run?.actualModel || '').trim();
  const requested = String(run?.model || '').trim();
  const model = actual || requested;
  const comparableRequested = requested.replace(/\[1m\]$/, '');
  const mismatch = !!actual && !!requested
    && actual !== requested
    && !actual.startsWith(comparableRequested);

  return {
    model,
    requested,
    source: actual
      ? translateUi('core.chatModelRunActual')
      : (requested ? translateUi('core.chatModelRunRequested') : ''),
    actual: !!actual,
    mismatch,
  };
}
