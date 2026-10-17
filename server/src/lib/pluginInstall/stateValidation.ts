import {
  isInstallUuid as uuid,
  isInstallDigest as digest,
  isInstallText as text,
  isInstallTimestamp as timestamp,
  isInstallSha,
  isInstallJobKind,
  isInstallJobStatus,
  isInstallStage,
  isInstallTerminalStatus,
  isInstallPreparedStatus,
} from '../../../../shared/plugins/pluginInstallValues.ts';

import { parseSemVer } from '../cockpitRelease.ts';
import { PLUGIN_ID_RE, normalizePluginPackagePath } from '../pluginsRegistry.ts';
import { installError, PLUGIN_INSTALL_ERRORS } from './errors.ts';
import { normalizeGitUrl } from './gitUrl.ts';
import type { PluginInstallState } from './stateStore.ts';

const VERSION_FIELDS = [
  'source', 'version', 'tag', 'sha', 'installedAt', 'payloadDigest', 'gitConfigDigest', 'npmDirs',
];
const RECORD_FIELDS = [...VERSION_FIELDS, 'revision', 'previous', 'latest', 'checkedAt', 'checkError'];

/**
 * JSON становится trusted state только после проверки полной формы и значений.
 * Ошибки сохраняют исходный файл и никогда не превращаются в пустое состояние.
 */
export function decodeInstallState(raw: unknown, writing = false): PluginInstallState {
  const state = object(raw, [
    'schemaVersion', 'nextRevision', 'plugins', 'job', 'completedJobs', 'apply', 'prepared',
    'cleanup', 'lastRollback', 'workers',
  ]);

  requireValid(state.schemaVersion === 1 && positiveInteger(state.nextRevision));

  for (const [id, record] of Object.entries(object(state.plugins))) {
    requireValid(validPluginId(id));
    validateRecord(record);
  }

  if (state.job !== null) {
    validateJob(state.job);
  }

  const completed = object(state.completedJobs);

  requireValid(writing || Object.keys(completed).length <= 32);

  for (const [id, rawJob] of Object.entries(completed)) {
    validateJob(rawJob);

    const job = object(rawJob);

    requireValid(uuid(id) && id === job.id && isInstallTerminalStatus(String(job.status)));
    requireValid(writing || job.preview === null || object(job.preview).changes === null);
  }

  for (const [id, rawReceipt] of Object.entries(object(state.lastRollback))) {
    const receipt = object(rawReceipt, ['requestId', 'inputHash', 'baseRevision', 'job']);

    requireValid(validPluginId(id));
    validateReceiptInput(receipt, true);
    validateJob(receipt.job);

    const job = object(receipt.job);

    requireValid(job.pluginId === id && job.kind === 'rollback' && job.status === 'done');
  }

  for (const [commandId, rawWorker] of Object.entries(object(state.workers))) {
    const worker = object(rawWorker, [
      'commandId', 'supervisorPid', 'supervisorStartTime', 'pid', 'pgid', 'startTime',
    ]);

    requireValid(uuid(commandId) && worker.commandId === commandId);
    requireValid(positiveInteger(worker.supervisorPid) && positiveInteger(worker.pid)
      && worker.pgid === worker.pid && worker.supervisorPid !== worker.pid);
    requireValid(typeof worker.startTime === 'string' && /^[1-9][0-9]*$/u.test(worker.startTime));
    requireValid(typeof worker.supervisorStartTime === 'string'
      && /^[1-9][0-9]*$/u.test(worker.supervisorStartTime));
  }

  requireValid(Array.isArray(state.cleanup));

  for (const raw of state.cleanup) {
    const entry = object(raw);

    if (entry.kind === 'job') {
      object(raw, Object.hasOwn(entry, 'package') ? ['kind', 'jobId', 'package'] : ['kind', 'jobId']);
      requireValid(uuid(entry.jobId));

      if (Object.hasOwn(entry, 'package')) {
        validateIdentity(entry.package, false, true);
      }
    } else {
      object(raw, ['kind', 'transactionId', 'retired', 'npmDirs']);
      requireValid(entry.kind === 'transaction' && uuid(entry.transactionId));
      validateIdentity(entry.retired, true, true);
      requireValid(Array.isArray(entry.npmDirs)
        && entry.npmDirs.every((value) => normalizePluginPackagePath(value, true) === value));
    }
  }

  if (state.prepared !== null) {
    validatePrepared(state.prepared, state.job);
  }

  if (state.apply !== null) {
    validateIntent(state.apply, state);
  }

  const revisions = [
    ...Object.values(object(state.plugins)).map((entry) => object(entry).revision),
    ...Object.values(completed).map((entry) => object(entry).revision),
    ...Object.values(object(state.lastRollback)).map((entry) => object(object(entry).job).revision),
    ...(state.job === null ? [] : [object(state.job).revision]),
    ...(state.apply === null ? [] : [object(object(state.apply).targetRecord).revision]),
  ];

  requireValid(revisions.every((revision) => positiveInteger(revision)
    && revision < Number(state.nextRevision)));

  return state as unknown as PluginInstallState;
}

/**
 * Публичный job проверяется целиком, включая preview и nullable progress/outcome.
 * Late HTTP polling не получает malformed revision или неподдерживаемый status.
 */
function validateJob(raw: unknown): void {
  const value = object(raw, [
    'id', 'kind', 'pluginId', 'source', 'target', 'replaceModified', 'status', 'stage', 'percent',
    'preview', 'error', 'createdAt', 'updatedAt', 'finishedAt', 'revision', 'reviewToken', 'backupRef',
  ]);

  requireValid(uuid(value.id) && isInstallJobKind(String(value.kind)));
  requireValid(value.pluginId === null || validPluginId(value.pluginId));
  validateSource(value.source);

  if (value.target !== null) {
    validateVersionRef(value.target);
  }

  requireValid(typeof value.replaceModified === 'boolean');

  requireValid(isInstallJobStatus(String(value.status)));
  requireValid(value.stage === null
    || isInstallStage(String(value.stage)));
  requireValid(value.percent === null || typeof value.percent === 'number'
    && Number.isInteger(value.percent) && value.percent >= 0 && value.percent <= 100);
  requireValid(timestamp(value.createdAt) && timestamp(value.updatedAt));
  requireValid(value.finishedAt === null || timestamp(value.finishedAt));
  requireValid(isInstallTerminalStatus(String(value.status)) === (value.finishedAt !== null));
  requireValid(positiveInteger(value.revision));
  requireValid(value.reviewToken === null || digest(value.reviewToken));
  requireValid(value.backupRef === null || typeof value.backupRef === 'string'
    && validArchiveKey(value.backupRef, String(value.pluginId)));
  validateError(value.error);

  if (value.preview !== null) {
    validatePreview(value.preview);

    const preview = object(value.preview);

    requireValid(preview.id === value.pluginId && same(preview.source, value.source)
      && same(preview.target, value.target));
  }

  if (isInstallPreparedStatus(String(value.status))) {
    requireValid(value.preview !== null && value.target !== null && value.pluginId !== null
      && digest(value.reviewToken) && value.error === null);
  }
}

/**
 * Preview ограничен документированным DTO, без settings или filesystem paths.
 * Изменения хранят максимум 50 commits и 200 files, warnings имеют конечный размер.
 */
function validatePreview(raw: unknown): void {
  const value = object(raw, [
    'source', 'target', 'id', 'name', 'version', 'description', 'hasServer', 'hasWeb',
    'replaces', 'changes', 'warnings',
  ]);

  validateSource(value.source);
  validateVersionRef(value.target);
  requireValid(validPluginId(value.id) && version(value.version));
  requireValid(text(value.name, 256) && text(value.description, 4096));
  requireValid(typeof value.hasServer === 'boolean' && typeof value.hasWeb === 'boolean');

  const replaces = object(value.replaces);

  if (replaces.kind === 'managed') {
    object(replaces, ['kind', 'version', 'sourceChanged']);
    requireValid(version(replaces.version) && typeof replaces.sourceChanged === 'boolean');
  } else {
    object(replaces, ['kind']);
    requireValid(replaces.kind === 'none' || replaces.kind === 'unmanaged');
  }

  requireValid(Array.isArray(value.warnings) && value.warnings.length <= 20
    && value.warnings.every((warning) => text(warning, 1024)));

  if (value.changes !== null) {
    const changes = object(value.changes, ['commits', 'files', 'sensitive', 'truncated']);

    requireValid(Array.isArray(changes.commits) && changes.commits.length <= 50);
    requireValid(Array.isArray(changes.files) && changes.files.length <= 200);
    requireValid(Array.isArray(changes.sensitive) && changes.sensitive.length <= 200
      && changes.sensitive.every((entry) => text(entry, 4096)));
    requireValid(typeof changes.truncated === 'boolean');

    for (const rawCommit of changes.commits) {
      const commit = object(rawCommit, ['sha', 'subject']);

      requireValid(isInstallSha(commit.sha) && text(commit.subject, 4096));
    }

    for (const rawFile of changes.files) {
      const file = object(rawFile, ['status', 'path']);

      requireValid(typeof file.status === 'string' && /^[A-Z?][0-9]*$/u.test(file.status)
        && text(file.path, 4096));
    }
  }
}

/**
 * Prepared связан с живым job и полным снимком заменяемых копий.
 * Неизвестный путь вместо inode identity не допускается к apply.
 */
function validatePrepared(raw: unknown, rawJob: unknown): void {
  const value = object(raw, ['jobId', 'baseSnapshot', 'candidateDigest', 'latest']);
  const job = object(rawJob);
  const base = object(value.baseSnapshot, ['record', 'current', 'previous']);

  requireValid(uuid(value.jobId) && value.jobId === job.id
    && ['ready', 'applying', 'recovery_required'].includes(String(job.status)));
  requireValid(digest(value.candidateDigest));

  if (base.record !== null) {
    validateRecord(base.record);
  }

  validateIdentity(base.current, base.record !== null, true);
  validateIdentity(base.previous, true, true);

  if (value.latest !== null) {
    validateVersionRef(value.latest);
  }
}

/**
 * Intent содержит только identities и проверенные basenames, а job/record связаны.
 * Фаза не отменяет необходимость проверить реальные копии resolver при recovery.
 */
function validateIntent(raw: unknown, state: Record<string, unknown>): void {
  const value = object(raw, [
    'transactionId', 'pluginId', 'jobId', 'kind', 'baseRecord', 'targetRecord', 'destination',
    'current', 'candidate', 'previous', 'reviewToken', 'phase', 'rollbackReceiptInput', 'archiveKey',
  ]);
  const job = object(state.job);
  const plugins = object(state.plugins);

  requireValid(uuid(value.transactionId) && uuid(value.jobId) && validPluginId(value.pluginId));
  requireValid(value.jobId === job.id && value.pluginId === job.pluginId && value.kind === job.kind);
  requireValid(job.status === 'applying' || job.status === 'recovery_required');
  requireValid(['previous', 'replaced', 'none'].includes(String(value.destination)));
  requireValid(['prepared', 'installed', 'archived'].includes(String(value.phase)));
  requireValid(digest(value.reviewToken) && value.reviewToken === job.reviewToken);

  if (value.baseRecord !== null) {
    validateRecord(value.baseRecord);
    requireValid(same(value.baseRecord, plugins[String(value.pluginId)]));
  } else {
    requireValid(!Object.hasOwn(plugins, String(value.pluginId)));
  }

  validateRecord(value.targetRecord);
  validateIdentity(value.current, value.baseRecord !== null, true);
  validateIdentity(value.candidate, true);
  validateIdentity(value.previous, true, true);

  const target = object(value.targetRecord);
  const candidate = object(value.candidate);
  const versionRef = object(job.target);

  requireValid(candidate.payloadDigest === target.payloadDigest && same(target.source, job.source)
    && target.version === versionRef.version && target.tag === versionRef.tag
    && target.sha === versionRef.sha);
  requireValid(value.destination === 'none' ? value.current === null : value.current !== null);

  if (value.destination === 'previous') {
    requireValid(value.baseRecord !== null);
  }

  if (value.archiveKey !== null) {
    requireValid(value.destination === 'replaced' && typeof value.archiveKey === 'string'
      && validArchiveKey(value.archiveKey, String(value.pluginId), String(value.transactionId)));
  } else {
    requireValid(value.destination !== 'replaced');
  }

  if (value.kind === 'rollback') {
    validateReceiptInput(value.rollbackReceiptInput);

    const receipt = object(value.rollbackReceiptInput);
    const base = object(value.baseRecord);

    requireValid(receipt.baseRevision === base.revision);
  } else {
    requireValid(value.rollbackReceiptInput === null);
  }
}

/**
 * Receipt input фиксируется до rename и сохраняет idempotent request identity.
 * Recovery не придумывает requestId или baseRevision вместо утраченного запроса.
 */
function validateReceiptInput(raw: unknown, withJob = false): void {
  const value = object(raw, withJob ? ['requestId', 'inputHash', 'baseRevision', 'job']
    : ['requestId', 'inputHash', 'baseRevision']);

  requireValid(uuid(value.requestId) && digest(value.inputHash) && positiveInteger(value.baseRevision));
}

/**
 * Directory identity имеет только dev/ino и обязательный digest managed copy.
 * Произвольные поля path и абсолютные строки не принимаются.
 */
function validateIdentity(raw: unknown, managed: boolean, nullable = false): void {
  if (raw === null && nullable) {
    return;
  }

  const value = object(raw);

  object(value, Object.hasOwn(value, 'payloadDigest') ? ['dev', 'ino', 'payloadDigest'] : ['dev', 'ino']);
  requireValid(positiveInteger(value.dev) && positiveInteger(value.ino));
  requireValid(managed ? digest(value.payloadDigest)
    : value.payloadDigest === undefined || digest(value.payloadDigest));
}

/**
 * Archive basename содержит исходные id, timestamp и transaction UUID.
 * Проверка даты и отсутствие разделителей исключают сохранённые arbitrary paths.
 */
export function validArchiveKey(raw: string, id: string, transactionId?: string): boolean {
  const match = /^(.+)-(\d{8}T\d{9}Z)-([a-f0-9-]{36})$/u.exec(raw);

  if (!match || match[1] !== id || !uuid(match[3]) || transactionId && match[3] !== transactionId) {
    return false;
  }

  const compact = match[2] ?? '';
  const iso = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`
    + `T${compact.slice(9, 11)}:${compact.slice(11, 13)}:${compact.slice(13, 15)}.${compact.slice(15, 18)}Z`;

  return timestamp(iso);
}

/**
 * Связанные DTO сравниваются по структуре, а не по ссылкам после JSON decode.
 * Порядок own keys не меняет смысл полного snapshot.
 */
function same(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }

  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }

  const a = Object.entries(left);
  const b = Object.entries(right);

  return a.length === b.length && a.every(([key, value]) => Object.hasOwn(right, key)
    && same(value, (right as Record<string, unknown>)[key]));
}

/**
 * Самодостаточный record сохраняет source и previous с целыми digest.
 * Непроверенные version/SHA/path не могут стать baseline при следующем boot.
 */
function validateRecord(raw: unknown): void {
  const value = object(raw, RECORD_FIELDS);

  validateInstalledVersion(value, true);
  requireValid(positiveInteger(value.revision));

  if (value.previous !== null) {
    validateInstalledVersion(value.previous);
  }

  if (value.latest !== null) {
    validateVersionRef(value.latest);
  }

  requireValid(value.checkedAt === null || timestamp(value.checkedAt));
  validateError(value.checkError);
}

/**
 * Previous содержит те же обязательные поля установленной версии без live revision.
 * NpmDirs остаются нормализованными путями относительно проверенного package root.
 */
function validateInstalledVersion(raw: unknown, record = false): void {
  const value = object(raw, record ? RECORD_FIELDS : VERSION_FIELDS);

  validateSource(value.source);
  requireValid(version(value.version) && value.tag === `v${value.version}`);
  requireValid(isInstallSha(value.sha));
  requireValid(timestamp(value.installedAt));
  requireValid(digest(value.payloadDigest));
  requireValid(digest(value.gitConfigDigest));
  requireValid(Array.isArray(value.npmDirs)
    && value.npmDirs.every((entry) => normalizePluginPackagePath(entry, true) === entry)
    && new Set(value.npmDirs).size === value.npmDirs.length);
}

/**
 * Persisted kind не ограничен Git: registry может предоставлять другой transport.
 * Git URL обязан уже иметь каноническую форму без credentials.
 */
function validateSource(raw: unknown): void {
  const value = object(raw, ['kind', 'url']);

  requireValid(typeof value.kind === 'string' && /^[a-z][a-z0-9_-]{0,40}$/u.test(value.kind));
  requireValid(typeof value.url === 'string' && value.url.length > 0 && value.url.length <= 512
    && !/[\x00-\x20\x7f]/u.test(value.url));

  if (value.kind === 'git') {
    requireValid(normalizeGitUrl(value.url) === value.url);
  }
}

/**
 * Tag, стабильная version и commit SHA проверяются как единая версия источника.
 * Усечённые или произвольные object IDs не принимаются.
 */
function validateVersionRef(raw: unknown): void {
  const value = object(raw, ['version', 'tag', 'sha']);

  requireValid(version(value.version) && value.tag === `v${value.version}`);
  requireValid(isInstallSha(value.sha));
}

/**
 * Ошибка содержит безопасный code/message, без произвольной структуры исключения.
 * Null сохраняет отсутствие ошибки, пустая или огромная форма недопустима.
 */
function validateError(raw: unknown): void {
  if (raw === null) {
    return;
  }

  const value = object(raw, ['code', 'message']);

  requireValid(typeof value.code === 'string' && /^[a-z][a-z0-9_]{0,80}$/u.test(value.code));
  requireValid(Object.hasOwn(PLUGIN_INSTALL_ERRORS, String(value.code)));
  requireValid(typeof value.message === 'string' && value.message.length > 0 && value.message.length <= 2048);
}

/**
 * Known object имеет только обязательные own поля и не содержит prototype names.
 * Dictionary использует ту же проверку формы без фиксированного набора id.
 */
function object(raw: unknown, keys?: string[]): Record<string, unknown> {
  requireValid(raw !== null && typeof raw === 'object' && !Array.isArray(raw));

  const value = raw as Record<string, unknown>;
  const own = Object.keys(value);

  requireValid(!own.some((key) => ['constructor', 'prototype', '__proto__'].includes(key)));

  if (keys) {
    requireValid(own.length === keys.length && keys.every((key) => Object.hasOwn(value, key)));
  }

  return value;
}

/**
 * Стабильная версия не допускает whitespace или преобразование числа в строку.
 * Проверка совпадает с входным manifest installer.
 */
function version(raw: unknown): boolean {
  return typeof raw === 'string' && raw.trim() === raw && parseSemVer(raw) !== null;
}

/**
 * Revision и process identities используют точные безопасные целые числа.
 * Отрицательные, нулевые и дробные значения не имеют смысла в журнале.
 */
function positiveInteger(raw: unknown): raw is number {
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0;
}

/**
 * Persisted id использует тот же regex и отказ от prototype names, что manifest.
 * Неизвестный id не становится filesystem basename автоматически.
 */
function validPluginId(raw: unknown): raw is string {
  return typeof raw === 'string' && PLUGIN_ID_RE.test(raw)
    && !['constructor', 'prototype', '__proto__'].includes(raw);
}

/**
 * Любой дефект JSON формы приводит к одному безопасному state_invalid.
 * Assert narrowing не заменяет runtime validation неизвестных данных.
 */
function requireValid(condition: unknown): asserts condition {
  if (!condition) {
    throw installError('state_invalid');
  }
}
