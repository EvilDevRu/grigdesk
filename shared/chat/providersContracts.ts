import type { ChatSpeed, ChatSpeedCapability } from './chatSpeed.ts';
import type { ProviderInstallationMetadata } from './providerInstallContracts.ts';
// Контракт раздела «Исполнители» в том объёме, который уже кому-то нужен.
//
// Полная карточка исполнителя большая и принадлежит своему разделу; здесь объявлено
// ровно то, что читают соседи. Расширяется этот же файл — второй копии формы реестра
// в проекте быть не должно.

import { contractDecoders } from '../lib/contractDecoders.ts';
import { isRecord } from '../lib/objects.ts';
import type { InTurnCapability } from './chatInTurnContracts.ts';
import type { JsonValue } from './providerSettingsContracts.ts';

export interface ProviderTurnTokens {
  inputTokens: number;
  outputTokens: number;
}

export interface ProviderUsagePresentation {
  freshness: boolean;
  spentLabel: boolean;
  subscriptionQuotaUnavailable?: boolean;
}

/**
 * Учитывает только измеренный непустой расход запроса. CLI может вернуть
 * пару нулей в ответе локальной команды, где обращения к модели не было.
 */
export function isProviderTurnTokens(value: unknown): value is ProviderTurnTokens {
  if (!isRecord(value)) {
    return false;
  }

  const { inputTokens, outputTokens } = value;

  return typeof inputTokens === 'number' && typeof outputTokens === 'number'
    && Number.isSafeInteger(inputTokens) && Number.isSafeInteger(outputTokens)
    && inputTokens >= 0 && outputTokens >= 0 && (inputTokens > 0 || outputTokens > 0);
}

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
// `extra` — старая версия семейства или нечат-модель: в кратком списке её не показывают,
// а нечат-модель (`nonChat`) скрыта и под «все модели».
export interface ProviderModelEntry {
  chatSpeedModes?: ChatSpeed[];
  id: string;
  name: string;
  extra?: boolean;
  unknown?: boolean;
  hidden?: boolean;
  nonChat?: boolean;
  nonChatReason?: string;
  createdAt?: string;
  firstSeen?: string;
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
  accessProfiles?: {
    supported: boolean;
    methods: import('./accessProfileContracts.ts').AccessMethod[];
    activeProfile: import('./accessProfileContracts.ts').AccessProfile | null;
  };
  chatSpeed?: ChatSpeedCapability;
  defaultPermissionMode?: string;
  permissionModeSelectionPolicy?: 'preserve-explicit';
  permissionModesRequiringExplicitSelection?: readonly string[];
  installation?: ProviderInstallationMetadata;
  usagePresentation?: ProviderUsagePresentation;
  sessionBinding?: boolean;
  commands?: Array<{
    cmd: string;
    desc?: string;
    run?: string;
    kind?: 'skill';
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
    labelKey?: string;
    hintKey?: string;
    persistAsDefault?: boolean;
    requiresExplicitSelection?: boolean;
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
    managed?: boolean;
    ready: boolean;
    canInstall?: boolean;
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
