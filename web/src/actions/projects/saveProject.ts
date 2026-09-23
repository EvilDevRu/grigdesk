import { projectsApi, projectsErrorData, projectsFailureText } from '../../shared/projectsApi';
import { useProjectsStore } from '../../stores/projects';
import { changedFields, createDraft, toInput } from '../../views/projects/projectDraft';
import { loadProjects } from './loadProjects';
import type { ProjectDraft } from '../../views/projects/projectDraft';

export interface SaveProjectResult {
  ok: boolean;
  // Код отказа сервера: по нему страница решает, что показать — «проект уже есть»
  // или расхождение ревизий. Пустая строка — сохранение прошло.
  error: string;
  // Подсказки сервера по конкретным полям: форма раскладывает их так же, как свои.
  fieldErrors: Array<{ path: string; message: string }>;
}

/**
 * Сохранение черновика. `id === null` — создание нового проекта: его идентификатор
 * лежит в самом черновике, потому что форма спрашивает его у человека.
 *
 * Ревизия, которую видел человек, уходит вместе с телом. Если она устарела, сервер
 * отвечает 409: тогда в состоянии остаётся конфликт (`currentRevision` и список
 * изменённых полей), а черновик — на месте, чтобы человек мог сравнить версии.
 */
export async function saveProject(
  id: string | null,
  draft: ProjectDraft,
  { expectedRevision }: { expectedRevision?: number } = {},
): Promise<SaveProjectResult> {
  const store = useProjectsStore();
  const input = toInput(draft);

  try {
    const detail = id === null
      ? await projectsApi.create({ ...input, id: draft.id })
      : await projectsApi.update(id, {
        ...input,
        expectedRevision: expectedRevision ?? store.opened?.revision ?? 0,
      });

    store.setOpened(detail);
    store.setDraft(createDraft(detail));
    store.setConflict(null);
    store.setError('');
    await loadProjects();

    return {
      ok: true,
      error: '',
      fieldErrors: [],
    };
  } catch (error) {
    const body = projectsErrorData(error);

    if (body?.error === 'revision_conflict') {
      store.setConflict({
        currentRevision: body.currentRevision ?? 0,
        changedFields: store.opened ? changedFields(draft, createDraft(store.opened)) : [],
      });
      store.setError(body.message);

      return {
        ok: false,
        error: body.error,
        fieldErrors: [],
      };
    }

    store.setError(projectsFailureText(error, 'Не удалось сохранить паспорт проекта.'));

    return {
      ok: false,
      error: body?.error ?? '',
      fieldErrors: body?.fieldErrors ?? [],
    };
  }
}
