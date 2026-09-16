// Реестр размещений: какой плагин каким компонентом встаёт в какой слот. Записи —
// статика, сделанная при загрузке (системные плагины регистрируются из своих
// `web/src/plugins/<id>/index.ts`); включён ли плагин и само размещение, решает
// `<PluginSlot>` по стору плагинов в момент отрисовки, поэтому тумблер действует сразу.
import type { Component } from 'vue';

import type { PluginSlotName } from '../../../shared/slots/index.ts';

export interface PluginPlacement {
  pluginId: string;
  slot: PluginSlotName;
  component: Component;
  // Порядок среди соседей по слоту; при равенстве — по id плагина.
  order?: number;
}

const placements = new Map<PluginSlotName, PluginPlacement[]>();

/**
 * Регистрация размещения. Повтор той же пары «плагин + слот» заменяет прежнюю запись,
 * а не дублирует её: горячая перезагрузка модуля не должна размножать компонент.
 * Возвращает отмену — для тестов и будущей выгрузки пользовательских плагинов.
 */
export function registerPlacement(placement: PluginPlacement): () => void {
  const list = (placements.get(placement.slot) ?? []).filter((item) => item.pluginId !== placement.pluginId);

  list.push(placement);
  placements.set(placement.slot, list);

  return () => {
    const current = placements.get(placement.slot) ?? [];

    placements.set(placement.slot, current.filter((item) => item !== placement));
  };
}

// Размещения слота в порядке показа: по `order`, затем по id плагина — чтобы порядок
// был полным и два плагина с одним `order` не менялись местами между отрисовками.
export function placementsOf(slot: PluginSlotName): PluginPlacement[] {
  return [...(placements.get(slot) ?? [])].sort((a, b) => (
    (a.order ?? 100) - (b.order ?? 100) || a.pluginId.localeCompare(b.pluginId, 'ru')
  ));
}

// Очистка реестра — для тестов, где каждый случай собирает свой набор размещений.
// В приложении реестр живёт от загрузки до закрытия вкладки.
export function resetPlacements(): void {
  placements.clear();
}
