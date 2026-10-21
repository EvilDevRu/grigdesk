interface BrowserRecognition {
  prototype: object;
  available?: (options: { langs: string[]; processLocally: boolean }) => Promise<string>;
}

/**
 * Проверка читает возможность браузера, не создавая распознавание или запрос согласия.
 * Оба имени API поддерживаются по существующему контракту Web Speech.
 */
export function browserSpeechRecognition(win: Window): BrowserRecognition | null {
  const browser = win as unknown as {
    SpeechRecognition?: BrowserRecognition;
    webkitSpeechRecognition?: BrowserRecognition;
  };

  return win.isSecureContext === false ? null
    : browser.SpeechRecognition ?? browser.webkitSpeechRecognition ?? null;
}

/**
 * Отсутствующая локальная модель не переключает сохранённый режим на облачный.
 * Запрос available не устанавливает языковые пакеты и не запускает диктовку.
 */
export async function probeLocalSpeech(win: Window, language: string): Promise<string> {
  const recognition = browserSpeechRecognition(win);

  if (!recognition?.available || !('processLocally' in recognition.prototype)) {
    return 'unavailable';
  }

  const tag = language === 'ru' ? 'ru-RU' : language === 'en' ? 'en-US'
    : 'ru';

  try {
    return await recognition.available({ langs: [tag], processLocally: true });
  } catch {
    return 'unavailable';
  }
}
