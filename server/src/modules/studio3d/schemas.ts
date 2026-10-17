// Схемы входов закрыты и ограничены; тело запроса не приводится к другому типу.
// Числа query приводятся отдельно, как у обычной HTTP-пагинации.
import { Ajv } from 'ajv';
import type { AnySchema } from 'ajv';
import type { FastifyInstance } from 'fastify';

export type InputSchema = Record<string, unknown>;

export const uuid = {
  type: 'string',
  maxLength: 36,
  pattern: '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[1-8][a-fA-F0-9]{3}-[89abAB][a-fA-F0-9]{3}-[a-fA-F0-9]{12}$'
};
export const id = {
  type: 'string',
  minLength: 1,
  maxLength: 128,
  pattern: '^[A-Za-z0-9][A-Za-z0-9_-]*$'
};
export const fileName = {
  type: 'string',
  minLength: 1,
  maxLength: 200,
  pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$'
};
export const amount = {
  type: 'number',
  minimum: 0,
  maximum: 1e12
};
export const flag = { type: 'boolean' };

/**
 * Каждая строка имеет предел до JSON обработки и filesystem эффектов.
 * Пустые optional поля разрешаются явно, обязательные используют minLength.
 */
export function text(maxLength = 4096, minLength = 0): InputSchema {
  return {
    type: 'string',
    minLength,
    maxLength
  };
}

// Внешнее имя ограничено по длине; разделители и скрытые имена проверяет файловая операция.
// Внутренние ручки файлов и viewer продолжают использовать латинскую fileName.
export const externalFileName = text(200, 1);

/**
 * Object schema отвергает неизвестные поля, вместо тихого удаления AJV.
 * Размер map также ограничен, чтобы bounded значения не дали бесконечный объект.
 */
export function object(properties: Record<string, InputSchema> = {}, required: string[] = []): InputSchema {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
    maxProperties: 64
  };
}

export const category = { anyOf: [
  { type: 'null' }, { type: 'string', enum: ['character', 'prop', 'part', 'scene'] },
] };
export const project = { anyOf: [{ type: 'null' }, id] };
export const values: InputSchema = {
  type: 'object',
  maxProperties: 64,
  propertyNames: {
    type: 'string',
    maxLength: 64,
    pattern: '^[A-Za-z0-9_-]+$'
  },
  additionalProperties: {
    anyOf: [
      text(16384), {
        type: 'number',
        minimum: -1e12,
        maximum: 1e12
      }, flag, { type: 'null' },
      {
        type: 'array',
        maxItems: 128,
        items: text(256)
      },
      {
        type: 'array',
        maxItems: 4,
        items: object({
        view: { type: 'string', enum: ['front', 'left', 'back', 'right'] }, prompt: text(4096),
      }, ['view', 'prompt'])
      },
    ],
  }
};
export const uploads = {
  type: 'array',
  maxItems: 4,
  items: object({
    role: { type: 'string', enum: ['primary', 'front', 'left', 'back', 'right'] }, uploadId: uuid,
  }, ['role', 'uploadId'])
};
export const input = {
  modelId: id,
  versionId: id,
  uploads
};
export const runProperties = {
  libraryId: uuid,
  idempotencyKey: uuid,
  provider: id,
  operation: id,
  values,
  expectedPrice: amount,
  ...input,
  name: text(200, 1),
  project,
  category
};
export const batchRow = object({
  provider: id,
  operation: id,
  values,
  name: text(200, 1),
  project,
  category,
  expectedPrice: amount
}, ['provider', 'operation', 'values', 'name', 'project', 'category', 'expectedPrice']);
export const rows = {
  type: 'array',
  minItems: 1,
  maxItems: 50,
  items: batchRow
};
export const snapshot = object({
  libraryId: uuid,
  rows,
  catalogVersion: text(10000, 1),
  totalEstimated: amount,
  unit: { anyOf: [{ type: 'null' }, object({
    one: text(128, 1),
    few: text(128, 1),
    many: text(128, 1)
  }, ['one', 'few', 'many'])] }
}, ['libraryId', 'rows', 'catalogVersion', 'totalEstimated', 'unit']);
export const withLibrary = (properties: Record<string, InputSchema> = {}, required: string[] = []) =>
  object({ libraryId: uuid, ...properties }, ['libraryId', ...required]);

/**
 * Только query допускает HTTP string→number. JSON тела сохраняют точные типы.
 * Обе проверки оставляют неизвестные поля видимыми и отклоняют их схемой.
 */
export function installStudioValidation(server: FastifyInstance): void {
  const strict = new Ajv({
    removeAdditional: false,
    coerceTypes: false,
    allErrors: false
  });
  const query = new Ajv({
    removeAdditional: false,
    coerceTypes: true,
    allErrors: false
  });

  server.setValidatorCompiler(({ schema, httpPart }) =>
    (httpPart === 'querystring' ? query : strict).compile(schema as AnySchema));
}
