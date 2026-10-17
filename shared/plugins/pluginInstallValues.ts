import type {
  PluginInstallJobKind,
  PluginInstallJobStatus,
  PluginInstallStage,
} from './pluginInstallContracts.ts';

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const PLUGIN_ID = /^[a-z0-9][a-z0-9_-]{0,40}$/u;

export const INSTALL_JOB_KINDS = [
  'install', 'update', 'rollback',
] as const satisfies readonly PluginInstallJobKind[];
export const INSTALL_JOB_STATUSES = [
  'running', 'ready', 'applying', 'done', 'failed', 'cancelled', 'interrupted', 'recovery_required',
] as const satisfies readonly PluginInstallJobStatus[];
export const INSTALL_STAGES = [
  'fetching', 'validating', 'dependencies',
] as const satisfies readonly PluginInstallStage[];
export const INSTALL_TERMINAL_STATUSES = [
  'done', 'failed', 'cancelled', 'interrupted',
] as const satisfies readonly PluginInstallJobStatus[];
export const INSTALL_PREPARED_STATUSES = [
  'ready', 'applying', 'done',
] as const satisfies readonly PluginInstallJobStatus[];

/**
 * UUID проверяется до применения его в filesystem layout или worker registry.
 * Служебные строки не используются как пути даже при корректной общей JSON форме.
 */
export function isInstallUuid(raw: unknown): raw is string {
  return typeof raw === 'string' && UUID.test(raw);
}

/**
 * Git SHA сохраняет исходный домен: 40 либо 64 строчных hex символа.
 * Upper-case и укороченные значения не становятся ссылкой на версию.
 */
export function isInstallSha(raw: unknown): raw is string {
  return typeof raw === 'string' && SHA.test(raw);
}

/**
 * SHA-256 digest имеет одну каноническую lower-case hex форму.
 * Snapshot, reviewToken и receipt hashes нельзя заменить произвольным текстом.
 */
export function isInstallDigest(raw: unknown): raw is string {
  return typeof raw === 'string' && DIGEST.test(raw);
}

/**
 * ID использует шаблон manifest и исключает prototype имена.
 * Диск сохраняет прямую связь со своим PLUGIN_ID_RE, этот guard нужен браузеру.
 */
export function isInstallPluginId(raw: unknown): raw is string {
  return typeof raw === 'string' && PLUGIN_ID.test(raw)
    && !['constructor', 'prototype', '__proto__'].includes(raw);
}

/**
 * Timestamp имеет каноническую ISO UTC форму и существующую дату.
 * Невалидная дата не участвует в pruning terminal outcomes.
 */
export function isInstallTimestamp(raw: unknown): raw is string {
  return typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(raw)
    && Number.isFinite(Date.parse(raw)) && new Date(raw).toISOString() === raw;
}

/**
 * Текст DTO имеет явный предел, чтобы persisted preview не расширял HTTP без границ.
 * Пустое описание допустимо; binary NUL в публичном тексте не допускается.
 */
export function isInstallText(raw: unknown, maximum: number): raw is string {
  return typeof raw === 'string' && raw.length <= maximum && !raw.includes('\0');
}

/**
 * Вид задания выбирается из общего закрытого списка операций.
 * Предикат не приводит неизвестное значение к строке и не создаёт ошибку границы.
 */
export function isInstallJobKind(raw: unknown): raw is PluginInstallJobKind {
  return INSTALL_JOB_KINDS.some((value) => value === raw);
}

/**
 * Статус задания проверяется независимо от связей preview и intent.
 * Согласованность записи остаётся обязанностью дискового или HTTP адаптера.
 */
export function isInstallJobStatus(raw: unknown): raw is PluginInstallJobStatus {
  return INSTALL_JOB_STATUSES.some((value) => value === raw);
}

/**
 * Этап обозначает только подготовку пакета, nullable решает адаптер.
 * Процент и его допустимость для статуса проверяются отдельно на границе.
 */
export function isInstallStage(raw: unknown): raw is PluginInstallStage {
  return INSTALL_STAGES.some((value) => value === raw);
}

/**
 * Terminal требует finishedAt в обоих адаптерах установки.
 * Recovery сохраняет отдельный исход и не попадает в этот список.
 */
export function isInstallTerminalStatus(raw: unknown): raw is typeof INSTALL_TERMINAL_STATUSES[number] {
  return INSTALL_TERMINAL_STATUSES.some((value) => value === raw);
}

/**
 * Готовый job требует preview, target, pluginId и reviewToken.
 * Это другой инвариант, чем допустимость state.prepared при recovery.
 */
export function isInstallPreparedStatus(raw: unknown): raw is typeof INSTALL_PREPARED_STATUSES[number] {
  return INSTALL_PREPARED_STATUSES.some((value) => value === raw);
}
