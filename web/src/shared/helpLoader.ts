import { decodeHelpBundle } from '../../../shared/help/helpContracts.ts';
import type { HelpBundle, HelpLocale } from '../../../shared/help/helpContracts.ts';


export type HelpLoadError = 'helpUnavailable' | 'helpServerUpgradeRequired' | '';

export type HelpLoadState = {
  status: 'loading' | 'error' | 'ready';
  bundle: HelpBundle | null;
  error: HelpLoadError;
};
/**
 * Каждая загрузка владеет поколением ответа: поздний пакет другой машины отбрасывается.
 * Отмена скрывает прежний текст до того, как начнётся запрос нового источника.
 */
export function createHelpLoader(
  load: (locale: HelpLocale) => Promise<unknown>,
  apply: (state: HelpLoadState) => void
) {
  let generation = 0;

  /**
   * Отмена сразу скрывает корпус и инвалидирует основной и запасной запросы.
   * Новый источник не может получить запоздалый результат прежнего поколения.
   */
  function cancel(): void {
    generation += 1;
    apply({
      status: 'loading',
      bundle: null,
      error: ''
    });
  }

  /**
   * Поколение связывает ответ с текущей машиной и попыткой загрузки.
   * Поздний результат отменённой попытки не возвращает скрытый старый корпус.
   */
  async function reload(locale: HelpLocale = 'ru'): Promise<void> {
    const ticket = ++generation;

    apply({
      status: 'loading',
      bundle: null,
      error: ''
    });

    try {
      let raw;
      let fallback = false;

      try {
        raw = await load(locale);
      } catch (error) {
        if (ticket !== generation) {
          return;
        }

        const failure = error as {
          status?: unknown;
          data?: { error?: unknown };
        } | null;

        if (locale !== 'en' || failure?.status !== 404
          || failure.data?.error !== 'help_locale_unavailable') {
          throw error;
        }

        fallback = true;
        raw = await load('ru');
      }

      const bundle = decodeHelpBundle(raw);

      if (fallback ? bundle.locale !== 'ru' : bundle.locale !== locale
        && !(locale === 'en' && bundle.locale === 'ru')) {
        throw new Error('help_unavailable');
      }

      if (ticket === generation) {
        apply({
          status: 'ready',
          bundle,
          error: ''
        });
      }
    }
    catch (error) {
      if (ticket === generation) {
        const status = (error as {
          status?: unknown;
        } | null)?.status;

        apply({
          status: 'error',
          bundle: null,
          error: status === 404 ? 'helpServerUpgradeRequired' : 'helpUnavailable'
        });
      }
    }
  }

  return {
    reload, cancel
  };
}
