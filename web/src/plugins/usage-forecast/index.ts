// Прогноз лимитов во фронте: одно размещение — под полосами во всплывашке исполнителя.
import ProviderUsageForecast from '../../features/providers/ProviderUsageForecast.vue';
import { registerPlacement } from '../registry.ts';

registerPlacement({
  pluginId: 'usage-forecast',
  slot: 'provider.popover.after-bars',
  component: ProviderUsageForecast,
  order: 50,
});
