import { closeTopLayer } from '../ui.ts';

interface BackRouter {
  options: { history: { state: { back?: unknown } } };
  back(): void;
}

declare global {
  interface Window {
    grigdeskBack?: () => boolean;
  }
}

/**
 * Системная кнопка сначала использует политику верхнего слоя, как Escape.
 * Переход по истории допустим лишь при наличии предыдущего маршрута приложения.
 */
export function installBackAction(router: BackRouter, dismissConnections = () => false): () => void {
  const previous = window.grigdeskBack;

  window.grigdeskBack = () => {
    if (closeTopLayer(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))) {
      return true;
    }

    if (dismissConnections()) {
      return true;
    }

    if (!router.options.history.state.back) {
      return false;
    }

    router.back();

    return true;
  };

  return () => {
    window.grigdeskBack = previous;
  };
}
