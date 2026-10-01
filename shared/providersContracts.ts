// Контракт раздела «Исполнители» в том объёме, который уже кому-то нужен.
//
// Полная карточка исполнителя большая и принадлежит своему разделу; здесь объявлено
// ровно то, что читают соседи. Расширяется этот же файл — второй копии формы реестра
// в проекте быть не должно.

import { contractDecoders } from './contractDecoders.ts';
import type { InTurnCapability } from './chatInTurnContracts.ts';

// Модель реестра в том объёме, в каком её читают соседние разделы при выборе.
// `extra` — старая версия семейства: в кратком списке её не показывают.
export interface ProviderModelEntry {
  id: string;
  name: string;
  extra?: boolean;
  efforts?: string[];
}

// Исполнитель реестра: доступность решает, можно ли его выбрать, а возможности —
// подходит ли он настройке, которая требует, например, безопасного разбора текста.
export interface ProviderEntry {
  id: string;
  name: string;
  available?: boolean;
  settingsCatalog?: boolean;
  models?: ProviderModelEntry[];
  capabilities?: Record<string, boolean>;
  // Канал ввода в активный ход: подробный контракт отдельным полем, а не boolean-флагом.
  inTurn?: InTurnCapability;
}

export class ProvidersContractError extends Error {
  constructor(path: string) {
    super(`Некорректный ответ реестра исполнителей: поле ${path}`);
    this.name = 'ProvidersContractError';
  }
}

const {
  listOf,
  objectOf,
  optional,
  text,
} = contractDecoders((path) => {
  throw new ProvidersContractError(path);
});

// Ступени усилия объявляет сам CLI, поэтому список свободный: ни один раздел не имеет
// права перечислять их сам — иначе новая ступень исполнителя пропадёт из выбора.
const effortModel = objectOf({ efforts: optional(listOf(text)) });
const effortProvider = objectOf({ models: optional(listOf(effortModel)) });
const effortRegistry = objectOf({ providers: listOf(effortProvider) });

/**
 * Все ступени усилия, известные установленным исполнителям, без повторов. Какая из
 * них применится к этапу — решает политика профиля, поэтому объединение честнее,
 * чем список одного исполнителя.
 */
export function parseProviderEfforts(value: unknown): string[] {
  const registry = effortRegistry(value, 'providers');
  const efforts = registry.providers
    .flatMap((provider) => provider.models ?? [])
    .flatMap((model) => model.efforts ?? []);

  return [...new Set(efforts)];
}
