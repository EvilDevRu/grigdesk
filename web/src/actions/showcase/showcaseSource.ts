import { showcaseApi, showcaseErrorMessage } from '../../shared/showcaseApi';
import { showcaseSourceEqual } from '../../../../shared/plugins/showcase/showcaseContracts';
import type {
  ShowcaseProject,
  ShowcaseSourceOptions,
  ShowcaseStorySource,
} from '../../../../shared/plugins/showcase/showcaseContracts';
import type { ShowcaseStore } from './showcaseRuntime';

export interface ShowcaseSourceRead {
  options: ShowcaseSourceOptions | null;
  error: string;
}

// Сохранение привязано к ролику, который человек видел, когда нажимал: id и revision
// захватывает вид до подтверждения, а не операция после него.
export interface ShowcaseSourceSave {
  id: string;
  revision: number;
  source: ShowcaseStorySource | null;
}

/**
 * Из чего выбирать «О чём ролик» у названного ролика. Ответ живёт у вида, а не в
 * сторе: это справка о живой истории стенда, и отказ остаётся рядом с блоком, а не
 * красной строкой над всем разделом.
 */
export async function loadShowcaseSource(
  project: Pick<ShowcaseProject, 'id' | 'target'> | null | undefined,
): Promise<ShowcaseSourceRead> {
  if (!project || project.target.status !== 'ready') {
    return { options: null, error: '' };
  }

  try {
    return { options: await showcaseApi.sourceOptions(project.id), error: '' };
  } catch (error) {
    return {
      options: null,
      error: showcaseErrorMessage(error, 'Не удалось прочитать историю репозиториев стенда.'),
    };
  }
}

function isRevisionConflict(error: unknown): boolean {
  const data = (error as { data?: { error?: unknown } } | null)?.data;

  return data?.error === 'revision_conflict';
}

/**
 * Сохраняет выбор «О чём ролик» названного ролика. Ответ становится открытой карточкой
 * только если человек всё ещё на этом ролике: поздний ответ не открывает прежний ролик
 * поверх нового и не зажигает ему чужую ошибку. Конфликт редакции перечитывает запись,
 * но выбор поверх неё сам не применяет — черновик остаётся у человека.
 */
export async function saveShowcaseSource(
  store: ShowcaseStore,
  request: ShowcaseSourceSave,
): Promise<ShowcaseProject | null> {
  const current = () => store.opened?.id === request.id;

  store.setBusy(request.id, true);

  try {
    const saved = await showcaseApi.saveSource(request.id, request.revision, request.source);

    if (current()) {
      store.setOpened(saved);
      store.setError('');
    }

    return saved;
  } catch (error) {
    if (current()) {
      store.setError(showcaseErrorMessage(error, 'Не удалось сохранить выбор «О чём ролик».'));
    }

    if (isRevisionConflict(error)) {
      const fresh = await showcaseApi.project(request.id).catch(() => null);

      if (fresh && current()) {
        store.setOpened(fresh);
      }
    }

    return null;
  } finally {
    store.setBusy(request.id, false);
  }
}

/**
 * Сцены собраны по другому выбору «О чём ролик»: человек сменил источник после
 * разбора, а новый разбор не прошёл. Пересобрать сцены сам вид не вправе — правки
 * текста в них принадлежат человеку.
 */
export function showcaseSourceOutdated(project: ShowcaseProject | null | undefined): boolean {
  return Boolean(project?.scenes.length) && !showcaseSourceEqual(project?.source, project?.scriptSource);
}

export const SOURCE_OUTDATED_TEXT = 'Выбор «О чём ролик» изменился после разбора — сцены рассказывают '
  + 'о прежнем. Нажмите «Разобрать заново», чтобы сценарий следовал новому выбору.';
