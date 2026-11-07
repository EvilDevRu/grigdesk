// Голоса Microsoft Edge TTS — сервиса чтения вслух браузера Edge.
//
// Каталог ЖИВОЙ: сервис отдаёт список голосов по HTTP, и адаптер читает его, а не
// держит в коде — новый многоязычный голос появляется в выборе сам. В коде
// закреплено только то, чего в списке нет: какие голоса читают русский, кто из них
// утверждён по умолчанию и с какой настройкой, и снимок русскоязычной части списка
// на случай, когда сеть не ответила: выбор тогда виден с причиной, а не пуст.
//
// Читают русский два рода голосов: родные `ru-RU-*` и многоязычные
// (`*MultilingualNeural`) — у остальных трёхсот голосов язык один, и русский текст
// они не произнесут. Поэтому список для выбора фильтруется по языку озвучки.

export const EDGE_TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';

const EDGE_BASE_URL = 'speech.platform.bing.com/consumer/speech/synthesize/readaloud';

export const EDGE_VOICE_LIST_URL = `https://${EDGE_BASE_URL}/voices/list`
  + `?trustedclienttoken=${EDGE_TRUSTED_CLIENT_TOKEN}`;

export const EDGE_SOCKET_URL = `wss://${EDGE_BASE_URL}/edge/v1`
  + `?TrustedClientToken=${EDGE_TRUSTED_CLIENT_TOKEN}`;

// Версия Chromium, которой представляется адаптер. Сервис сверяет её с подписью
// запроса и устаревшей версии отвечает отказом 403 — тогда число здесь надо
// поднять до версии текущего Edge (сверено 11.09.2026).
export const EDGE_CHROMIUM_VERSION = '143.0.3650.75';

// Настройка голоса поверх речи поставщика: множитель темпа и сдвиг высоты в герцах.
export interface EdgeVoiceTuning {
  rate: number;
  pitchHz: number;
}

// Утверждённый голос: из прослушивания руководителем он выбран под номером четыре
// вместе с темпом +12 % и высотой −1 Гц. Им говорит новый ролик, пока человек не
// выбрал другой; остальные голоса звучат так, как задумал поставщик.
export const EDGE_DEFAULT_VOICE_ID = 'fr-FR-RemyMultilingualNeural';

export const EDGE_VOICE_TUNING: Readonly<Record<string, EdgeVoiceTuning>> = Object.freeze({
  [EDGE_DEFAULT_VOICE_ID]: { rate: 1.12, pitchHz: -1 },
});

export interface EdgeVoice {
  // Короткое имя поставщика: `fr-FR-RemyMultilingualNeural`. Оно же — голос в
  // ссылке сцены и в SSML.
  id: string;
  name: string;
  locale: string;
  timbre: 'женский' | 'мужской' | '';
  multilingual: boolean;
}

// Строка живого списка поставщика. Поля вне этих не читаются.
interface EdgeVoiceListRow {
  ShortName?: unknown;
  Gender?: unknown;
  Locale?: unknown;
}

const TIMBRE_BY_GENDER: Record<string, EdgeVoice['timbre']> = {
  Female: 'женский',
  Male: 'мужской',
};

/**
 * Имя диктора из короткого имени: `en-US-AvaMultilingualNeural` → `Ava`. Локаль
 * снимается по полю списка, а не по числу дефисов: у части локалей есть третья
 * часть (`zh-CN-liaoning-XiaobeiNeural`), и счёт дефисов резал бы имя не там.
 */
function speakerNameOf(shortName: string, locale: string): string {
  const prefix = `${locale}-`;
  const tail = shortName.startsWith(prefix) ? shortName.slice(prefix.length) : shortName;

  return tail.replace(/MultilingualNeural$|Neural$/, '') || shortName;
}

/**
 * Разбор живого списка. Строка без короткого имени или локали пропускается, а не
 * роняет весь список: один кривой голос у поставщика не должен отнимать остальные.
 */
export function parseEdgeVoiceList(payload: unknown): EdgeVoice[] {
  if (!Array.isArray(payload)) {
    throw new Error('список голосов пришёл не массивом');
  }

  const voices: EdgeVoice[] = [];

  for (const row of payload as EdgeVoiceListRow[]) {
    const shortName = typeof row?.ShortName === 'string' ? row.ShortName.trim() : '';
    const locale = typeof row?.Locale === 'string' ? row.Locale.trim() : '';

    if (!shortName || !locale) {
      continue;
    }

    voices.push({
      id: shortName,
      name: speakerNameOf(shortName, locale),
      locale,
      timbre: TIMBRE_BY_GENDER[String(row.Gender ?? '')] ?? '',
      multilingual: /Multilingual/i.test(shortName),
    });
  }

  return voices;
}

/**
 * Читает ли голос язык озвучки. Родной голос — по локали, многоязычный — любой
 * язык из поддерживаемых поставщиком; русский среди них есть.
 */
export function edgeVoiceReads(voice: EdgeVoice, language: string): boolean {
  const own = voice.locale.split('-')[0]?.toLowerCase() ?? '';

  return own === language.toLowerCase() || voice.multilingual;
}

/**
 * Порядок показа: утверждённый голос первым — им говорит новый ролик, — затем
 * родные голоса языка, затем многоязычные по имени. Первый доступный голос
 * первого готового движка становится голосом по умолчанию, поэтому порядок здесь
 * не украшение.
 */
export function sortEdgeVoices(voices: readonly EdgeVoice[], language: string): EdgeVoice[] {
  const rank = (voice: EdgeVoice): number => {
    if (voice.id === EDGE_DEFAULT_VOICE_ID) {
      return 0;
    }

    return voice.locale.toLowerCase().startsWith(`${language.toLowerCase()}-`) ? 1 : 2;
  };

  return [...voices].sort((left, right) => (
    rank(left) - rank(right) || left.name.localeCompare(right.name, 'en')
  ));
}

// Подпись голоса в выборе: имя, тембр и откуда голос. Многоязычный назван прямо —
// иначе французский голос в русском ролике читался бы как ошибка каталога.
export function edgeVoiceLabel(voice: EdgeVoice): string {
  const parts = [voice.timbre, voice.locale, voice.multilingual ? 'многоязычный' : '']
    .filter(Boolean);

  return `${voice.name} (${parts.join(', ')})`;
}

function snapshot(
  id: string,
  locale: string,
  timbre: EdgeVoice['timbre'],
): EdgeVoice {
  return Object.freeze({
    id,
    name: speakerNameOf(id, locale),
    locale,
    timbre,
    multilingual: /Multilingual/i.test(id),
  });
}

// Снимок голосов, читающих русский, из живого списка от 11.09.2026. Нужен, когда
// сеть не ответила: голоса остаются видимыми с причиной недоступности. Говорить
// по снимку нельзя — доступность подтверждает только живой список.
export const EDGE_VOICES_SNAPSHOT: readonly EdgeVoice[] = Object.freeze([
  snapshot('fr-FR-RemyMultilingualNeural', 'fr-FR', 'мужской'),
  snapshot('ru-RU-DmitryNeural', 'ru-RU', 'мужской'),
  snapshot('ru-RU-SvetlanaNeural', 'ru-RU', 'женский'),
  snapshot('en-US-AndrewMultilingualNeural', 'en-US', 'мужской'),
  snapshot('en-US-AvaMultilingualNeural', 'en-US', 'женский'),
  snapshot('en-US-BrianMultilingualNeural', 'en-US', 'мужской'),
  snapshot('en-US-EmmaMultilingualNeural', 'en-US', 'женский'),
  snapshot('de-DE-FlorianMultilingualNeural', 'de-DE', 'мужской'),
  snapshot('it-IT-GiuseppeMultilingualNeural', 'it-IT', 'мужской'),
  snapshot('ko-KR-HyunsuMultilingualNeural', 'ko-KR', 'мужской'),
  snapshot('de-DE-SeraphinaMultilingualNeural', 'de-DE', 'женский'),
  snapshot('pt-BR-ThalitaMultilingualNeural', 'pt-BR', 'женский'),
  snapshot('fr-FR-VivienneMultilingualNeural', 'fr-FR', 'женский'),
  snapshot('en-AU-WilliamMultilingualNeural', 'en-AU', 'мужской'),
]);
