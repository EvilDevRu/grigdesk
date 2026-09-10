import { showcaseApi, showcaseErrorMessage } from '../../shared/showcaseApi';
import { openShowcaseProject } from './openShowcaseProject';
import type { ShowcaseStore } from './showcaseRuntime';

/**
 * Запуск записи сцен. Сервер сам решает, какие сцены снимать: те, чей клип не
 * совпадает со своими входами. Просить у него «записать всё» клиент не может —
 * это стоило бы получаса на каждый повтор.
 */
export async function recordShowcase(store: ShowcaseStore): Promise<boolean> {
  const opened = store.opened;

  if (!opened) {
    return false;
  }

  try {
    store.applyJob(await showcaseApi.startRecording(opened.id));
    store.setError('');

    return true;
  } catch (error) {
    store.setError(showcaseErrorMessage(error, 'Не удалось запустить запись.'));

    return false;
  }
}

/**
 * Бриф от модели. Текст задачи человек вставляет сам и остаётся его владельцем:
 * раздел не ходит за ним в портал и не расширяет доступ ради генерации.
 */
export async function proposeShowcaseBrief(
  store: ShowcaseStore,
  taskText: string,
): Promise<boolean> {
  const opened = store.opened;

  if (!opened) {
    return false;
  }

  store.setBusy(opened.id, true);

  try {
    store.setOpened(await showcaseApi.proposeBrief(opened.id, taskText));
    store.setError('');

    return true;
  } catch (error) {
    store.setError(showcaseErrorMessage(error, 'Не удалось получить бриф.'));

    return false;
  } finally {
    store.setBusy(opened.id, false);
  }
}

/**
 * Сцены по принятому брифу. Негодный ответ модели не меняет ролик: у человека
 * остаётся то, что он уже принял, и повторить он решает сам.
 */
export async function proposeShowcaseScript(
  store: ShowcaseStore,
  taskText: string,
): Promise<boolean> {
  const opened = store.opened;

  if (!opened) {
    return false;
  }

  store.setBusy(opened.id, true);

  try {
    store.setOpened(await showcaseApi.proposeScript(opened.id, taskText));
    store.setError('');

    return true;
  } catch (error) {
    store.setError(showcaseErrorMessage(error, 'Не удалось получить сценарий.'));

    return false;
  } finally {
    store.setBusy(opened.id, false);
  }
}

/**
 * Озвучка сцен. Сервер сам выбирает те, чей звук не совпадает со своими входами,
 * и не трогает загруженные человеком записи: переозвучивать их нельзя.
 */
export async function synthesizeShowcase(store: ShowcaseStore): Promise<boolean> {
  const opened = store.opened;

  if (!opened) {
    return false;
  }

  try {
    store.applyJob(await showcaseApi.synthesize(opened.id));
    store.setError('');

    return true;
  } catch (error) {
    store.setError(showcaseErrorMessage(error, 'Не удалось запустить озвучку.'));

    return false;
  }
}

/**
 * Сборка ролика. Идёт до результата или до конкретной остановки; за человека она
 * ничего не принимает — ни нового сценария, ни расширения доступа.
 */
export async function assembleShowcase(store: ShowcaseStore): Promise<boolean> {
  const opened = store.opened;

  if (!opened) {
    return false;
  }

  try {
    store.applyJob(await showcaseApi.assemble(opened.id));
    store.setError('');
    await openShowcaseProject(store, opened.id);

    return true;
  } catch (error) {
    store.setError(showcaseErrorMessage(error, 'Не удалось собрать ролик.'));

    return false;
  }
}
