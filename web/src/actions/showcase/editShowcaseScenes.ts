import { showcaseApi, showcaseErrorMessage } from '../../shared/showcaseApi';
import type { ShowcaseSceneDraft } from '../../shared/showcaseApi';
import type { ShowcaseProject } from '../../../../shared/plugins/showcase/showcaseContracts';
import type { ShowcaseStore } from './showcaseRuntime';

/**
 * Общая обвязка правок сцен. Каждая правка уходит со своей ожидаемой редакцией и
 * возвращает свежую запись целиком: сервер сам считает, что после правки устарело,
 * и клиенту незачем повторять этот расчёт по-своему.
 *
 * Конфликт редакций не теряет чужую работу: карточка перечитывается, и человек
 * видит текущее состояние вместо своего наложенного поверх.
 */
async function apply(
  store: ShowcaseStore,
  action: (project: ShowcaseProject) => Promise<ShowcaseProject>,
  fallback: string,
): Promise<boolean> {
  const opened = store.opened;

  if (!opened) {
    return false;
  }

  store.setBusy(opened.id, true);

  try {
    store.setOpened(await action(opened));
    store.setError('');

    return true;
  } catch (error) {
    store.setError(showcaseErrorMessage(error, fallback));

    try {
      store.setOpened(await showcaseApi.project(opened.id));
    } catch {
      // Карточку могло уже не быть: список обновит общий обзор.
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
    'Не удалось добавить сцену.',
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
) {
  return apply(
    store,
    (project) => showcaseApi.updateScene(project.id, project.revision, sceneId, patch),
    'Не удалось сохранить сцену.',
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
    'Не удалось удалить сцену.',
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
    'Не удалось изменить порядок сцен.',
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
    'Не удалось загрузить звук сцены.',
  );
}
