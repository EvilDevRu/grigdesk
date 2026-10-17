// Слоты области исполнителей: места, куда плагин может встать рядом с их состоянием.
// Область владеет своими слотами сама — имя, контекст и подпись для настроек живут
// здесь, а не в общем списке; пространство имён `provider.*` называет хозяина.
export interface ProviderSlots {
  // Всплывашка исполнителя в топбаре, сразу под полосами лимитов.
  'provider.popover.after-bars': { providerId: string };
}

export const PROVIDER_SLOT_LABELS: Record<keyof ProviderSlots, string> = {
  'provider.popover.after-bars': 'Всплывашка исполнителя в топбаре, под полосами лимитов',
};
