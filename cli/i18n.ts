import { createTranslator, resolveLocale } from '../shared/i18n/core.ts';
import type { MessageParams } from '../shared/i18n/core.ts';
import locales from '../shared/i18n/assets/locales/catalog.json' with { type: 'json' };
import ru from '../shared/i18n/assets/locales/ru/cli.json' with { type: 'json' };
import en from '../shared/i18n/assets/locales/en/cli.json' with { type: 'json' };

/**
 * Язык терминала не зависит от профиля окна и не требует чтения пользовательских данных.
 * Пустое окружение сохраняет русский, заданная неизвестная локаль использует общий fallback.
 */
export function cliTranslator(env: NodeJS.ProcessEnv = process.env) {
  const language = env.LC_ALL || env.LC_MESSAGES || env.LANG;
  const locale = language ? resolveLocale(undefined, language) : 'ru';
  const translator = createTranslator({ locales, messages: { ru, en } });

  return {
    locale,
    t: (key: string, params?: MessageParams) => translator.t(locale, key, params, key),
  };
}
