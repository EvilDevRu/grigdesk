import { showcaseApi, showcaseErrorMessage } from '../../shared/showcaseApi';
import type { ShowcaseSceneDraft } from '../../shared/showcaseApi';
import type { ShowcaseProject } from '../../../../shared/plugins/showcase/showcaseContracts';
import type { ShowcaseStore } from './showcaseRuntime';
import { showcaseProjectOwner } from './showcaseRuntime';
import { localeTranslator } from '../../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from '../../shared/uiLocalePort.ts';

const translateUi = localeTranslator(uiLocalePort);


/**
 * Успех, ошибка и перечитанная карточка принадлежат захваченному ролику. Внешний
 * предикат дополнительно привязывает цепочку адаптации к эпохе навигации.
 */
export async function apply(
  store: ShowcaseStore,
  action: (project: ShowcaseProject) => Promise<ShowcaseProject>,
  fallback: string,
  isCurrent: () => boolean = () => true,
): Promise<boolean> {
  const opened = store.opened;

  if (!opened || !isCurrent()) {
    return false;
  }

  const owner = showcaseProjectOwner(store, opened.id);
  const current = () => owner() && isCurrent();

  store.setBusy(opened.id, true);

  try {
    const saved = await action(opened);

    if (!current()) {
      return false;
    }

    store.setOpened(saved);
    store.setError('');

    return true;
  } catch (error) {
    if (!current()) {
      return false;
    }

    store.setError(showcaseErrorMessage(error, fallback));

    try {
      const fresh = await showcaseApi.project(opened.id);

      if (current()) {
        store.setOpened(fresh);
      }
    } catch {
      // Ошибка перечитывания не возвращает закрытую карточку и не теряет ввод.
    }

    return false;
  } finally {
    store.setBusy(opened.id, false);
  }
}

/**
 * Новая сцена встаёт в конец списка. Вставка в середину — это перестановка, и
 * делать её побочным эффектом добавления нельзя: порядок решает человек.
 */
export function addShowcaseScene(store: ShowcaseStore, draft: ShowcaseSceneDraft) {
  return apply(
    store,
    (project) => showcaseApi.addScene(project.id, project.revision, draft),
    translateUi('core.editShowcaseScenesCouldNotAddAScene'),
  );
}

/**
 * Правка сцены. Уходят только изменённые поля: «сохранить всё целиком» затирало бы
 * то, что за это время дописало задание.
 */
export function updateShowcaseScene(
  store: ShowcaseStore,
  sceneId: string,
  patch: Partial<ShowcaseSceneDraft>,
  isCurrent: () => boolean = () => true,
) {
  return apply(
    store,
    (project) => showcaseApi.updateScene(project.id, project.revision, sceneId, patch),
    translateUi('core.editShowcaseScenesCouldNotSaveTheScene'),
    isCurrent,
  );
}

/**
 * Удаление сцены уносит её звук и запись. Сервер снимает ссылки до удаления
 * файлов, поэтому идущая сборка не остаётся с исчезнувшим из-под неё клипом.
 */
export function removeShowcaseScene(store: ShowcaseStore, sceneId: string) {
  return apply(
    store,
    (project) => showcaseApi.removeScene(project.id, project.revision, sceneId),
    translateUi('core.editShowcaseScenesCouldNotDeleteTheScene'),
  );
}

/**
 * Перестановка. Порядок уходит полным списком: сервер отказывается достраивать
 * частичный, потому что достроенный порядок — это ролик не в том порядке.
 */
export function reorderShowcaseScenes(store: ShowcaseStore, order: string[]) {
  return apply(
    store,
    (project) => showcaseApi.reorderScenes(project.id, project.revision, order),
    translateUi('core.editShowcaseScenesCouldNotReorderScenes'),
  );
}

/**
 * Загрузка готового звука. Такая сцена больше не озвучивается синтезом: запись
 * человека — полноправный источник, а не заглушка до появления голосового движка.
 */
export function importShowcaseAudio(store: ShowcaseStore, sceneId: string, file: File) {
  return apply(
    store,
    (project) => showcaseApi.importSceneAudio(project.id, project.revision, sceneId, file),
    translateUi('core.editShowcaseScenesCouldNotUploadSceneAudio'),
  );
}
