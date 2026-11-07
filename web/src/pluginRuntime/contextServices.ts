import type { Ref } from 'vue';
import type { PluginModuleContext } from '../../../packages/plugin-types/src/web.js';
import { t } from '../ui.ts';
import { askAgent } from '../shared/askAgent.ts';
import type { AskAgentInput, AskAgentOptions } from '../shared/askAgent.ts';
import type { PluginContext } from './context.ts';
import { createPluginEvents } from './events.ts';
import { createPluginAlerts } from './alerts.ts';
import { createPluginPanel } from './panel.ts';
import type { PluginPanelOptions } from './panel.ts';
import { openSettings } from '../shared/settingsNavigation.ts';
import { createPluginNotifications } from './serverNotifications.ts';
import type { PluginNotificationIdentity } from './serverNotifications.ts';

export interface PluginServiceOptions extends PluginPanelOptions {
  signal: AbortSignal;
  panelActive: Readonly<Ref<boolean>>;
  backgroundActive: Readonly<Ref<boolean>>;
  chat?: AskAgentOptions['chat'];
  notificationIdentity?: PluginNotificationIdentity;
}

/**
 * Базовые пять полей сохраняют прежние значения и реактивность.
 * Все новые возможности замыкают одного владельца и его отзываемый signal.
 */
export function createPluginContextServices(
  base: PluginContext, options: PluginServiceOptions,
): { context: PluginModuleContext; clearPanel: () => void } {
  const events = createPluginEvents(base.pluginId, options);
  const context = {
    ...base,
    signal: options.signal,
    events: { on: events.on },
    alerts: createPluginAlerts(base.pluginId, options),
    askAgent: async (input: AskAgentInput) => {
      if (options.signal.aborted || !options.isAlive()) {
        throw new Error(t('core.pluginModuleAccessRevoked'));
      }
      if (!options.chat) {
        throw new Error(t('core.pluginAskAgentChooseModel'));
      }

      return askAgent(input, {
        chat: options.chat,
        router: options.router,
        signal: options.signal,
        isAlive: options.isAlive,
      });
    },
    panel: createPluginPanel(base.pluginId, options),
    /**
     * Настройки открывает общая навигация, а источник выбирает оболочка.
     * Отозванный контекст не создаёт запрос и не меняет текущую форму.
     */
    openSettings(input: { pageId: string; entityId?: string }) {
      if (options.signal.aborted || !options.isAlive()) {
        return false;
      }

      return openSettings({
        pageId: input.pageId,
        ...(input.entityId === undefined ? {} : { entityId: input.entityId }),
        source: 'button',
      });
    },
    providers: { onChanged: events.onProvidersChanged },
    notifications: createPluginNotifications(base.pluginId, options),
  };

  return { context, clearPanel: events.clearPanel };
}

export type { PluginModuleContext } from '../../../packages/plugin-types/src/web.js';
