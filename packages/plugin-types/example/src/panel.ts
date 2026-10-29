import Panel from './Panel.vue';
import type { PluginModuleStart, PluginUiModule } from '@grigdesk/plugin-types/web';

// Фоновая подписка использует общий SSE окна и возвращает cleanup.
export const start: PluginModuleStart = (context) => context.events.on('ready', () => {}, {
  lifetime: 'background',
});

const module: PluginUiModule = { default: Panel, start };

export default module.default;
