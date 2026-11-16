import { runtimeOf } from './projectsRuntime';
import { projectsApi, projectsErrorData, projectsFailureText } from '../../shared/projectsApi';
import { useProjectsStore } from '../../stores/projects';
import { createDraft } from '../../views/projects/projectDraft';
import { loadDependencies } from './loadDependencies';
import { loadProjects } from './loadProjects';
import { localeTranslator } from '../../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from '../../shared/uiLocalePort.ts';

const t = localeTranslator(uiLocalePort);


export interface ProjectLifecycleResult {
  ok: boolean;
  error: string;
  message: string;
}

/**
 * Одна операция жизненного цикла на два действия: архив и возврат отличаются только
 * вызовом и текстом запасной ошибки. Общая часть — та, где можно ошибиться: ревизия,
 * обновление снимка и перечитывание связей.
 */
export async function changeLifecycle(
  id: string,
  expectedRevision: number,
  action: 'archive' | 'restore',
): Promise<ProjectLifecycleResult> {
  const store = useProjectsStore();
  const runtime = runtimeOf(store);
  const generation = runtime.selectionGeneration;

  try {
    const detail = action === 'archive'
      ? await projectsApi.archive(id, expectedRevision)
      : await projectsApi.restore(id, expectedRevision);

    if (generation !== runtime.selectionGeneration) {
      return {
        ok: false,
        error: 'selection_changed',
        message: '',
      };
    }

    store.setOpened(detail);
    store.setDraft(createDraft(detail));
    store.setConflict(null);
    store.setError('');
    await Promise.all([loadProjects(), loadDependencies(id)]);

    return {
      ok: true,
      error: '',
      message: '',
    };
  } catch (error) {
    if (generation !== runtime.selectionGeneration) {
      return {
        ok: false,
        error: 'selection_changed',
        message: '',
      };
    }

    const body = projectsErrorData(error);
    const message = projectsFailureText(
      error,
      action === 'archive' ? t('core.projectNeUdalosUbratProekt') : t('core.projectNeUdalosVernutProekt'),
    );

    // Свежая сводка объясняет отказ: сервер отказал по связям, и человеку нужен их список.
    await loadDependencies(id);

    return {
      ok: false,
      error: body?.error ?? '',
      message,
    };
  }
}
