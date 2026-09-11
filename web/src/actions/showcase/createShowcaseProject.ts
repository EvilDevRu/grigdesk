import { showcaseApi, showcaseErrorMessage } from '../../shared/showcaseApi';
import type { ShowcaseSelectableTargetRef } from '../../../../shared/showcaseContracts';
import { loadShowcase } from './loadShowcase';
import type { ShowcaseStore } from './showcaseRuntime';

export interface CreateShowcaseInput {
  ref: ShowcaseSelectableTargetRef;
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
  try {
    const project = await showcaseApi.create(input);

    store.setOpened(project);
    store.setError('');
    await loadShowcase(store);

    return project.id;
  } catch (error) {
    store.setError(showcaseErrorMessage(error, 'Не удалось создать ролик.'));

    return '';
  }
}
