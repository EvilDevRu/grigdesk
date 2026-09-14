import { showcaseApi, showcaseErrorCode, showcaseErrorMessage } from '../../shared/showcaseApi';
import type { ShowcasePronunciationOverrideDraft } from '../../shared/showcaseApi';
import type { ShowcaseDirection, ShowcasePace } from '../../../../shared/showcaseContracts';
import type { ShowcaseStore } from './showcaseRuntime';

export interface ShowcaseVoiceChoice {
  voiceRef: string | null;
  pace: ShowcasePace | null;
}

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
 * Образец голоса. Первый запрос синтезирует фразу — у тяжёлого движка это десятки
 * секунд, — дальше отдаётся кэш сервера. Отказ движка возвращается словами: тишина
 * без причины читалась бы как поломка кнопки.
 */
export async function loadShowcaseVoicePreview(voiceRef: string): Promise<Blob> {
  try {
    return await showcaseApi.voicePreview(voiceRef);
  } catch (error: unknown) {
    throw new Error(showcaseErrorMessage(error, 'Образец не воспроизвёлся: движок не ответил.'));
  }
}

/**
 * Своя реплика использует те же указания и локальные замены, что полная сборка.
 * AbortSignal нужен редактору, чтобы уход со сцены не запускал устаревший звук.
 */
export async function loadShowcaseNarrationPreview(input: {
  voiceRef: string;
  narration: string;
  direction: ShowcaseDirection;
  pronunciationOverrides: ShowcasePronunciationOverrideDraft[];
}, signal?: AbortSignal): Promise<Blob> {
  try {
    return await showcaseApi.narrationPreview(input, signal);
  } catch (error: unknown) {
    throw new Error(showcaseErrorMessage(
      error,
      'Реплика не воспроизвелась: голосовой движок не ответил.',
    ));
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

/**
 * Словарь ударений установки. Читается снимком: текст, разобранные записи и
 * негодные строки приходят вместе, чтобы редактор не показывал ошибки от
 * прошлой редакции рядом со свежим текстом.
 */
export async function loadShowcaseDictionary(store: ShowcaseStore): Promise<void> {
  try {
    store.setDictionary(await showcaseApi.voiceDictionary());
  } catch (error: unknown) {
    store.setError(showcaseErrorMessage(error, 'Не удалось прочитать словарь ударений.'));
  }
}

/**
 * Сохранение словаря. Текст уходит целиком, вместе с негодными строками: сервер
 * их не выбрасывает, а возвращает с причиной — человек чинит их на месте. Звук
 * сцен со словами из словаря устареет сам, и следующая сборка переозвучит их.
 */
export async function saveShowcaseDictionary(store: ShowcaseStore, text: string): Promise<boolean> {
  store.setVoiceBusy(true);

  try {
    store.setDictionary(await showcaseApi.saveVoiceDictionary(text));
    store.setError('');

    return true;
  } catch (error: unknown) {
    store.setError(showcaseErrorMessage(error, 'Не удалось сохранить словарь ударений.'));

    return false;
  } finally {
    store.setVoiceBusy(false);
  }
}

/**
 * Голос и темп открытого ролика. Сервер меняет все синтезируемые сцены разом и
 * возвращает ролик с пересчитанной свежестью: звук устарел, и следующая сборка
 * переозвучит его сама.
 */
export async function setShowcaseVoice(
  store: ShowcaseStore,
  choice: ShowcaseVoiceChoice,
): Promise<boolean> {
  const opened = store.opened;

  if (!opened) {
    return false;
  }

  store.setBusy(opened.id, true);

  try {
    store.setOpened(await putVoice(opened.id, opened.revision, choice));
    store.setError('');

    return true;
  } catch (error: unknown) {
    store.setError(showcaseErrorMessage(error, 'Не удалось сменить голос.'));

    return false;
  } finally {
    store.setBusy(opened.id, false);
  }
}

/**
 * Смена голоса с одним повтором на свежей редакции. Редакция в браузере отстаёт
 * от сервера после любого завершившегося задания, а выбор голоса ни с чем не
 * конфликтует: перечитать ролик и повторить честнее, чем просить человека
 * обновить страницу ради того же нажатия.
 */
async function putVoice(id: string, revision: number, choice: ShowcaseVoiceChoice) {
  try {
    return await showcaseApi.setVoice(id, revision, choice);
  } catch (error: unknown) {
    if (showcaseErrorCode(error) !== 'revision_conflict') {
      throw error;
    }

    const fresh = await showcaseApi.project(id);

    return showcaseApi.setVoice(id, fresh.revision, choice);
  }
}
