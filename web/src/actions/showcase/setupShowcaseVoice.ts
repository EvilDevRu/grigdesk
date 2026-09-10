import { showcaseApi, showcaseErrorMessage } from '../../shared/showcaseApi';
import type { ShowcaseStore } from './showcaseRuntime';

/**
 * Каталог голосов: состояние движков, что уже установлено и что идёт сейчас.
 * Читается снимком целиком — собирать эти три вещи из разных ответов значило бы
 * показывать «установлен» рядом с «ставится» в один и тот же момент.
 */
export async function loadShowcaseVoices(store: ShowcaseStore): Promise<void> {
  try {
    store.setVoices(await showcaseApi.voices());
  } catch (error: unknown) {
    store.setError(showcaseErrorMessage(error, 'Не удалось прочитать список голосов.'));
  }
}

/**
 * Установка голоса. Скачивание идёт минутами, поэтому ответ приходит сразу с
 * заведённой установкой, а её ход догоняет событиями: держать запрос открытым
 * до конца загрузки нечестно ни к браузеру, ни к человеку.
 */
export async function installShowcaseVoice(store: ShowcaseStore, voiceId: string): Promise<void> {
  store.setVoiceBusy(true);

  try {
    store.setVoices(await showcaseApi.installVoice(voiceId));
    store.setError('');
  } catch (error: unknown) {
    store.setError(showcaseErrorMessage(error, 'Не удалось начать установку голоса.'));
  } finally {
    store.setVoiceBusy(false);
  }
}

/**
 * Отмена установки. Скачанное остаётся на диске: человек чаще всего отменяет
 * из-за медленной сети, и повтор не должен начинаться с нуля.
 */
export async function cancelShowcaseVoiceInstall(store: ShowcaseStore): Promise<void> {
  store.setVoiceBusy(true);

  try {
    store.setVoices(await showcaseApi.cancelVoiceInstall());
  } catch (error: unknown) {
    store.setError(showcaseErrorMessage(error, 'Не удалось отменить установку.'));
  } finally {
    store.setVoiceBusy(false);
  }
}
