// Оглавление слотов плагинов. Содержания здесь нет: каждая область объявляет свои
// слоты в своём файле (`providerSlots.ts`, дальше `boardSlots.ts`, `chatSlots.ts`…), а
// это место лишь объединяет их типы и подписи, чтобы `<PluginSlot name=…>` проверял
// имя типом, а настройки любого плагина называли место одинаково.
//
// Новый слот = запись в файле своей области и строка импорта здесь.
import type { ProviderSlots } from './providerSlots.ts';
import { PROVIDER_SLOT_LABELS } from './providerSlots.ts';

export type PluginSlotContexts = ProviderSlots;

export type PluginSlotName = keyof PluginSlotContexts;

export const PLUGIN_SLOT_LABELS: Record<PluginSlotName, string> = {
  ...PROVIDER_SLOT_LABELS,
};

export const PLUGIN_SLOT_NAMES = Object.keys(PLUGIN_SLOT_LABELS) as PluginSlotName[];

export function isPluginSlotName(value: unknown): value is PluginSlotName {
  return typeof value === 'string' && Object.hasOwn(PLUGIN_SLOT_LABELS, value);
}
