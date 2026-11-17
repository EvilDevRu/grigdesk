import { showcaseApi, showcaseErrorMessage } from '../../shared/showcaseApi';
import type { ShowcaseSelectableTargetRef } from '../../../../shared/plugins/showcase/showcaseContracts';
import { loadShowcase } from './loadShowcase';
import type { ShowcaseStore } from './showcaseRuntime';
import { captureShowcaseNavigation, showcaseProjectOwner } from './showcaseRuntime';
import { localeTranslator } from '../../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from '../../shared/uiLocalePort.ts';

const translateUi = localeTranslator(uiLocalePort);


export interface CreateShowcaseInput {
  ref?: ShowcaseSelectableTargetRef | null;
  title?: string;
}

/**
 * Заводит ролик и сразу открывает его. Цель резолвится на сервере при создании,
 * поэтому карточка нового ролика уже показывает, готова ли запись, — человеку не
 * приходится нажимать «проверить» отдельным шагом.
 */
export async function createShowcaseProject(
  store: ShowcaseStore,
  input: CreateShowcaseInput,
): Promise<string> {
  const current = showcaseProjectOwner(store);
  const navigationCurrent = captureShowcaseNavigation(store);

  try {
    const project = await showcaseApi.create(input);

    if (!current()) {
      return '';
    }

    store.setOpened(project);
    store.setError('');
    await loadShowcase(store);

    return navigationCurrent() && store.opened?.id === project.id ? project.id : '';
  } catch (error) {
    if (!current()) {
      return '';
    }

    store.setError(
      showcaseErrorMessage(error, translateUi('core.createShowcaseProjectCouldNotCreateAVideo')),
    );

    return '';
  }
}
