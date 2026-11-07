import {
  INSTALL_JOB_KINDS,
  INSTALL_JOB_STATUSES,
  INSTALL_STAGES,
  isInstallUuid,
  isInstallSha,
  isInstallDigest,
  isInstallPluginId,
  isInstallTimestamp,
  isInstallText,
  isInstallTerminalStatus,
  isInstallPreparedStatus,
} from '../../../shared/plugins/pluginInstallValues.ts';

import type {
  PluginInstallJob,
  PluginInstallErrorInfo,
  PluginInstallChanges,
  PluginInstallPreview,
  PluginInstallReplaces,
  PluginSourceRef,
  PluginVersionRef,
  PluginInstallInfo,
  PluginInstalledVersion,
} from '../../../shared/plugins/pluginInstallContracts.ts';

export class PluginInstallProtocolError extends Error {
  constructor() {
    super('Сервер вернул некорректные данные установки. Обновите состояние перед новым действием.');
    this.name = 'PluginInstallProtocolError';
  }
}

export interface InstallCurrentResponse {
  job: PluginInstallJob | null;
  recoveryError: PluginInstallErrorInfo | null;
}

/**
 * Проверка формы никогда не преобразует значения неизвестного JSON в доменные типы.
 * Все поля результирующего объекта строятся заново после соответствующего decoder.
 */
function object(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PluginInstallProtocolError();
  }

  return raw as Record<string, unknown>;
}

/**
 * Публичный текст имеет конечный размер и не содержит binary NUL.
 * Отсутствующее поле или coercion никогда не скрывают malformed успешный ответ.
 */
function text(raw: unknown, maximum = 4096): string {
  if (!isInstallText(raw, maximum)) {
    throw new PluginInstallProtocolError();
  }

  return raw;
}

/**
 * Строковые идентификаторы и хэши имеют тот же домен, что durable state сервера.
 * Декодер не разрешает произвольное имя служебной копии или частичный digest.
 */
function matching(raw: unknown, pattern: RegExp, maximum: number): string {
  const value = text(raw, maximum);

  if (!pattern.test(value)) {
    throw new PluginInstallProtocolError();
  }

  return value;
}


/**
 * Общие домены значений сохраняют безопасную ошибку браузерного протокола.
 * Предикат сужает unknown, а DTO по-прежнему собирается локальным декодером.
 */
function checkedValue(raw: unknown, predicate: (value: unknown) => value is string): string {
  if (!predicate(raw)) {
    throw new PluginInstallProtocolError();
  }

  return raw;
}

/**
 * ID плагина безопасен для обращения к API и не является prototype именем.
 * Тот же идентификатор используется во всех связанных полях preview и job.
 */
function pluginId(raw: unknown): string {
  return checkedValue(raw, isInstallPluginId);
}

/**
 * Стабильная версия проверяет каждую числовую часть без prerelease и leading zero.
 * Tag обязан обозначать ровно ту же версию перед сравнением источников.
 */
function version(raw: unknown): string {
  const value = matching(raw, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u, 128);

  if (!value.split('.').every((part) => Number.isSafeInteger(Number(part)))) {
    throw new PluginInstallProtocolError();
  }

  return value;
}

/**
 * Дата принимает только существующий момент в канонической UTC ISO форме.
 * Автоматическая нормализация вроде 30 февраля не превращает плохой JSON в валидный.
 */
function timestamp(raw: unknown): string {
  return checkedValue(raw, isInstallTimestamp);
}

/**
 * Boolean остаётся строго boolean без строковых значений из старых API.
 * Непроверенный флаг не открывает capability применения или отката.
 */
function boolean(raw: unknown): boolean {
  if (typeof raw !== 'boolean') {
    throw new PluginInstallProtocolError();
  }

  return raw;
}

/**
 * Revision и процент принимаются только в целочисленном допустимом диапазоне.
 * Небезопасное число не участвует в защите от поздних сетевых ответов.
 */
function integer(raw: unknown, minimum = 1, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < minimum || raw > maximum) {
    throw new PluginInstallProtocolError();
  }

  return raw;
}

/**
 * Enum возвращает найденное известное значение, а не cast неизвестной строки.
 * Расширение серверного протокола требует явной поддержки нового состояния в UI.
 */
function choice<T extends string>(raw: unknown, values: readonly T[]): T {
  const value = values.find((candidate) => candidate === raw);

  if (value === undefined) {
    throw new PluginInstallProtocolError();
  }

  return value;
}

/**
 * Nullable имеет единственную разрешённую пустую форму — JSON null.
 * Undefined у обязательного поля не превращается в отсутствие ошибки или preview.
 */
function nullable<T>(raw: unknown, decode: (value: unknown) => T): T | null {
  return raw === null ? null : decode(raw);
}

/**
 * Списки декодируются полностью до публикации и имеют серверные пределы.
 * Неверный элемент не оставляет в карточке частично принятую историю изменений.
 */
function list<T>(raw: unknown, decode: (value: unknown) => T, maximum: number): T[] {
  if (!Array.isArray(raw) || raw.length > maximum) {
    throw new PluginInstallProtocolError();
  }

  return raw.map(decode);
}

/**
 * Источник содержит только вид стратегии и публичный канонический адрес.
 * Неизвестные внутренние поля HTTP никогда не попадают в сохранённую карточку.
 */
export function decodeInstallSource(raw: unknown): PluginSourceRef {
  const value = object(raw);
  const kind = matching(value.kind, /^[a-z][a-z0-9_-]{0,40}$/u, 41);
  const url = matching(value.url, /^[^\s\x00-\x20\x7f]+$/u, 512);

  if (kind === 'git') {
    validateGitSource(url);
  }

  return {
    kind,
    url,
  };
}

/**
 * Git source не раскрывает credentials и не обозначает неподдерживаемый transport.
 * SCP и SSH допускают публичное имя пользователя, file URL остаётся абсолютным.
 */
function validateGitSource(value: string): void {
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+$/u.test(value)) {
    if (value.startsWith('-') || value.split('/').includes('..')) {
      throw new PluginInstallProtocolError();
    }

    return;
  }

  try {
    const url = new URL(value);

    if (!['https:', 'ssh:', 'file:'].includes(url.protocol) || url.password
      || url.search || url.hash || url.pathname === '/' || !url.pathname
      || url.protocol === 'https:' && (url.username || value.split('/')[2]?.includes('@'))
      || url.protocol === 'file:' && (!value.startsWith('file:///') || url.host)
      || url.protocol !== 'file:' && !url.host) {
      throw new PluginInstallProtocolError();
    }
  } catch {
    throw new PluginInstallProtocolError();
  }
}

/**
 * VersionRef разбирается независимо от списка версий и цели задания.
 * Preview получает отдельный проверенный снимок без ссылок на исходный JSON.
 */
export function decodeInstallVersion(raw: unknown): PluginVersionRef {
  const value = object(raw);
  const number = version(value.version);
  const tag = text(value.tag, 129);

  if (tag !== `v${number}`) {
    throw new PluginInstallProtocolError();
  }

  return {
    version: number,
    tag,
    sha: checkedValue(value.sha, isInstallSha),
  };
}

/**
 * Ошибка отдаёт лишь безопасные code и message из публичного контракта.
 * Stack, argv и произвольные сведения транспорта не смешиваются с UI состоянием.
 */
function decodeError(raw: unknown): PluginInstallErrorInfo {
  const value = object(raw);

  return {
    code: matching(value.code, /^[a-z][a-z0-9_]{0,80}$/u, 81),
    message: matching(value.message, /\S/u, 2048),
  };
}

/**
 * Вид заменяемой копии определяет обязательные поля предупреждения.
 * Ручной пакет и новая установка не получают фиктивную прежнюю версию.
 */
function decodeReplaces(raw: unknown): PluginInstallReplaces {
  const value = object(raw);
  const kind = choice(value.kind, ['none', 'unmanaged', 'managed'] as const);

  if (kind === 'managed') {
    return {
      kind,
      version: version(value.version),
      sourceChanged: boolean(value.sourceChanged),
    };
  }

  return { kind };
}

/**
 * История и чувствительные пути принимаются в пределах публичного preview.
 * Неизвестная вложенная форма останавливает весь ответ до изменения store.
 */
function decodeChanges(raw: unknown): PluginInstallChanges {
  const value = object(raw);

  return {
    commits: list(value.commits, (entry) => {
      const commit = object(entry);

      return { sha: checkedValue(commit.sha, isInstallSha), subject: text(commit.subject) };
    }, 50),
    files: list(value.files, (entry) => {
      const file = object(entry);

      return { status: matching(file.status, /^[A-Z?][0-9]*$/u, 16), path: text(file.path) };
    }, 200),
    sensitive: list(value.sensitive, (entry) => text(entry), 200),
    truncated: boolean(value.truncated),
  };
}

/**
 * Ready карточка строится целиком до проверки связей с job.
 * Поля исходного JSON не могут заменить проверенный id или target по spread.
 */
function decodePreview(raw: unknown): PluginInstallPreview {
  const value = object(raw);

  return {
    source: decodeInstallSource(value.source),
    target: decodeInstallVersion(value.target),
    id: pluginId(value.id),
    name: text(value.name, 256),
    version: version(value.version),
    description: text(value.description),
    hasServer: boolean(value.hasServer),
    hasWeb: boolean(value.hasWeb),
    replaces: decodeReplaces(value.replaces),
    changes: nullable(value.changes, decodeChanges),
    warnings: list(value.warnings, (entry) => text(entry, 1024), 20),
  };
}

/**
 * Успешный HTTP становится job только после разбора каждого обязательного поля.
 * Новая карточка публикуется единым значением, без частичного изменения старой.
 */
export function decodeInstallJob(raw: unknown): PluginInstallJob {
  const value = object(raw);

  const job: PluginInstallJob = {
    id: checkedValue(value.id, isInstallUuid),
    kind: choice(value.kind, INSTALL_JOB_KINDS),
    pluginId: nullable(value.pluginId, pluginId),
    source: decodeInstallSource(value.source),
    target: nullable(value.target, decodeInstallVersion),
    replaceModified: boolean(value.replaceModified),
    status: choice(value.status, INSTALL_JOB_STATUSES),
    stage: nullable(value.stage, (entry) => choice(entry, INSTALL_STAGES)),
    percent: nullable(value.percent, (entry) => integer(entry, 0, 100)),
    preview: nullable(value.preview, decodePreview),
    error: nullable(value.error, decodeError),
    createdAt: timestamp(value.createdAt),
    updatedAt: timestamp(value.updatedAt),
    finishedAt: nullable(value.finishedAt, timestamp),
    revision: integer(value.revision),
    reviewToken: nullable(value.reviewToken, (entry) => checkedValue(entry, isInstallDigest)),
    backupRef: nullable(value.backupRef, (entry) => text(entry, 256)),
  };

  validateJobLinks(job);

  return job;
}

/**
 * Статус и capability описывают одну проверенную операцию, а не независимые флаги.
 * Несвязный ready, progress или outcome запрещается до публикации в store.
 */
function validateJobLinks(job: PluginInstallJob): void {
  const terminal = isInstallTerminalStatus(job.status);
  const prepared = isInstallPreparedStatus(job.status);

  if (terminal !== (job.finishedAt !== null)
    || job.status === 'running' && (job.stage === null || job.reviewToken !== null)
    || prepared && (job.preview === null || job.target === null || job.pluginId === null
      || job.reviewToken === null || job.error !== null || job.stage !== null)
    || job.percent !== null && (job.status !== 'running' || job.stage !== 'fetching')) {
    throw new PluginInstallProtocolError();
  }

  const preview = job.preview;

  if (preview && (preview.id !== job.pluginId || preview.version !== job.target?.version
    || preview.source.kind !== job.source.kind || preview.source.url !== job.source.url
    || preview.target.version !== job.target?.version || preview.target.tag !== job.target.tag
    || preview.target.sha !== job.target.sha)) {
    throw new PluginInstallProtocolError();
  }

  if (job.backupRef !== null) {
    validateBackupRef(job.backupRef, job.pluginId);
  }
}

/**
 * Резерв обозначен только проверенным basename с id, реальной датой и UUID.
 * Абсолютные, вложенные и произвольные пути никогда не показываются как архив операции.
 */
function validateBackupRef(value: string, id: string | null): void {
  const match = /^(.+)-(\d{8}T\d{9}Z)-([a-f0-9-]{36})$/u.exec(value);

  if (!match || match[1] !== id) {
    throw new PluginInstallProtocolError();
  }

  checkedValue(match[3], isInstallUuid);

  const date = match[2] ?? '';
  const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`
    + `T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}.${date.slice(15, 18)}Z`;

  timestamp(iso);
}

/**
 * Current включает отдельное состояние восстановления даже при отсутствии job.
 * Проверенная пара публикуется только после разбора полного ответа.
 */
export function decodeInstallCurrent(raw: unknown): InstallCurrentResponse {
  const value = object(raw);

  return {
    job: nullable(value.job, decodeInstallJob),
    recoveryError: nullable(value.recoveryError, decodeError),
  };
}

/**
 * Мутация отвечает job в собственной оболочке без поля health.
 * Даже HTTP 200/202 не предоставляет capability до полного декодирования job.
 */
export function decodeInstallJobResponse(raw: unknown): PluginInstallJob {
  return decodeInstallJob(object(raw).job);
}

export interface InstallVersionsResponse {
  source: PluginSourceRef;
  versions: PluginVersionRef[];
}

/**
 * Список версий хранит канонический source отдельно от исходного ввода человека.
 * Ошибка в любой версии отвергает весь ответ, включая прежний выбор версии.
 */
export function decodeInstallVersions(raw: unknown): InstallVersionsResponse {
  const value = object(raw);

  return {
    source: decodeInstallSource(value.source),
    versions: list(value.versions, decodeInstallVersion, 10000),
  };
}

/**
 * InstallInfo отделён от job: здесь нужен полный snapshot прежней установки.
 * Только согласованные previous и флаги разрешают действие rollback в панели.
 */
export function decodeInstallInfo(raw: unknown): PluginInstallInfo {
  const value = object(raw);
  const info: PluginInstallInfo = {
    ...decodeInstalledVersion(value),
    revision: integer(value.revision),
    previous: nullable(value.previous, decodeInstalledVersion),
    latest: nullable(value.latest, decodeInstallVersion),
    checkedAt: nullable(value.checkedAt, timestamp),
    checkError: nullable(value.checkError, decodeError),
    updateAvailable: boolean(value.updateAvailable),
    localChanges: boolean(value.localChanges),
    restartRequired: boolean(value.restartRequired),
    rollbackAvailable: boolean(value.rollbackAvailable),
    rollbackError: nullable(value.rollbackError, decodeError),
  };

  if (info.rollbackAvailable && (info.previous === null || info.rollbackError !== null)
    || info.updateAvailable && info.latest === null) {
    throw new PluginInstallProtocolError();
  }

  return info;
}

/**
 * Previous хранит источник и все digest независимо от текущей live revision.
 * Npm paths относительны пакету, поэтому snapshot не выпускает служебные absolute paths.
 */
function decodeInstalledVersion(raw: unknown): PluginInstalledVersion {
  const value = object(raw);
  const ref = decodeInstallVersion(value);
  const npmDirs = list(value.npmDirs, (entry) => {
    const path = text(entry, 4096);

    if (!path || path.startsWith('/') || path.includes('\\') || /[\x00-\x1f\x7f]/u.test(path)
      || path !== '.' && path.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw new PluginInstallProtocolError();
    }

    return path;
  }, 1000);

  if (new Set(npmDirs).size !== npmDirs.length) {
    throw new PluginInstallProtocolError();
  }

  return {
    source: decodeInstallSource(value.source),
    ...ref,
    installedAt: timestamp(value.installedAt),
    payloadDigest: checkedValue(value.payloadDigest, isInstallDigest),
    gitConfigDigest: checkedValue(value.gitConfigDigest, isInstallDigest),
    npmDirs,
  };
}

/**
 * Check response публикует только проверенные InstallInfo под безопасными id.
 * Ошибка одного malformed элемента не выдаёт частичную новую карту каталогу.
 */
export function decodeInstallChecks(raw: unknown): Record<string, PluginInstallInfo | null> {
  const values = object(object(raw).plugins);

  return Object.fromEntries(Object.entries(values).map(([id, value]) => [
    pluginId(id),
    nullable(value, decodeInstallInfo),
  ]));
}

export interface StoredRollbackIntent {
  pluginId: string;
  body: {
    requestId: string;
    expectedRevision: number;
    expectedPreviousDigest: string;
  };
}

/**
 * Browser storage тоже недоверенный JSON и не получает слепой domain cast.
 * Сохранённый intent содержит тот же UUID и baseline при повторе после reload.
 */
export function decodeStoredRollback(raw: unknown): StoredRollbackIntent {
  const value = object(raw);
  const body = object(value.body);

  return {
    pluginId: pluginId(value.pluginId),
    body: {
      requestId: checkedValue(body.requestId, isInstallUuid),
      expectedRevision: integer(body.expectedRevision),
      expectedPreviousDigest: checkedValue(body.expectedPreviousDigest, isInstallDigest),
    },
  };
}

/**
 * Старый сервер вправе не передавать optional поле install в каталоге.
 * Null означает ручную установку, остальные формы обязаны пройти полный decoder.
 */
export function decodeOptionalInstall(raw: unknown): PluginInstallInfo | null | undefined {
  return raw === undefined ? undefined : raw === null ? null : decodeInstallInfo(raw);
}

/**
 * Подтверждение удаления относится ровно к запрошенному пакету.
 * Успешный HTTP с чужим id не разрешает очищать карточку и её черновик.
 */
export function decodeInstallRemoval(raw: unknown, expectedId: string): {
  id: string;
  restartRequired: boolean;
} {
  const value = object(raw);
  const id = pluginId(value.id);

  if (id !== expectedId) {
    throw new PluginInstallProtocolError();
  }

  return { id, restartRequired: boolean(value.restartRequired) };
}
