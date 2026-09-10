// Контракт раздела «Исполнители» в том объёме, который уже кому-то нужен.
//
// Полная карточка исполнителя большая и принадлежит своему разделу; здесь объявлено
// ровно то, что читают соседи. Расширяется этот же файл — второй копии формы реестра
// в проекте быть не должно.

import { contractDecoders } from './contractDecoders.ts';

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
