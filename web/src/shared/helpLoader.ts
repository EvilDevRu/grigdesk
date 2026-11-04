import { decodeHelpBundle } from '../../../shared/help/helpContracts.ts';
import type { HelpBundle } from '../../../shared/help/helpContracts.ts';

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
export function createHelpLoader(load: () => Promise<unknown>, apply: (state: HelpLoadState) => void) {
  let generation = 0;

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
  async function reload(): Promise<void> {
    const ticket = ++generation;

    apply({
      status: 'loading',
      bundle: null,
      error: ''
    });

    try {
      const bundle = decodeHelpBundle(await load());

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
