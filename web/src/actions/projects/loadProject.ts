import { projectsApi, projectsFailureText } from '../../shared/projectsApi';
import { useProjectsStore } from '../../stores/projects';
import { createDraft } from '../../views/projects/projectDraft';
import { runtimeOf } from './projectsRuntime';

/**
 * Паспорт проекта по id.
 *
 * `keepDraft` — для перечитывания по событию сервера: снимок обновляется, а черновик
 * человека остаётся нетронутым. Открытие другого проекта всегда ставит новый черновик:
 * иначе форма показала бы правки прошлого проекта.
 */
export async function loadProject(
  id: string,
  { keepDraft = false }: { keepDraft?: boolean } = {},
): Promise<void> {
  const store = useProjectsStore();
  const runtime = runtimeOf(store);
  const previousId = store.opened?.id ?? null;

  runtime.detailRequest += 1;

  const request = runtime.detailRequest;

  try {
    const detail = await projectsApi.detail(id);

    if (request !== runtime.detailRequest) {
      return;
    }

    store.setOpened(detail);

    if (!keepDraft || previousId !== detail.id || store.draft === null) {
      store.setDraft(createDraft(detail));
      store.setConflict(null);
    }

    store.setError('');
  } catch (error) {
    if (request !== runtime.detailRequest) {
      return;
    }

    store.setError(projectsFailureText(error, 'Не удалось прочитать паспорт проекта.'));
  }
}
