// Нативные настройки используют собственный wire-контракт: сохранение выбора
// и подтверждение применения конкретной сессией имеют разную семантику.

import { contractDecoders } from './contractDecoders.ts';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type SettingsValueSlot =
  | { state: 'known'; value: JsonValue }
  | { state: 'unset' | 'unknown' }
  | { state: 'redacted'; present?: boolean };

export type SettingsFieldKind =
  | 'boolean'
  | 'string'
  | 'number'
  | 'integer'
  | 'enum'
  | 'object'
  | 'array'
  | 'unknown';

export interface SettingsConstraints {
  nullable?: boolean;
  enum?: JsonValue[];
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  step?: number;
  stepOrigin?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  required?: string[];
}

export interface ProviderSettingNode {
  id: string;
  path: string[];
  label: string;
  description?: string;
  kind: SettingsFieldKind;
  constraints: SettingsConstraints;
  writable: boolean;
  reason?: string;
  owner?: string;
  children?: ProviderSettingNode[];
  items?: ProviderSettingNode;
  default: SettingsValueSlot;
  base: SettingsValueSlot;
  override: SettingsValueSlot;
}

export interface SettingsSource {
  kind: string;
  version: string | null;
  checkedAt: number;
  coverage: { path: string[]; coverage: 'complete' | 'partial' }[];
}

export interface ProviderSettingsCatalog {
  protocolVersion: 1;
  providerId: string;
  state: 'ready' | 'partial' | 'stale' | 'unavailable';
  scope: { id: 'cockpit-chats'; label: string };
  source: SettingsSource;
  schemaRevision: string | null;
  revision: string;
  fields: ProviderSettingNode[];
  inactiveOverrides: {
    id: string;
    path: string[];
    label: string;
    reason: string;
  }[];
  message?: string;
}

export type ProviderSettingsOverrideRequest = {
  fieldId: string;
  revision: string;
} & (
  | {
      operation: 'set';
      schemaRevision: string;
      value: JsonValue;
    }
  | { operation: 'unset'; schemaRevision: string | null }
);

export interface ProviderSettingsOverrideResponse {
  ok: true;
  changed: boolean;
  catalog: ProviderSettingsCatalog;
}

export class ProviderSettingsContractError extends Error {
  constructor(path: string) {
    super(`Некорректный контракт нативных настроек: ${path}`);
    this.name = 'ProviderSettingsContractError';
  }
}

const fail = (path: string): never => {
  throw new ProviderSettingsContractError(path);
};

const { record, text, numeric, boolean, listOf, oneOf, objectOf, nullable } = contractDecoders(fail);
const pathOf = listOf(text);
const sourceOf = objectOf({
  kind: text,
  version: nullable(text),
  checkedAt: numeric,
  coverage: listOf(objectOf({ path: pathOf, coverage: oneOf('complete', 'partial') })),
});
const inactiveOf = objectOf({
  id: text,
  path: pathOf,
  label: text,
  reason: text,
});

/**
 * JSON-значение проверяется без coercion и копируется в безопасный новый объект.
 * Глубина и объём ограничены также для произвольного входа, а не только JSON.parse.
 */
export function decodeSettingsJson(value: unknown): JsonValue {
  let remaining = 10_000;

  /**
   * Рекурсивный обход ограничивает глубину и число узлов до копирования значения.
   * Опасные ключи не создают свойств прототипа ни на одном уровне JSON.
   */
  function visit(item: unknown, depth: number): JsonValue {
    remaining -= 1;

    if (depth > 24 || remaining < 0) {
      return fail('json.limit');
    }

    if (item === null || typeof item === 'boolean' || typeof item === 'string') {
      return item;
    }

    if (typeof item === 'number' && Number.isFinite(item)) {
      return item;
    }

    if (Array.isArray(item)) {
      return item.map((child) => visit(child, depth + 1));
    }

    const source = record(item, 'json');
    const entries = Object.entries(source).map(([key, child]) => {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) {
        fail('json.key');
      }

      return [key, visit(child, depth + 1)];
    });

    return Object.fromEntries(entries) as { [key: string]: JsonValue };
  }

  const result = visit(value, 0);

  if (JSON.stringify(result).length > 262_144) {
    fail('json.size');
  }

  return result;
}

/**
 * Браузер адресует поле по id, а путь и канал разрешает сервер.
 * Set требует собственное value; unset не превращает null в удаление.
 */
export function decodeProviderSettingsOverrideRequest(value: unknown): ProviderSettingsOverrideRequest {
  const request = record(value, 'request');
  const operation = oneOf('set', 'unset')(request.operation, 'operation');
  const allowed = [
    'fieldId',
    'operation',
    'schemaRevision',
    'revision',
    ...(operation === 'set' ? ['value'] : []),
  ];

  if (
    Object.keys(request).some((key) => !allowed.includes(key)) ||
    typeof request.revision !== 'string' ||
    !/^(0|[1-9]\d*)$/.test(request.revision)
  ) {
    fail('request');
  }

  const fieldId = text(request.fieldId, 'fieldId');
  const revision = text(request.revision, 'revision');

  if (operation === 'unset') {
    return {
      fieldId,
      revision,
      operation,
      schemaRevision: nullable(text)(request.schemaRevision, 'schemaRevision'),
    };
  }

  if (!Object.hasOwn(request, 'value')) {
    fail('value');
  }

  return {
    fieldId,
    revision,
    operation,
    schemaRevision: text(request.schemaRevision, 'schemaRevision'),
    value: decodeSettingsJson(request.value),
  };
}

/**
 * Узлы реконструируются из проверенных полей, чтобы приватные данные источника
 * не пересекали границу. Незнакомый вид остаётся видимым без пути записи.
 */
function nodeOf(value: unknown, path: string, depth = 0, budget = { left: 5_000 }): ProviderSettingNode {
  budget.left -= 1;

  if (depth > 24 || budget.left < 0) {
    fail('fields.limit');
  }

  const node = record(value, path);
  const supported = ['boolean', 'string', 'number', 'integer', 'enum', 'object', 'array', 'unknown'];
  const kind = supported.includes(String(node.kind)) ? (node.kind as SettingsFieldKind) : 'unknown';
  const input = record(node.constraints, `${path}.constraints`);
  const constraints: SettingsConstraints = {};
  const numbers = [
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'multipleOf',
    'step',
    'stepOrigin',
    'minLength',
    'maxLength',
    'minItems',
    'maxItems',
  ] as const;

  for (const key of numbers) {
    if (Object.hasOwn(input, key)) {
      constraints[key] = numeric(input[key], `${path}.constraints.${key}`);
    }
  }

  if (Object.hasOwn(input, 'nullable')) {
    constraints.nullable = boolean(input.nullable, `${path}.constraints.nullable`);
  }

  if (Object.hasOwn(input, 'enum')) {
    constraints.enum = listOf((item) => decodeSettingsJson(item))(input.enum, `${path}.constraints.enum`);
  }

  if (Object.hasOwn(input, 'required')) {
    constraints.required = listOf(text)(input.required, `${path}.constraints.required`);
  }

  const unknownConstraint = Object.keys(input).some(
    (key) => ![...numbers, 'nullable', 'enum', 'required'].includes(key),
  );
  const child = (item: unknown, childPath: string) => nodeOf(item, childPath, depth + 1, budget);

  return {
    id: text(node.id, `${path}.id`),
    path: pathOf(node.path, `${path}.path`),
    label: text(node.label, `${path}.label`),
    kind,
    constraints,
    writable: boolean(node.writable, `${path}.writable`) && kind !== 'unknown' && !unknownConstraint,
    ...(node.description !== undefined ? { description: text(node.description, `${path}.description`) } : {}),
    ...(node.reason !== undefined ? { reason: text(node.reason, `${path}.reason`) } : {}),
    ...(node.owner !== undefined ? { owner: text(node.owner, `${path}.owner`) } : {}),
    ...(kind === 'unknown' ? { reason: 'Тип поля не поддерживается' } : {}),
    ...(unknownConstraint ? { reason: 'Ограничение поля не поддерживается' } : {}),
    ...(node.children !== undefined ? { children: listOf(child)(node.children, `${path}.children`) } : {}),
    ...(node.items !== undefined ? { items: child(node.items, `${path}.items`) } : {}),
    default: decodeSettingsValueSlot(node.default),
    base: decodeSettingsValueSlot(node.base),
    override: decodeSettingsValueSlot(node.override),
  };
}

/**
 * Каталог приходит с сервера, но проверяется также на границе клиента.
 * Пятый исполнитель использует тот же контракт, что любой установленный CLI.
 */
export function decodeProviderSettingsCatalog(value: unknown): ProviderSettingsCatalog {
  const catalog = record(value, 'catalog');
  const budget = { left: 5_000 };

  return {
    protocolVersion: oneOf(1)(catalog.protocolVersion, 'protocolVersion'),
    providerId: text(catalog.providerId, 'providerId'),
    state: oneOf('ready', 'partial', 'stale', 'unavailable')(catalog.state, 'state'),
    scope: objectOf({ id: oneOf('cockpit-chats'), label: text })(catalog.scope, 'scope'),
    source: sourceOf(catalog.source, 'source'),
    schemaRevision: nullable(text)(catalog.schemaRevision, 'schemaRevision'),
    revision: text(catalog.revision, 'revision'),
    fields: listOf((node, path) => nodeOf(node, path, 0, budget))(catalog.fields, 'fields'),
    inactiveOverrides: listOf(inactiveOf)(catalog.inactiveOverrides, 'inactiveOverrides'),
    ...(catalog.message !== undefined ? { message: text(catalog.message, 'message') } : {}),
  };
}

/**
 * Состояние значения не подменяется умолчанием схемы.
 * Декодер сохраняет явный false независимо от отсутствующего override.
 */
export function decodeSettingsValueSlot(value: unknown): SettingsValueSlot {
  const slot = record(value, 'slot');

  if (slot.state === 'known') {
    if (!Object.hasOwn(slot, 'value') || Object.keys(slot).some((key) => !['state', 'value'].includes(key))) {
      fail('slot.known');
    }

    return { state: 'known', value: decodeSettingsJson(slot.value) };
  }

  if (slot.state === 'redacted') {
    if (Object.keys(slot).some((key) => !['state', 'present'].includes(key))) {
      fail('slot.redacted');
    }

    return {
      state: 'redacted',
      ...(slot.present !== undefined ? { present: boolean(slot.present, 'slot.present') } : {}),
    };
  }

  if (Object.keys(slot).some((key) => key !== 'state')) {
    fail('slot');
  }

  return { state: oneOf('unset', 'unknown')(slot.state, 'slot.state') };
}
