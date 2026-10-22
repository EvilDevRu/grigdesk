// Контракт раздела «Исполнители» в том объёме, который уже кому-то нужен.
//
// Полная карточка исполнителя большая и принадлежит своему разделу; здесь объявлено
// ровно то, что читают соседи. Расширяется этот же файл — второй копии формы реестра
// в проекте быть не должно.

import { contractDecoders } from '../lib/contractDecoders.ts';
import type { InTurnCapability } from './chatInTurnContracts.ts';
import type { JsonValue } from './providerSettingsContracts.ts';

export interface ProviderSettingEntry {
  id: string;
  kind: 'toggle' | 'text' | 'number' | 'range';
  label: string;
  value: JsonValue;
  hint?: string;
  disabled?: boolean;
  note?: string;
  min?: number;
  max?: number;
  step?: number;
  confirm?: Partial<Record<'on' | 'off', {
    text: string;
    label?: string;
    danger?: boolean;
  }>>;
}

export interface ProviderCredentialEntry {
  env: string;
  kind: 'secret' | 'choice';
  label: string;
  hint?: string;
  options?: Array<{
    value: string;
    label: string;
    hint?: string;
  }>;
  when?: { env: string; value: string };
  set: boolean;
  inFile: boolean | null;
  preview?: string;
  value: string | null;
}

// Модель реестра в том объёме, в каком её читают соседние разделы при выборе.
// `extra` — старая версия семейства: в кратком списке её не показывают.
export interface ProviderModelEntry {
  id: string;
  name: string;
  extra?: boolean;
  unknown?: boolean;
  hidden?: boolean;
  aliases?: string[];
  modelRefAliases?: string[];
  family?: string;
  efforts?: string[];
  effortHints?: Record<string, string>;
  context?: number;
  contextRuntimeOnly?: boolean;
  contextUnverified?: boolean;
}

// Исполнитель реестра: доступность решает, можно ли его выбрать, а возможности —
// подходит ли он настройке, которая требует, например, безопасного разбора текста.
export interface ProviderEntry {
  sessionBinding?: boolean;
  commands?: Array<{
    cmd: string;
    desc?: string;
    run?: string;
    args?: boolean | string;
    hint?: string;
  }>;
  id: string;
  name: string;
  available?: boolean;
  type?: string;
  vendor?: string;
  color?: string;
  latest?: string;
  statusPage?: string;
  kind?: string;
  installed?: boolean;
  mcp?: boolean;
  chatEnabled?: boolean;
  modes?: Array<{
    id: string;
    label: string;
    hint?: string;
  }>;
  canUpdate?: boolean;
  updateAvailable?: boolean;
  version?: string;
  auth?: string;
  authLabel?: string;
  setupCommand?: string;
  install?: string;
  distribution?: {
    label?: string;
    ready: boolean;
    authHint?: string;
    problem?: { message: string; command?: string };
  };
  settingsCatalog?: boolean;
  settings?: ProviderSettingEntry[];
  credentials?: ProviderCredentialEntry[];
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
