import { adaptShowcaseNarration as adaptRequest } from '../../shared/showcaseApi';
import type { ShowcaseStore } from './showcaseRuntime';
import { showcaseProjectOwner } from './showcaseRuntime';
import { apply as applyMutation } from './editShowcaseScenes';
import { localeTranslator } from '../../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from '../../shared/uiLocalePort.ts';

const translateUi = localeTranslator(uiLocalePort);

/**
 * Общий apply владеет ответом и перечитывает факт после частичного отказа bindings.
 * Здесь остаётся только состояние длительного разбора конкретного ролика.
 */
export async function adaptShowcaseNarration(
  store: ShowcaseStore,
  projectId: string,
  isCurrent: () => boolean = () => true,
): Promise<boolean> {
  const owner = showcaseProjectOwner(store, projectId);

  if (!owner() || !isCurrent()) {
    return false;
  }

  store.setAnalyzing(projectId);

  try {
    return await applyMutation(
      store,
      () => adaptRequest(projectId),
      translateUi('core.showcaseNeUdalosAdaptirovat'),
      () => owner() && isCurrent(),
    );
  } finally {
    if (store.analyzing === projectId) {
      store.setAnalyzing('');
    }
  }
}
