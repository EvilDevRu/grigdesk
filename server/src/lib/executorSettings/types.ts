// Внутренние контракты хранят приватные схемы и payload отдельно от каталога.
// Подготовленный снимок передаётся только чатовым путём запуска.

import type {
  JsonValue,
  ProviderSettingNode,
  SettingsSource,
  SettingsConsumer,
  ProviderSettingsCatalog,
} from '../../../../shared/chat/providerSettingsContracts.ts';

// Opaque handle живёт только внутри серверного хода и не входит в JSON-контракт.
// Содержимое и принадлежность проверяет адаптер, создавший handle.
export type PreparedExecutorRuntime = object;

export interface NativeSettingsContext {
  providerId: string;
  binaryIdentity: string;
  runtimeIdentity?: string;
  buildId?: string;
  profileFingerprint: string;
  transport: string;
  mode: string;
  cwdRealpath: string;
  consumer?: SettingsConsumer;
}

export interface NativeSettingsWriteChannel {
  id: string;
  scope: 'grigdesk-chats' | 'grigdesk-chats-and-pipelines';
  state: 'verified' | 'unsupported' | 'unverified';
  reason?: string;
}

export interface NativeSettingsOwnership {
  path: string[];
  owner: string;
  reason: string;
  secret?: boolean;
}

export interface NativeSettingsArea {
  path: string[];
  format: 'json-schema' | 'schemastery';
  dialect: string;
  schema: unknown;
  coverage: 'complete' | 'partial';
  writeChannel: NativeSettingsWriteChannel;
  base?: JsonValue;
}

export interface NativeSettingsSnapshot {
  context: NativeSettingsContext;
  generation: string;
  source: SettingsSource;
  areas: NativeSettingsArea[];
  ownership: NativeSettingsOwnership[];
  scope?: ProviderSettingsCatalog['scope'];
  normalizedFields?: NormalizedSettingNode[];
  consumerFields?: Partial<Record<SettingsConsumer, NormalizedSettingNode[]>>;
}

export interface NativeSettingsOverride {
  path: string[];
  value: JsonValue;
}

export interface NativeSettingsStorage {
  format: 1;
  revision: number;
  overrides: Record<string, NativeSettingsOverride>;
}

export interface AcceptedNativeSetting extends NativeSettingsOverride {
  fieldId: string;
  channelId: string;
}

export interface PreparedNativeSettings {
  providerId: string;
  contextFingerprint: string;
  runtimeIdentity?: string;
  schemaRevision: string;
  storageRevision: string;
  fingerprint: string;
  accepted: readonly AcceptedNativeSetting[];
  payload: JsonValue;
}

export interface NativeSettingsReadback {
  fieldId: string;
  basis: 'accepted' | 'effective' | 'applied' | 'unavailable';
  value?: JsonValue;
  rejected?: boolean;
}

export interface NativeSettingsEvidence {
  fieldId: string;
  fingerprint: string;
  result: 'sent' | 'confirmed' | 'overridden' | 'rejected' | 'unknown';
  reason: string;
}

export interface NativeSettingsCapability {
  consumers?: readonly SettingsConsumer[];
  context?: (
    config: unknown,
    cwd: string,
    consumer?: SettingsConsumer,
    preparedRuntime?: PreparedExecutorRuntime,
  ) => NativeSettingsContext | Promise<NativeSettingsContext>;
  discover: (
    context: NativeSettingsContext,
    options: { signal: AbortSignal; refresh: boolean },
  ) => Promise<NativeSettingsSnapshot>;
  prepare: (
    context: NativeSettingsContext,
    snapshot: NativeSettingsSnapshot,
    overrides: readonly AcceptedNativeSetting[],
    options: { signal: AbortSignal },
  ) => Promise<PreparedNativeSettings>;
  verify: (
    plan: PreparedNativeSettings,
    readback: readonly NativeSettingsReadback[],
  ) => NativeSettingsEvidence[];
}

export interface NormalizedSettingNode extends ProviderSettingNode {
  channelId: string;
  secret: boolean;
  schema: Record<string, unknown>;
  ancestors?: {
    path: string[];
    schema: Record<string, unknown>;
    base?: JsonValue;
  }[];
  children?: NormalizedSettingNode[];
  items?: NormalizedSettingNode;
}
