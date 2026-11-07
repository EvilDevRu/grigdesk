import { alertUser, dismissAlert, dismissAlertScope } from '../shared/alerts.ts';
import type { PluginAlertInput } from '../../../packages/plugin-types/src/web.js';
import { decodePluginPanelParams } from '../../../shared/plugins/pluginPanelParams.ts';

export type { PluginAlertInput } from '../../../packages/plugin-types/src/web.js';

/**
 * Идентификатор, область и цель всегда принадлежат текущему плагину.
 * Отзыв экземпляра снимает оба канала уведомлений, включая системный.
 */
export function createPluginAlerts(pluginId: string, options: {
  signal: AbortSignal;
  isAlive: () => boolean;
  kind?: 'plugin' | 'plugin-background';
}) {
  const scope = `${options.kind ?? 'plugin'}:${encodeURIComponent(pluginId)}`;
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

      const params = decodePluginPanelParams(input.params ?? {});

      if (!params) {
        return false;
      }

      if (input.actions !== undefined && (!Array.isArray(input.actions)
        || input.actions.some((action) => !action || !validId(action.id)
          || typeof action.run !== 'function'))) {
        return false;
      }

      const actions = input.actions?.map(({ id, label, run }) => ({
        id,
        label,
        run: () => alive() ? run() : undefined,
      }));

      return alertUser({
        id: fullId(input.id),
        scope,
        title: input.title,
        body: input.body,
        detail: input.detail,
        tone: input.tone,
        sticky: input.sticky,
        actions,
        ...(input.openPanel === false ? {} : {
          target: {
            kind: 'plugin' as const,
            pluginId,
            params,
          },
        }),
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
