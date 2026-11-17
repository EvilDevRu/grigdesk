import { showcaseApi, showcaseErrorMessage } from '../../shared/showcaseApi';
import { showcaseSourceEqual } from '../../../../shared/plugins/showcase/showcaseContracts';
import type {
  ShowcaseProject,
  ShowcaseStorySource,
} from '../../../../shared/plugins/showcase/showcaseContracts';
import type { ShowcaseStore } from './showcaseRuntime';
import { localeTranslator } from '../../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from '../../shared/uiLocalePort.ts';

const translateUi = localeTranslator(uiLocalePort);


// Сохранение привязано к ролику, который человек видел, когда нажимал: id и revision
// захватывает вид до подтверждения, а не операция после него.
export interface ShowcaseSourceSave {
  id: string;
  revision: number;
  source: ShowcaseStorySource | null;
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
      store.setError(
        showcaseErrorMessage(error, translateUi('core.showcaseSourceCouldNotSaveTheVideoSubjectSelection')),
      );
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

export const SOURCE_OUTDATED_TEXT = translateUi('core.showcaseSourceTheVideoSubjectChangedAfterAnalysisThe')
  + translateUi('core.showcaseSourceThePreviousSelectionClickAnalyzeAgainTo');
