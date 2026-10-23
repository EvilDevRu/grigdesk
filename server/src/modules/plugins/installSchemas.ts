import { PLUGIN_ID_RE } from '../../lib/pluginsRegistry.ts';

export type InstallSchema = Record<string, unknown>;

/**
 * Локальная схема сохраняет неизвестные поля до validation и отклоняет их.
 * Required задаётся для каждого endpoint, а JSON types никогда не приводятся.
 */
export function closedObject(
  properties: Record<string, InstallSchema> = {},
  required: string[] = [],
): InstallSchema {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
}

export const urlInput = {
  type: 'string',
  minLength: 1,
  maxLength: 512,
};
export const versionInput = {
  type: 'string',
  maxLength: 128,
  pattern: '^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$',
};
export const pluginIdInput = {
  type: 'string',
  maxLength: 41,
  pattern: PLUGIN_ID_RE.source,
  not: { enum: ['constructor', 'prototype', '__proto__'] },
};
export const uuidInput = {
  type: 'string',
  maxLength: 36,
  pattern: '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[1-8][a-fA-F0-9]{3}-[89abAB][a-fA-F0-9]{3}-[a-fA-F0-9]{12}$',
};
export const digestInput = { type: 'string', pattern: '^[a-f0-9]{64}$' };
export const revisionInput = {
  type: 'integer',
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
};
export const versionOptions = {
  version: versionInput,
  replaceModified: { type: 'boolean' },
  expectedSha: { type: 'string', pattern: '^([a-f0-9]{40}|[a-f0-9]{64})$' },
};
export const inputs = {
  versions: closedObject({ url: urlInput }, ['url']),
  install: {
    ...closedObject({
      url: urlInput,
      expectedId: pluginIdInput,
      ...versionOptions,
    }, ['url']),
    dependencies: { expectedSha: ['version'] },
  },
  update: {
    ...closedObject(versionOptions),
    dependencies: { expectedSha: ['version'] },
  },
  apply: closedObject({ reviewToken: digestInput }, ['reviewToken']),
  rollback: closedObject({
    requestId: uuidInput,
    expectedRevision: revisionInput,
    expectedPreviousDigest: digestInput,
  }, ['requestId', 'expectedRevision', 'expectedPreviousDigest']),
  empty: closedObject(),
  jobParams: closedObject({ jobId: uuidInput }, ['jobId']),
  pluginParams: closedObject({ id: pluginIdInput }, ['id']),
};

/**
 * Nullable используется для незавершённых и отсутствующих частей публичного DTO.
 * Схема сохраняет явный null вместо внутренних fallback значений.
 */
function nullable(schema: InstallSchema): InstallSchema {
  return { ...schema, nullable: true };
}

/**
 * Публичный объект содержит все контрактные поля и удаляет внутренние при сериализации.
 * Это отдельная граница от строгого validator входа с removeAdditional=false.
 */
function dto(properties: Record<string, InstallSchema>): InstallSchema {
  return closedObject(properties, Object.keys(properties));
}

const text = { type: 'string' };
const flag = { type: 'boolean' };
const strings = { type: 'array', items: text };
const source = dto({ kind: text, url: urlInput });
const target = dto({
  version: versionInput,
  tag: text,
  sha: { type: 'string', pattern: '^([a-f0-9]{40}|[a-f0-9]{64})$' },
});
const error = nullable(dto({ code: text, message: text }));
const replaces = { anyOf: [
  dto({ kind: { const: 'none' } }),
  dto({ kind: { const: 'unmanaged' } }),
  dto({
    kind: { const: 'managed' },
    version: versionInput,
    sourceChanged: flag,
  }),
] };
const changes = nullable(dto({
  commits: { type: 'array', items: dto({ sha: text, subject: text }) },
  files: { type: 'array', items: dto({ status: text, path: text }) },
  sensitive: strings,
  truncated: flag,
}));
const preview = nullable(dto({
  source,
  target,
  id: pluginIdInput,
  name: text,
  version: versionInput,
  description: text,
  hasServer: flag,
  hasWeb: flag,
  replaces,
  changes,
  warnings: strings,
}));
const job = dto({
  id: uuidInput,
  kind: { type: 'string', enum: ['install', 'update', 'rollback'] },
  pluginId: nullable(pluginIdInput),
  source,
  target: nullable(target),
  replaceModified: flag,
  status: { type: 'string', enum: [
    'running', 'ready', 'applying', 'done', 'failed', 'cancelled', 'interrupted', 'recovery_required',
  ] },
  stage: nullable({ type: 'string', enum: ['fetching', 'validating', 'dependencies'] }),
  percent: nullable({
    type: 'number',
    minimum: 0,
    maximum: 100,
  }),
  preview,
  error,
  createdAt: text,
  updatedAt: text,
  finishedAt: nullable(text),
  revision: revisionInput,
  reviewToken: nullable(digestInput),
  backupRef: nullable(text),
});
const version = {
  source,
  version: versionInput,
  tag: text,
  sha: text,
  installedAt: text,
  payloadDigest: digestInput,
  gitConfigDigest: digestInput,
  npmDirs: strings,
};
export const installInfoSchema = dto({
  ...version,
  revision: revisionInput,
  previous: nullable(dto(version)),
  latest: nullable(target),
  checkedAt: nullable(text),
  checkError: error,
  updateAvailable: flag,
  localChanges: flag,
  restartRequired: flag,
  rollbackAvailable: flag,
  rollbackError: error,
});
export const outputs = {
  current: { 200: dto({ job: nullable(job), recoveryError: error }) },
  job: { 200: dto({ job }), 202: dto({ job }) },
  versions: { 200: dto({ source, versions: { type: 'array', items: target } }) },
  check: { 200: dto({ plugins: { type: 'object', additionalProperties: installInfoSchema } }) },
};
