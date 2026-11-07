// Состав полей задаёт схема источника, а право записи — проверенный канал.
// Нормализатор не знает имён исполнителей и их нативных ключей.

import { recordOrEmpty } from '../../../../shared/lib/objects.ts';

import { decodeSettingsJson } from '../../../../shared/chat/providerSettingsContracts.ts';
import type {
  JsonValue,
  SettingsConstraints,
  SettingsFieldKind,
  SettingsValueSlot,
} from '../../../../shared/chat/providerSettingsContracts.ts';
import type { NativeSettingsOwnership, NativeSettingsWriteChannel, NormalizedSettingNode } from './types.ts';
import { canonicalSettingsJson } from './fingerprint.ts';

export interface JsonSchemaOptions {
  path: string[];
  writeChannel: NativeSettingsWriteChannel;
  ownership: NativeSettingsOwnership[];
  base?: JsonValue;
  dialect?: string;
}

export const SETTINGS_SCHEMA_LIMITS = {
  depth: 24,
  nodes: 5000,
  bytes: 2_097_152,
};

const METADATA_KEYS = ['title', 'description', 'default', 'examples', '$id', '$schema', '$comment'];
const CONSTRAINT_KEYS = [
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
];
const SCALAR_KEYS = new Set([
  ...METADATA_KEYS,
  ...CONSTRAINT_KEYS,
  'type',
  'enum',
  'const',
  'readOnly',
  'writeOnly',
]);
const OBJECT_KEYS = new Set([
  ...SCALAR_KEYS,
  'properties',
  'required',
  'additionalProperties',
  '$defs',
  'definitions',
]);
const ARRAY_KEYS = new Set([...SCALAR_KEYS, 'items']);

/**
 * Раскрываются только локальные ссылки; чужой URL никогда не вызывает fetch.
 * Цикл и неоднозначное сочетание ограничений закрывают отдельную ветку.
 */
function resolveSchema(
  raw: unknown,
  root: Record<string, unknown>,
  visited = new Set<string>(),
): Record<string, unknown> {
  const schema = recordOrEmpty(raw);

  if (visited.size > SETTINGS_SCHEMA_LIMITS.depth) {
    return {};
  }

  if (schema.$ref === undefined) {
    return simplifyUnion(schema, root, visited);
  }

  const reference = schema.$ref;

  if (typeof reference !== 'string' || !reference.startsWith('#/') || visited.has(reference)) {
    return {};
  }

  const segments = reference
    .slice(2)
    .split('/')
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
  let target: unknown = root;

  for (const segment of segments) {
    const current = recordOrEmpty(target);

    if (!Object.hasOwn(current, segment) || ['__proto__', 'prototype', 'constructor'].includes(segment)) {
      return {};
    }

    target = current[segment];
  }

  const resolved = resolveSchema(target, root, new Set([...visited, reference]));
  const { $ref: _reference, ...siblings } = schema;
  const conflict = Object.entries(siblings).some(
    ([key, value]) =>
      !METADATA_KEYS.includes(key) &&
      Object.hasOwn(resolved, key) &&
      canonicalSettingsJson(resolved[key]) !== canonicalSettingsJson(value),
  );

  return conflict ? {} : simplifyUnion({ ...resolved, ...siblings }, root, visited);
}

/**
 * Поддерживаются только доказуемо однозначные scalar nullable и список констант.
 * Остальные объединения сохраняют свой keyword, который закрывает запись ветки.
 */
function simplifyUnion(
  schema: Record<string, unknown>,
  root: Record<string, unknown>,
  visited: Set<string>,
): Record<string, unknown> {
  const variants = schema.anyOf ?? schema.oneOf;

  if (!Array.isArray(variants) || (schema.anyOf && schema.oneOf)) {
    return schema;
  }

  const choices = variants.map((item) => resolveSchema(item, root, visited));
  const { anyOf: _anyOf, oneOf: _oneOf, ...siblings } = schema;
  const constants = choices.map((item) => item.const);
  const constantType = typeof constants[0];

  const simpleConstants = choices.every(
    (item) =>
      Object.hasOwn(item, 'const') &&
      Object.keys(item).every((key) => ['const', 'type', ...METADATA_KEYS].includes(key)) &&
      (item.type === undefined ||
        item.type === (item.const === null ? 'null' : typeof item.const) ||
        (item.type === 'integer' && Number.isInteger(item.const))),
  );

  if (
    choices.length > 0 &&
    simpleConstants &&
    constants.every(
      (value) => typeof value === constantType && (value === null || typeof value !== 'object'),
    ) &&
    new Set(constants.map((value) => canonicalSettingsJson(value))).size === constants.length
  ) {
    return { ...siblings, enum: constants };
  }

  const nulls = choices.filter((item) => item.type === 'null' && Object.keys(item).length === 1);
  const scalar = choices.find((item) =>
    ['boolean', 'string', 'number', 'integer'].includes(String(item.type)),
  );

  const conflictingSibling =
    scalar &&
    Object.entries(siblings).some(
      ([key, value]) =>
        key === 'type' ||
        (!METADATA_KEYS.includes(key) &&
          Object.hasOwn(scalar, key) &&
          canonicalSettingsJson(scalar[key]) !== canonicalSettingsJson(value)),
    );

  if (choices.length === 2 && nulls.length === 1 && scalar && !conflictingSibling) {
    return {
      ...scalar,
      ...siblings,
      type: [scalar.type, 'null'],
    };
  }

  return schema;
}

/**
 * Наличие значения проверяется явно: false, ноль и null не становятся unknown.
 * Неизвестное поле не раскрывает сырой объект конфигурации.
 */
function valueSlot(
  value: unknown,
  known: boolean,
  kind: SettingsFieldKind,
  secret: boolean,
): SettingsValueSlot {
  if (secret) {
    return { state: 'redacted', present: known };
  }

  if (!known || kind === 'unknown' || kind === 'object') {
    return { state: 'unknown' };
  }

  try {
    return { state: 'known', value: decodeSettingsJson(value) };
  } catch {
    return { state: 'unknown' };
  }
}

/**
 * Ограничения сериализуются без потери нулевых границ.
 * Enum сохраняет исходные JSON-типы и не выводится из текущего native value.
 */
function scalarShape(
  schema: Record<string, unknown>,
  options: JsonSchemaOptions,
): { kind: SettingsFieldKind; constraints: SettingsConstraints } {
  const constraints: SettingsConstraints = {};
  let rawType = schema.type;

  if (Array.isArray(rawType) && rawType.length === 2 && rawType.includes('null')) {
    constraints.nullable = true;
    rawType = rawType.find((item) => item !== 'null');
  }

  for (const key of CONSTRAINT_KEYS) {
    if (typeof schema[key] === 'number') {
      Object.assign(constraints, { [key]: schema[key] });
    }
  }

  if (options.dialect === 'schemastery' && typeof schema['x-grigdesk-step'] === 'number') {
    constraints.step = schema['x-grigdesk-step'];
    constraints.stepOrigin = typeof schema.minimum === 'number' ? schema.minimum : 0;
  }

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    constraints.enum = schema.enum.map(decodeSettingsJson);
  } else if (Object.hasOwn(schema, 'const')) {
    constraints.enum = [decodeSettingsJson(schema.const)];
  }

  const types = ['boolean', 'string', 'number', 'integer', 'object', 'array'];
  const primitiveEnum = constraints.enum?.every((value) => value === null || typeof value !== 'object');
  const kind: SettingsFieldKind = constraints.enum
    ? primitiveEnum
      ? 'enum'
      : 'unknown'
    : types.includes(String(rawType))
      ? (rawType as SettingsFieldKind)
      : 'unknown';

  return { kind, constraints };
}

/**
 * OpenAPI 3.0 задаёт исключающие границы boolean-флагами и допускает nullable.
 * В JSON Schema такие формы не теряют ограничение молча: ветка закрывается для записи.
 */
function normalizeDialect(
  source: Record<string, unknown>,
  dialect: string | undefined,
): Record<string, unknown> {
  const schema = { ...source };
  const openApi = dialect === 'openapi-3.0';

  if (
    dialect !== undefined &&
    !['draft-07', '2020-12', 'openapi-3.0', 'openapi-3.1', 'schemastery'].includes(dialect)
  ) {
    schema['unsupported-dialect-constraint'] = true;
  }

  for (const [exclusive, inclusive] of [
    ['exclusiveMinimum', 'minimum'],
    ['exclusiveMaximum', 'maximum'],
  ] as const) {
    if (typeof schema[exclusive] !== 'boolean') {
      if (openApi && Object.hasOwn(schema, exclusive)) {
        schema['unsupported-dialect-constraint'] = true;
      }

      continue;
    }

    if (!openApi || (schema[exclusive] && typeof schema[inclusive] !== 'number')) {
      schema['unsupported-dialect-constraint'] = true;
      continue;
    }

    if (schema[exclusive]) {
      schema[exclusive] = schema[inclusive];
    } else {
      delete schema[exclusive];
    }
  }

  if (openApi && typeof schema.nullable === 'boolean') {
    if (schema.nullable && typeof schema.type === 'string') {
      schema.type = [schema.type, 'null'];
    } else if (schema.nullable) {
      schema['unsupported-dialect-constraint'] = true;
    }

    delete schema.nullable;
  }

  for (const key of CONSTRAINT_KEYS) {
    if (!Object.hasOwn(schema, key)) {
      continue;
    }

    const value = schema[key];
    const length = ['minLength', 'maxLength', 'minItems', 'maxItems'].includes(key);

    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      (length && (!Number.isSafeInteger(value) || value < 0)) ||
      (key === 'multipleOf' && value <= 0)
    ) {
      schema['unsupported-dialect-constraint'] = true;
    }
  }

  if (Object.hasOwn(schema, 'enum') && (!Array.isArray(schema.enum) || schema.enum.length === 0)) {
    schema['unsupported-dialect-constraint'] = true;
  }

  return schema;
}

/**
 * Схема перечисляет поля, отсутствующие в текущем конфиге.
 * Значения не используются для угадывания вида редактора.
 */
export function normalizeJsonSchema(schema: unknown, options: JsonSchemaOptions): NormalizedSettingNode[] {
  if (JSON.stringify(schema).length > SETTINGS_SCHEMA_LIMITS.bytes) {
    throw new Error('Схема настроек превышает допустимый объём');
  }

  const root = recordOrEmpty(schema);
  const normalized = normalizeNode(root, root, options.path, options, options.base, [], false, false, {
    remaining: 5000,
  });

  return normalized.kind === 'object' ? (normalized.children ?? []) : [normalized];
}

/**
 * Запрет самого object-контрола не закрывает типизированные листья группы.
 * Политика и неподдержанное условие предка, напротив, наследуются всеми детьми.
 */
function normalizeNode(
  raw: unknown,
  root: Record<string, unknown>,
  path: string[],
  options: JsonSchemaOptions,
  base: unknown,
  ancestors: NonNullable<NormalizedSettingNode['ancestors']>,
  parentBlocked: boolean,
  parentSecret: boolean,
  budget: { remaining: number },
): NormalizedSettingNode {
  budget.remaining -= 1;

  const limited = path.length - options.path.length > SETTINGS_SCHEMA_LIMITS.depth || budget.remaining < 0;

  if (limited) {
    return {
      id: JSON.stringify(path),
      path,
      label: path.at(-1) ?? 'Настройки',
      kind: 'unknown',
      writable: false,
      reason: 'Ветка превышает предел сложности схемы',
      constraints: {},
      channelId: options.writeChannel.id,
      secret: parentSecret,
      schema: {},
      default: { state: 'unknown' },
      base: { state: 'unknown' },
      override: { state: 'unset' },
    };
  }

  const schema = normalizeDialect(resolveSchema(raw, root), options.dialect);
  const shape = scalarShape(schema, options);
  const owner = options.ownership.find((policy) => policy.path.every((part, index) => path[index] === part));
  const declaredSecret = options.ownership.some((policy) =>
    policy.secret === true && policy.path.every((part, index) => path[index] === part));
  const secret = parentSecret || declaredSecret || schema.writeOnly === true;
  const keys = shape.kind === 'object' ? OBJECT_KEYS : shape.kind === 'array' ? ARRAY_KEYS : SCALAR_KEYS;
  const unsupported = Object.keys(schema).some(
    (keyword) => !keys.has(keyword) && !(options.dialect === 'schemastery' && keyword === 'x-grigdesk-step'),
  );
  const unsafePath = path.some((part) => ['__proto__', 'prototype', 'constructor'].includes(part));
  const missingBase = Array.isArray(schema.required) && schema.required.length > 0 && base === undefined;
  const blocked =
    parentBlocked ||
    unsupported ||
    unsafePath ||
    missingBase ||
    Boolean(owner) ||
    secret ||
    schema.readOnly === true;
  const writable =
    !blocked &&
    !['object', 'array', 'unknown'].includes(shape.kind) &&
    options.writeChannel.state === 'verified';
  const reason =
    owner?.reason ??
    (unsupported || parentBlocked
      ? 'Ограничение схемы не поддерживается'
      : missingBase
        ? 'Для проверки требуется неизвестное базовое значение'
        : shape.kind === 'object'
          ? 'Изменяйте отдельные поля группы'
          : (options.writeChannel.reason ?? 'Запись поля не подтверждена'));
  const node: NormalizedSettingNode = {
    id: JSON.stringify(path),
    path,
    label: typeof schema.title === 'string' ? schema.title : (path.at(-1) ?? 'Настройки'),
    ...(typeof schema.description === 'string' ? { description: schema.description } : {}),
    kind: shape.kind,
    constraints: shape.constraints,
    writable,
    ...(!writable ? { reason } : {}),
    ...(owner ? { owner: owner.owner } : {}),
    channelId: options.writeChannel.id,
    secret,
    schema,
    ancestors,
    default: valueSlot(
      schema.default,
      Object.hasOwn(schema, 'default'),
      shape.kind === 'array' ? 'unknown' : shape.kind,
      secret,
    ),
    base: valueSlot(base, base !== undefined, shape.kind === 'array' ? 'unknown' : shape.kind, secret),
    override: { state: 'unset' },
  };

  if (shape.kind === 'object' || schema.properties) {
    const properties = { ...recordOrEmpty(schema.properties) };
    const baseObject = recordOrEmpty(base);

    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      for (const key of Object.keys(baseObject)) {
        if (!Object.hasOwn(properties, key)) {
          Object.defineProperty(properties, key, { value: schema.additionalProperties, enumerable: true });
        }
      }
    }

    const nextAncestors = [
      ...ancestors,
      {
        path,
        schema,
        ...(base !== undefined ? { base: decodeSettingsJson(base) } : {}),
      },
    ];

    node.children = Object.entries(properties)
      .slice(0, Math.max(1, budget.remaining + 1))
      .map(([key, child]) =>
        normalizeNode(
          child,
          root,
          [...path, key],
          options,
          baseObject[key],
          nextAncestors,
          blocked,
          secret,
          budget,
        ),
      );
  }

  if (shape.kind === 'array' && !Array.isArray(schema.items) && schema.items !== undefined) {
    const item = normalizeNode(
      schema.items,
      root,
      [...path, '*'],
      options,
      undefined,
      [],
      blocked,
      secret,
      budget,
    );
    const simple = !['object', 'array', 'unknown'].includes(item.kind) && item.writable && !item.secret;
    const protectedChild = options.ownership.some(
      (policy) =>
        policy.path.length > path.length && path.every((part, index) => policy.path[index] === part),
    );

    node.items = item;
    node.writable = !blocked && simple && !protectedChild;

    if (node.writable) {
      delete node.reason;
      node.default = valueSlot(schema.default, Object.hasOwn(schema, 'default'), 'array', false);
      node.base = valueSlot(base, base !== undefined, 'array', false);
    } else {
      node.reason = 'Для сложного или защищённого массива редактор недоступен';
    }
  }

  return node;
}
