// Schemastery сериализует граф uid/refs, поэтому значения не являются JSON Schema.
// После проверенного преобразования применяется тот же общий нормализатор и валидатор.

import { recordOrEmpty } from '../../../../shared/lib/objects.ts';

import { normalizeJsonSchema } from './jsonSchema.ts';
import type { JsonSchemaOptions } from './jsonSchema.ts';
import type { NormalizedSettingNode } from './types.ts';

/**
 * Meta — объявленный контейнер аннотаций Schemastery. Числовой step ограничивает
 * значение относительно min, а не является JSON Schema multipleOf от нуля.
 */
function convertNode(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'number') {
    return { $ref: `#/$defs/${raw}` };
  }

  const source = recordOrEmpty(raw);
  const meta = recordOrEmpty(source.meta);
  const result: Record<string, unknown> = {};
  const types = ['boolean', 'string', 'number', 'object', 'array'];

  if (types.includes(String(source.type))) {
    result.type = source.type;
  } else if (source.type === 'const') {
    result.const = source.value;
  } else if (source.type === 'union' && Array.isArray(source.list)) {
    result.anyOf = source.list.map(convertNode);
  } else if (source.type === 'dict') {
    result.type = 'object';
    result.additionalProperties = convertNode(source.inner);
  } else {
    result['unsupported-native-type'] = true;
  }

  if (source.type === 'object') {
    result.properties = Object.fromEntries(
      Object.entries(recordOrEmpty(source.dict)).map(([key, child]) => [key, convertNode(child)]),
    );
  }

  if (source.type === 'array') {
    result.items = convertNode(source.inner);
  }

  for (const [native, json] of [
    ['min', 'minimum'],
    ['max', 'maximum'],
    ['step', 'x-cockpit-step'],
  ] as const) {
    if (typeof meta[native] === 'number') {
      const key =
        source.type === 'string'
          ? native === 'min'
            ? 'minLength'
            : 'maxLength'
          : source.type === 'array'
            ? native === 'min'
              ? 'minItems'
              : 'maxItems'
            : json;

      result[key!] = meta[native];
    }
  }

  if (Object.hasOwn(meta, 'default')) {
    result.default = meta.default;
  }

  if (typeof meta.description === 'string') {
    result.description = meta.description;
  }

  if (meta.pattern !== undefined) {
    result.pattern = meta.pattern;
  }

  if (meta.disabled === true) {
    result.readOnly = true;
  }

  if (['secret', 'password'].includes(String(meta.role))) {
    result.writeOnly = true;
  }

  if (
    Object.keys(source).some(
      (key) => !['type', 'meta', 'dict', 'inner', 'list', 'value', 'sKey'].includes(key),
    )
  ) {
    result['unsupported-native-constraint'] = true;
  }

  return result;
}

/**
 * Преобразование сохраняет ограничения вместо угадывания формы по native value.
 * Непонятная конструкция останется видимой с запретом записи.
 */
export function normalizeSchemastery(schema: unknown, options: JsonSchemaOptions): NormalizedSettingNode[] {
  const serialized = recordOrEmpty(schema);
  const refs = recordOrEmpty(serialized.refs);
  const root = Object.hasOwn(serialized, 'uid') ? convertNode(serialized.uid) : convertNode(serialized);

  root.$defs = Object.fromEntries(Object.entries(refs).map(([uid, node]) => [uid, convertNode(node)]));

  return normalizeJsonSchema(root, { ...options, dialect: 'schemastery' });
}
