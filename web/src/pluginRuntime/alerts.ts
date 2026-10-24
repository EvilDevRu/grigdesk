import { alertUser, dismissAlert, dismissAlertScope } from '../shared/alerts.ts';
import type { AlertInput } from '../shared/alerts.ts';

export type PluginAlertInput = Pick<AlertInput, 'id' | 'title' | 'body' | 'detail' | 'tone' | 'sticky'> & {
  openPanel?: boolean;
};

/**
 * Идентификатор, область и цель всегда принадлежат текущему плагину.
 * Отзыв экземпляра снимает оба канала уведомлений, включая системный.
 */
export function createPluginAlerts(pluginId: string, options: {
  signal: AbortSignal;
  isAlive: () => boolean;
}) {
  const scope = `plugin:${encodeURIComponent(pluginId)}`;
  const alive = () => !options.signal.aborted && options.isAlive();
  const validId = (id: string) => typeof id === 'string' && !!id.trim();
  const fullId = (id: string) => `${scope}:${encodeURIComponent(id)}`;
  const clear = () => dismissAlertScope(scope);

  options.signal.addEventListener('abort', clear, { once: true });

  return {
    show: (input: PluginAlertInput): boolean => {
      if (!alive() || !input || !validId(input.id)) {
        return false;
      }

      return alertUser({
        id: fullId(input.id),
        scope,
        title: input.title,
        body: input.body,
        detail: input.detail,
        tone: input.tone,
        sticky: input.sticky,
        ...(input.openPanel === false ? {} : { target: { kind: 'plugin' as const, pluginId } }),
      });
    },
    dismiss: (id: string): void => {
      if (alive() && validId(id)) {
        dismissAlert(fullId(id));
      }
    },
    clear: (): void => {
      if (alive()) {
        clear();
      }
    },
  };
}
