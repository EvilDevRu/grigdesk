// Подключение стенда использует тот же допуск UI-ответа, что правка сцены.
// Серверный выбор ref и expectedRevision захватываются до ожидания сети.
import type { ShowcaseSelectableTargetRef } from '../../../../shared/plugins/showcase/showcaseContracts.ts';
import { attachShowcaseTarget as attachRequest } from '../../shared/showcaseApi.ts';
import type { ShowcaseStore } from './showcaseRuntime.ts';
import { apply as applyMutation } from './editShowcaseScenes.ts';
import { localeTranslator } from '../../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from '../../shared/uiLocalePort.ts';

const translateUi = localeTranslator(uiLocalePort);

/**
 * Attach не является навигацией: поздний ответ не открывает прежнюю карточку.
 * Общий apply владеет success/error/reload и оставляет черновик при конфликте.
 */
export function attachShowcaseTarget(
  store: ShowcaseStore,
  projectId: string,
  expectedRevision: number,
  ref: ShowcaseSelectableTargetRef,
): Promise<boolean> {
  if (store.opened?.id !== projectId) {
    return Promise.resolve(false);
  }

  return applyMutation(
    store,
    () => attachRequest(projectId, expectedRevision, ref),
    translateUi('core.showcaseNeUdalosPodklyuchitStend'),
  );
}
