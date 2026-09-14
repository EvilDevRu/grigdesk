import { showcaseApi, showcaseErrorMessage } from '../../shared/showcaseApi';
import type { ShowcaseProject } from '../../../../shared/showcaseContracts';
import type { ShowcaseStore } from './showcaseRuntime';

/**
 * Разбор стенда: сервер сам читает связанную задачу и код, а затем предлагает
 * бриф и сцены. Шаг долгий — модель отвечает не мгновенно, поэтому ролик помечен
 * занятым всё это время, а не только на время запроса.
 */
export async function analyzeShowcase(store: ShowcaseStore): Promise<boolean> {
  const opened = store.opened;

  if (!opened) {
    return false;
  }

  store.setBusy(opened.id, true);
  store.setAnalyzing(opened.id);

  try {
    store.setOpened(await showcaseApi.analyze(opened.id));
    store.setError('');

    return true;
  } catch (error) {
    store.setError(showcaseErrorMessage(error, 'Не удалось разобрать стенд.'));

    return false;
  } finally {
    store.setBusy(opened.id, false);
    store.setAnalyzing('');
  }
}

/**
 * Достраивает связи для уже принятого сценария. Текст и действия предварительно
 * сохраняет вид; здесь операция меняет только syncBindings и не включает экран
 * полного разбора, чтобы существующие сцены не исчезали во время ожидания модели.
 */
export async function generateShowcaseBindings(store: ShowcaseStore): Promise<boolean> {
  const opened = store.opened;

  if (!opened) {
    return false;
  }

  store.setBusy(opened.id, true);

  try {
    store.setOpened(await showcaseApi.proposeBindings(opened.id));
    store.setError('');

    return true;
  } catch (error) {
    store.setError(showcaseErrorMessage(error, 'Не удалось построить привязки речи.'));

    try {
      store.setOpened(await showcaseApi.project(opened.id));
    } catch {
      // Текущая карточка остаётся на месте; общий поток перечитает её позже.
    }

    return false;
  } finally {
    store.setBusy(opened.id, false);
  }
}

// Пробелы карты экранов словами. Это справка, а не задача оператору: ролик от них
// не ломается — пункт без своего элемента показан ближайшим объявленным экраном.
// Дополнять карту экранов профиля — работа агента, поэтому подсказка ведёт в чат,
// а не в JSON профиля.
export const SCRIPT_GAPS_INTRO = 'Эти пункты показаны ближайшим объявленным экраном — '
  + 'в карте экранов профиля для них нет своих элементов:';
export const SCRIPT_GAPS_HINT = 'Ролик от этого не страдает. Чтобы показать их точнее, попросите '
  + 'агента в чате дополнить карту экранов профиля — он видит этот ролик, — и разберите заново.';

/**
 * Сцены старше карты экранов: после разбора профиль объявил новые экраны или
 * элементы, и сценарий о них не знает. Запись переснимет те же сцены с прежними
 * действиями — честно, но бесполезно; новый сценарий даёт только повторный разбор,
 * и решение о нём остаётся за человеком.
 */
export function showcaseScriptOutdated(project: ShowcaseProject | null | undefined): boolean {
  if (!project || project.target.status !== 'ready' || project.scenes.length === 0) {
    return false;
  }

  const generatedFor = project.scriptMapRevision;
  const current = project.target.scope.mapRevision;

  return Boolean(generatedFor) && Boolean(current) && generatedFor !== current;
}

export const SCRIPT_OUTDATED_TEXT = 'Карта экранов профиля изменилась после разбора — сцены не знают '
  + 'её новых элементов и снимут прежние действия. Нажмите «Разобрать заново», '
  + 'чтобы сценарий их использовал.';
