// Вызовы route-движка из кокпита: аргументы, запуск в отвязанном юните и разбор отказов.
//
// ТРИ ВЕЩИ, КОТОРЫЕ ЗДЕСЬ НЕЛЬЗЯ ДЕЛАТЬ ИНАЧЕ.
//
// 1. Каталоги — только явными аргументами. Cockpit и движок используют один каталог
//    runtime-состояния и один опубликованный каталог маршрутов; скрытых legacy roots нет.
//
// 2. Окружение transient-**сервиса** не наследуется вовсе (в отличие от `--scope`).
//    Всё нужное перечисляется `--setenv` поимённо. Забыть здесь `FACTORY_SB_K` —
//    значит вернуть гонку слотов: подъём выберет индекс сам, и два прогона возьмут один.
//
// 3. `systemd-run` без `--scope` возвращает 0 сразу после регистрации юнита, поэтому
//    код возврата движка до кокпита НЕ доходит. Исход читаем из состояния: жив ли юнит
//    и появился ли ORCH_PID; текст отказа — из журнала запуска.
import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { config as runtimeConfig } from '../config.ts';

import { factoryUnitArgs } from './factoryLaunch.ts';
import { cockpitCliPath } from './cliPath.ts';

/**
 * На длинной попытке goto записал решение, но прежних 30 секунд не хватило на выход.
 * Lifecycle-журнал растёт с кругами; 180 секунд дают запас до серверного предела запроса.
 */
export const ROUTE_DECISION_TIMEOUT_MS = 180_000;

// Пути и бинари, без которых команду движку не собрать.
export interface RouteConfig {
  dataHome?: string;
  routesDir: string;
  stateDir: string;
  factoryControlDir: string;
  factoryBin: string;
  rootDir: string;
  factoryHome: string;
  profilesDir: string;
  factoryConfigRoot: string;
  deepseekBin?: string;
  deepseekBinOverride?: string;
  deepseekRuntimeMode?: 'installed' | 'embedded';
  deepseekArtifactDir?: string;
  deepseekGenerationRoot?: string;
  deepseekRuntimeHome?: string;
  prefsPath?: string;
  decisionTimeoutMs?: number;
}

// Кого именно продолжаем: задача, профиль и закреплённая попытка.
export interface RouteIdentityArgs {
  task: string | number;
  profile: string;
  attempt: string;
}

// Итог синхронного вызова движка: код, потоки и разобранная причина отказа.
export interface RouteEngineResult {
  code: number;
  ok: boolean;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  message: string;
  failure: RouteFailure | null;
}

// Typed-отказ движка по стабильному маркеру FACTORY_ERROR.
export interface RouteFailure {
  error: string;
  message: string;
  runners?: string[];
  expectedCatalogHash?: string;
  actualCatalogHash?: string | null;
}

// Сводка чистого времени попытки из проверенного журнала.
export interface RouteWorkTime {
  workSec: number;
  gateWaitSec: number;
  lastEventSec: number;
}

/** Коды выхода route-движка человеческим текстом. */
export const ROUTE_EXIT_HINTS: Record<string, string | undefined> = {
  73: 'занято: идёт другой прогон этой задачи, попытка ещё активна или стенд не отвечает',
  75: 'песочница создана частично — автоудаление запрещено, нужен человек (снеси стенд и запусти заново)',
  78: 'контракт не выполнен: аргументы, профиль, маршрут или занятый лок оркестратора',
};

/** Имя юнита прогона: фиксированное — два оркестратора одной задачи параллельно не поднимутся. */
export const routeUnitName = (task: string | number) => `factory-t${task}`;

/** Общие пути для любой команды. Порядок аргументов стабилен — на него смотрят тесты. */
export function routePathArgs(config: RouteConfig): string[] {
  return [
    '--routes-dir', config.routesDir,
    '--state-dir', config.stateDir,
    '--control-dir', config.factoryControlDir,
  ];
}

/** `check` — единственная команда без побочных эффектов: профиль, capability, маршрут в каталоге. */
const CATALOG_HASH_RE = /^[a-f0-9]{64}$/;
const DISPATCH_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function routeCheckArgs(config: RouteConfig, { profile, route, expectedCatalogHash = '' }: {
  profile: string;
  route?: string;
  expectedCatalogHash?: string;
}): string[] {
  const args = ['check', '--profile', profile];
  if (route) args.push('--route', route);
  if (expectedCatalogHash) {
    if (!CATALOG_HASH_RE.test(expectedCatalogHash)) {
      throw new TypeError('expectedCatalogHash должен быть sha256 в нижнем регистре');
    }
    args.push('--expected-catalog-hash', expectedCatalogHash);
  }
  return [...args, '--routes-dir', config.routesDir];
}

export function routeStartArgs(config: RouteConfig, {
  task, profile, route, ticketFile,
  runnerPrimary = '',
  expectedCatalogHash = '', queueDispatchId = '',
  instrumentationFiles = [], diagnosisKind = '', diagnosisSignal = '',
  deliveryTargets = [], taskComment = false,
}: {
  task: string | number;
  profile: string;
  route: string;
  ticketFile: string;
  runnerPrimary?: string;
  expectedCatalogHash?: string;
  queueDispatchId?: string;
  instrumentationFiles?: readonly string[];
  diagnosisKind?: string;
  diagnosisSignal?: string;
  deliveryTargets?: readonly string[];
  taskComment?: boolean;
}): string[] {
  const args = [String(task), 'start', '--profile', profile, '--route', route,
    '--ticket-json', ticketFile];
  // Выбор исполнителя — сразу за постановкой: порядок аргументов стабилен,
  // на него смотрят тесты.
  if (runnerPrimary) args.push('--runner-primary', runnerPrimary);
  if (expectedCatalogHash) {
    if (!CATALOG_HASH_RE.test(expectedCatalogHash)) {
      throw new TypeError('expectedCatalogHash должен быть sha256 в нижнем регистре');
    }
    args.push('--expected-catalog-hash', expectedCatalogHash);
  }
  if (queueDispatchId) {
    if (!expectedCatalogHash) {
      throw new TypeError('queueDispatchId требует expectedCatalogHash');
    }
    if (!DISPATCH_ID_RE.test(queueDispatchId)) {
      throw new TypeError('queueDispatchId должен быть UUID');
    }
    args.push('--queue-dispatch-id', queueDispatchId);
  }
  args.push(...routePathArgs(config));
  for (const file of instrumentationFiles) args.push('--instrumentation-file', file);
  if (diagnosisKind) args.push('--diagnosis-kind', diagnosisKind);
  if (diagnosisSignal) args.push('--diagnosis-signal', diagnosisSignal);
  for (const target of deliveryTargets) args.push('--delivery-target', target);
  // Комментарий со ссылками на PR во внешней задаче — отдельное immutable-действие
  // `task-comment` в delivery contract попытки; без флага движок его не выдаёт.
  if (taskComment) args.push('--task-comment');
  return args;
}

export function routeResumeArgs(
  config: RouteConfig,
  { task, profile, attempt }: RouteIdentityArgs,
): string[] {
  return [String(task), 'resume', '--profile', profile, '--attempt', attempt, ...routePathArgs(config)];
}

/**
 * Полная проекция находок читается движком под task lock, включая sealed attempt.
 * Операция не запускает модель и не зависит от общего task-level Markdown-файла.
 */
export function routeFindingsArgs(config: RouteConfig, {
  task, profile, attempt,
}: RouteIdentityArgs): string[] {
  return [String(task), 'findings-export', '--profile', profile, '--attempt', attempt,
    '--format', 'json', ...routePathArgs(config)];
}

/**
 * Ответ адресует immutable stop отдельного bootstrap, а текст передаётся файлом.
 * Команда завершается после CAS и не смешивается с отдельным resume.
 */
export function routeBootstrapAnswerArgs(config: RouteConfig, {
  task, profile, attempt, visitId, stopHash, answerFile,
}: RouteIdentityArgs & {
  visitId: string;
  stopHash: string;
  answerFile: string;
}): string[] {
  if (!/^b_[a-f0-9]{32}$/.test(visitId) || !CATALOG_HASH_RE.test(stopHash)) {
    throw new TypeError('ответ требует exact bootstrap visit и stop hash');
  }

  return [String(task), 'bootstrap-answer', '--profile', profile, '--attempt', attempt,
    '--node', 'scout', '--visit', visitId, '--stop-hash', stopHash, '--answer-file', answerFile,
    ...routePathArgs(config)];
}

/**
 * `gate` — фиксация решения человека. `--commit-only` обязателен: без него gate сам
 * ведёт маршрут дальше и держит команду столько, сколько работает следующий узел,
 * а вызывающий по HTTP упирается в свой таймаут. Продолжение — отдельным resume.
 */
export function routeGateArgs(config: RouteConfig, {
  task, profile, attempt, node, decision, comment, expectedStage,
}: RouteIdentityArgs & {
  node: string;
  decision: string;
  comment?: string;
  expectedStage?: { sequence: number; headEventHash: string };
}): string[] {
  const args = [String(task), 'gate', '--profile', profile, '--attempt', attempt,
    '--node', node, '--decision', decision, '--commit-only'];
  if (comment) args.push('--comment', comment);
  if (expectedStage) {
    args.push('--expected-stage', `${expectedStage.sequence}:${expectedStage.headEventHash}`);
  }
  return [...args, ...routePathArgs(config)];
}

/** `goto` — доверенный возврат курсора человеком на пройденный узел. */
export function routeGotoArgs(config: RouteConfig, {
  task, profile, attempt, node, reason, actor = '',
}: RouteIdentityArgs & {
  node: string;
  reason: string;
  actor?: string;
}): string[] {
  const args = [String(task), 'goto', '--profile', profile, '--attempt', attempt,
    '--node', node, '--reason', reason];
  // Кто решил. Умолчание — человек, и тогда флага нет вовсе: событие журнала остаётся
  // прежним байт в байт. Машинное решение обязано называть себя, иначе журнал попытки
  // утверждает, что курсор вернул человек.
  if (actor) args.push('--actor', actor);
  return [...args, ...routePathArgs(config)];
}

export function routeAbandonArgs(
  config: RouteConfig,
  { task, profile, attempt, reason }: RouteIdentityArgs & { reason: string },
): string[] {
  return [String(task), 'abandon', '--profile', profile, '--attempt', attempt,
    '--reason', reason, ...routePathArgs(config)];
}

/** Read-only сводка чистого времени из проверенного журнала попытки. */
export function routeWorkTimeArgs(
  config: RouteConfig,
  { task, profile, attempt }: RouteIdentityArgs,
): string[] {
  return [String(task), 'work-time', '--profile', profile, '--attempt', attempt,
    ...routePathArgs(config)];
}

/**
 * Identity of a fully pinned fresh start as projected by the route engine.
 *
 * ORCH_PID appears in the registry before the attempt and route bundle are pinned.
 * Treating that short-lived bootstrap projection as a successful launch lets a
 * fast rc=75/78 look green in the UI. Only the complete, non-stalled identity is
 * eligible for launch confirmation.
 */
export function startRegistryIdentity(registry: Record<string, string | undefined> | null, {
  profile,
  route,
  expectedCatalogHash = '',
  queueDispatchId = '',
  runnerPrimaryOverride = '',
}: {
  profile: string;
  route: string;
  expectedCatalogHash?: string;
  queueDispatchId?: string;
  runnerPrimaryOverride?: string;
}): string | null {
  if (!registry || typeof registry !== 'object') return null;
  const attempt = String(registry.ATTEMPT_ID || '');
  const routeHash = String(registry.ROUTE_HASH || '');
  const pid = String(registry.ORCH_PID || '');
  if (!/^a_[a-f0-9]{32}$/.test(attempt)
    || !/^[a-f0-9]{64}$/.test(routeHash)
    || !/^[1-9][0-9]*$/.test(pid)
    || registry.PROFILE !== profile
    || registry.ROUTE !== route
    || (expectedCatalogHash && registry.CATALOG_HASH !== expectedCatalogHash)
    || (registry.QUEUE_DISPATCH_ID || '') !== queueDispatchId
    || (registry.RUNNER_OVERRIDE_PRIMARY || '') !== runnerPrimaryOverride
    || registry.RUN_PROTOCOL !== '2'
    || registry.CATALOG_PROTOCOL !== 'route-v2'
    || !['publish', 'disabled'].includes(String(registry.DELIVERY_MODE))
    || registry.STALLED_HUMAN === '1') return null;
  const base = `${attempt}:${pid}:${routeHash}`;
  // Старые callers использовали эту строку только как стабильный bootstrap token.
  // Новая launch identity добавляется, когда caller действительно её pin-ит.
  return expectedCatalogHash || queueDispatchId || runnerPrimaryOverride
    ? `${base}:${registry.CATALOG_HASH || ''}:${registry.QUEUE_DISPATCH_ID || ''}:${registry.RUNNER_OVERRIDE_PRIMARY || ''}`
    : base;
}

/**
 * Окружение прогона. Runtime roots передаются аргументами, здесь остаются только
 * process-level настройки профилей и runner control. Пути от корня Cockpit выводятся,
 * только если корень известен и абсолютен — как и для PATH; иначе wrapper берёт свои.
 */
export function routeLaunchEnv(
  config: RouteConfig,
  extra: Record<string, string> = {},
): Record<string, string> {
  const root = config.rootDir && path.isAbsolute(config.rootDir) ? config.rootDir : '';
  const prefsPath = config.prefsPath;
  const generationRoot = config.deepseekGenerationRoot
    || (root ? path.join(root, 'server/runtime/deepseek') : '');

  return {
    ...extra,
    PATH: cockpitCliPath(config.rootDir),
    COCKPIT_HOME: config.dataHome ?? runtimeConfig.dataHome,
    ...(prefsPath ? { COCKPIT_PROVIDER_PREFS_PATH: path.resolve(prefsPath) } : {}),
    COCKPIT_DEEPSEEK_NODE_BIN: process.execPath,
    COCKPIT_DEEPSEEK_RUNTIME_MODE: config.deepseekRuntimeMode || 'embedded',
    ...(generationRoot ? { COCKPIT_DEEPSEEK_GENERATION_ROOT: generationRoot } : {}),
    COCKPIT_DEEPSEEK_ARTIFACT_DIR: config.deepseekArtifactDir || '',
    COCKPIT_DEEPSEEK_BIN: config.deepseekBinOverride
      || (config.deepseekRuntimeMode === 'installed' ? config.deepseekBin || '' : ''),
    ...(config.deepseekRuntimeHome
      ? { COCKPIT_DEEPSEEK_RUNTIME_HOME: config.deepseekRuntimeHome }
      : {}),
    HOME: process.env.HOME || '',
    FACTORY_HOME: config.factoryHome,
    FACTORY_PROFILES_DIR: config.profilesDir,
    FACTORY_CONFIG_ROOT: config.factoryConfigRoot,
  };
}

/**
 * Порог автосжатия контекста ЭТАПА для движка (prefs `stageAutoCompactWindow`).
 *
 * Передаётся ЯВНО и всегда, включая `0`: пустое значение движок читает как «спроси
 * профиль» (`AUTO_COMPACT_WINDOW` в его `runners.env`), и осознанный ноль человека молча
 * проигрывал бы настройке проекта. Дальше движок отдаёт разрешённое значение раннеру
 * своим `RUNNER_AUTO_COMPACT_WINDOW` — диалект CLI знает уже раннер, не кокпит.
 */
export function stageAutoCompactEnv(
  prefsData: { stageAutoCompactWindow?: unknown } | null | undefined,
): Record<string, string> {
  const n = Math.max(0, Math.round(Number(prefsData?.stageAutoCompactWindow) || 0));
  return { FACTORY_STAGE_AUTO_COMPACT: String(n) };
}

/**
 * Синхронный вызов движка сохраняет код выхода и отдельно отмечает убийство по сроку.
 * При таймауте stderr не объясняет отказ: решение могло уже попасть в журнал.
 */
export function runRouteEngine(
  config: RouteConfig,
  args: string[],
  { timeout = 30000 } = {},
): Promise<RouteEngineResult> {
  return new Promise<RouteEngineResult>((resolve) => {
    execFile(config.factoryBin, args, {
      timeout,
      env: { ...process.env, ...routeLaunchEnv(config) },
      maxBuffer: 1024 * 1024,
    }, (err, stdout, stderr) => {
      const rawCode = (err as { code?: unknown } | null)?.code;
      const code = err ? (typeof rawCode === 'number' ? rawCode : 1) : 0;
      const timedOut = err?.killed === true;
      const output = stderr || stdout || err?.message || '';

      resolve({
        code,
        ok: !timedOut && code === 0,
        timedOut,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        message: timedOut ? `движок не уложился за ${timeout / 1000} с` : routeMessage(code, output),
        failure: timedOut ? null : routeFailure(output),
      });
    });
  });
}

/**
 * Решения получают отдельный срок: их запись и закрытие lifecycle-сессии растут с журналом.
 * Настройка срока позволяет офлайн-тестам проверить таймаут без трёхминутного ожидания.
 */
export function runRouteDecision(config: RouteConfig, args: string[]): Promise<RouteEngineResult> {
  return runRouteEngine(config, args, {
    timeout: config.decisionTimeoutMs ?? ROUTE_DECISION_TIMEOUT_MS,
  });
}

export function parseRouteWorkTime(output: string | null | undefined): RouteWorkTime | null {
  const fields: Record<string, number | undefined> = {};
  for (const line of String(output || '').trim().split('\n')) {
    const match = /^(work_time_s|gate_wait_s|last_event_at)=([0-9]+)$/.exec(line.trim());
    if (match) fields[String(match[1])] = Number(match[2]);
  }
  if (!Number.isSafeInteger(fields.work_time_s)) return null;
  if (!Number.isSafeInteger(fields.gate_wait_s)) fields.gate_wait_s = 0;
  if (!Number.isSafeInteger(fields.last_event_at)) fields.last_event_at = 0;
  return {
    workSec: fields.work_time_s ?? 0,
    gateWaitSec: fields.gate_wait_s ?? 0,
    lastEventSec: fields.last_event_at ?? 0,
  };
}

/**
 * Старые активные попытки могли появиться до реестровой проекции WORK_TIME_S.
 * Движок проверяет их hash-chain и возвращает ту же сводку без изменения попытки.
 */
export async function readRouteWorkTime(
  config: RouteConfig,
  identity: RouteIdentityArgs,
): Promise<RouteWorkTime | null> {
  const result = await runRouteEngine(config, routeWorkTimeArgs(config, identity), { timeout: 10000 });
  return result.ok ? parseRouteWorkTime(result.stdout) : null;
}

/**
 * Typed-отказ движка. Код 1 сам по себе ничего не доказывает: preflight
 * распознаётся только по стабильному FACTORY_ERROR-маркеру из engine.
 */
export function routeFailure(output: string | null | undefined): RouteFailure | null {
  const text = String(output || '');
  const runtime = /FACTORY_ERROR=runtime_changed(?:\s+RUNNERS=([a-z][a-z0-9_,.-]*))?/.exec(text);

  if (runtime) {
    return {
      error: 'runtime_changed',
      runners: runtime[1]?.split(',') || [],
      message: 'сборка runtime изменилась после проверки; обнови каталог и повтори preflight',
    };
  }

  const catalog = /FACTORY_ERROR=catalog_changed\s+EXPECTED=([a-f0-9]{64})\s+ACTUAL=([a-f0-9]{64}|none)\b/.exec(text);
  if (catalog) {
    return {
      error: 'catalog_changed',
      expectedCatalogHash: catalog[1],
      actualCatalogHash: catalog[2] === 'none' ? null : catalog[2] ?? null,
      message: 'опубликованный каталог изменился после выбора маршрута; поставь задачу заново',
    };
  }
  const marker = /FACTORY_ERROR=(runner_preflight_unavailable|runner_preflight_failed)(?:\s+RUNNERS=([a-z][a-z0-9_-]*(?:,[a-z][a-z0-9_-]*)*))?/.exec(text);
  if (!marker) return null;
  const runners = marker[2] ? String(marker[2]).split(',') : [];
  const unavailable = marker[1] === 'runner_preflight_unavailable';
  if (unavailable && runners.length === 0) return null;
  return {
    error: String(marker[1]),
    runners,
    message: unavailable
      ? `недоступны исполнители профиля: ${runners.join(', ')}`
      : 'проверка исполнителей профиля не выполнена',
  };
}

/** Отказ движка — человеку: typed-причина либо его текст плюс расшифровка кода. */
export function routeMessage(code: number, output: string | null | undefined): string {
  const failure = routeFailure(output);
  const tail = String(output || '').trim().split('\n').filter(Boolean).slice(-3).join('; ').slice(-400);
  const hint = ROUTE_EXIT_HINTS[code];
  if (!code) return tail;
  if (failure) return `${failure.message} (код ${code})`;
  return [tail, hint ? `(код ${code}: ${hint})` : `(код ${code})`].filter(Boolean).join(' ');
}

// Итог вспомогательной команды: успех и обрезанный текст отказа.
export interface CmdResult {
  ok: boolean;
  message: string;
}

/** Вызов внешней команды без исключений — для остановки юнита. */
function runCmd(cmd: string, args: string[], { timeout = 70000 } = {}): Promise<CmdResult> {
  return new Promise<CmdResult>((resolve) => {
    execFile(cmd, args, { timeout }, (err, stdout, stderr) => {
      resolve({ ok: !err, message: String(stderr || err?.message || '').trim().slice(-400) });
    });
  });
}

/**
 * Остановить работающий оркестратор прогона по кнопке человека.
 *
 * Юнит собран под graceful-остановку (KillMode=mixed в factoryUnitArgs): TERM
 * приходит главному процессу, обработчик движка гасит активный runner и снимает
 * инструментацию. Без systemd — прямой TERM по pid из реестра; isAlive сверяет
 * cmdline, поэтому сигнал не уйдёт чужому процессу. Попытка остаётся открытой:
 * дальше работает обычный resume.
 */
export async function stopRouteOrchestrator({
  task, orchPid, isAlive, waitMs = 10000, stepMs = 300, exactPid = false,
  run = runCmd, kill = (pid: number) => process.kill(pid, 'SIGTERM'),
}: {
  task: string | number;
  orchPid: string | number;
  isAlive: () => boolean;
  exactPid?: boolean;
  waitMs?: number;
  stepMs?: number;
  run?: (cmd: string, args: string[]) => Promise<CmdResult>;
  kill?: (pid: number) => void;
}): Promise<{ ok: boolean; outcome: 'not_running' | 'stopped' | 'stop_sent'; message?: string }> {
  if (!isAlive()) return { ok: true, outcome: 'not_running' };

  const viaUnit = exactPid
    ? { ok: false, message: 'Остановка точного PID вместо меняющегося имени юнита.' }
    : await run('systemctl', ['--user', 'stop', routeUnitName(task)]);
  if (!viaUnit.ok && isAlive()) {
    // Нет systemd (или юнита): detached-запуск останавливается прямым сигналом.
    try { kill(Number(orchPid)); } catch { /* умер между проверками */ }
  }
  const deadline = Date.now() + waitMs;
  while (isAlive() && Date.now() < deadline) await sleep(stepMs);
  if (isAlive()) {
    if (!viaUnit.ok) return { ok: false, outcome: 'stop_sent', message: viaUnit.message || 'не удалось остановить прогон' };
    return { ok: true, outcome: 'stop_sent' };
  }
  return { ok: true, outcome: 'stopped' };
}

/** Жив ли юнит прогона. `--collect` убирает мёртвый юнит, поэтому «не активен» = вышел. */
export function routeUnitActive(task: string | number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    execFile('systemctl', ['--user', 'is-active', routeUnitName(task)], { timeout: 5000 }, (err, stdout) => {
      resolve(String(stdout || '').trim() === 'active');
    });
  });
}

/** Хвост журнала запуска — единственное, что остаётся от умершего юнита. */
export async function readLaunchLog(file: string, bytes = 2000): Promise<string> {
  try {
    const text = await fs.readFile(file, 'utf8');
    return text.slice(-bytes).trim();
  } catch { return ''; }
}

/**
 * Длина журнала в СИМВОЛАХ на момент запуска — точка отсчёта для `readLogSince`.
 *
 * Не размер в байтах: журнал этапов пишется по-русски, и смешение единиц срезало бы
 * причину отказа посередине символа.
 */
export async function logLength(file: string): Promise<number> {
  try { return (await fs.readFile(file, 'utf8')).length; } catch { return 0; }
}

/** Что движок дописал в журнал ПОСЛЕ запуска: причина быстрого отказа без чужих строк. */
export async function readLogSince(
  file: string,
  offset: number,
  { lines = 3, limit = 400 } = {},
): Promise<string> {
  try {
    const text = await fs.readFile(file, 'utf8');
    return text.slice(offset).trim().split('\n').filter(Boolean).slice(-lines)
      .join('; ')
      .slice(-limit);
  } catch { return ''; }
}

/**
 * Подтвердить, что resume действительно поднял оркестратор.
 *
 * `systemd-run` возвращает 0 сразу после регистрации юнита, поэтому мёртвый прогон
 * выглядел запущенным: юнит умирал через пару секунд на fail-closed преflight
 * (например, контракт профиля разошёлся с закреплённым — код 75), а кокпит отвечал
 * «продолжено». Человек жал кнопку снова и снова видел успех — так могли пройти
 * четыре попытки подряд.
 *
 * Один живой ORCH_PID ничего не доказывает: движок пишет его ДО проверки контракта,
 * поэтому «жив» держится ровно те две секунды, что и обречённый процесс. Ждём, пока
 * окно быстрых отказов пройдёт целиком, и только потом считаем прогон поднятым;
 * смерть юнита внутри окна — отказ с причиной из журнала этапов.
 *
 * Второе окно — на ЗАПИСЬ identity, и оно оплачено ложной тревогой. Раньше после
 * settle делался ОДИН снимок реестра: не успел движок дописать `ATTEMPT_ID`/`ORCH_PID`
 * за шесть секунд — и кокпит отвечал «оркестратор не подтвердил запуск», хотя прогон
 * поехал. Живой замер: возврат курсора записан в 10:55:14, узел зашёл в 10:55:33 —
 * девятнадцать секунд, из них львиная доля на preflight исполнителей. Человек при этом
 * видел плашку «Записано, но прогон не поехал» над идущим прогоном.
 *
 * До публикации identity движок несколько раз полностью проверяет lifecycle-журнал;
 * число чтений зависит от восстановления. Второе окно даёт на подъём 120 секунд после
 * шести секунд settle: около 126 секунд номинально. Это не общий timeout callbacks
 * identity/unitAlive/reason и не жёсткий предел времени HTTP-запроса.
 *
 * Ждём только НЕОПРЕДЕЛЁННОСТЬ (реестр не прочитан, попытка ещё не записана, демона
 * пока нет). ЧУЖАЯ непустая попытка в реестре — ответ авторитетный и мгновенный: ждать
 * тут нечего, ситуация от времени не изменится.
 */
export async function confirmRouteResume({
  attempt, identity, unitAlive, reason,
  settleMs = 6000, stepMs = 250, confirmMs = 120000,
}: {
  attempt: string;
  identity: () => Promise<{ alive?: boolean; attempt?: string } | null>;
  unitAlive: () => Promise<boolean>;
  reason: () => Promise<string>;
  settleMs?: number;
  stepMs?: number;
  confirmMs?: number;
}): Promise<{ ok: boolean; outcome: 'running' | 'exited' | 'unconfirmed'; message?: string }> {
  const settleDeadline = Date.now() + settleMs;
  while (Date.now() < settleDeadline) {
    await sleep(stepMs);
    if (!(await unitAlive())) {
      return { ok: false, outcome: 'exited', message: await reason() || 'прогон вышел сразу после запуска' };
    }
  }

  const confirmDeadline = Date.now() + confirmMs;
  for (;;) {
    const current = await identity();
    if (current && current.alive && current.attempt === attempt) return { ok: true, outcome: 'running' };
    // Реестр назвал другую попытку — это факт, а не задержка записи.
    const foreign = Boolean(current && current.attempt && current.attempt !== attempt);
    if (foreign || Date.now() >= confirmDeadline) break;
    await sleep(stepMs);
    if (!(await unitAlive())) {
      return { ok: false, outcome: 'exited', message: await reason() || 'прогон вышел сразу после запуска' };
    }
  }
  return {
    ok: false,
    outcome: 'unconfirmed',
    message: await reason() || 'оркестратор не подтвердил запуск попытки',
  };
}

/**
 * Запустить route-движок в отвязанном юните.
 *
 * Юнит именно transient-**сервис**, а не scope: оркестратор живёт часами и обязан
 * пережить рестарт кокпита, а его собственный обработчик TERM должен успеть снять
 * инструментацию (KillMode=mixed в factoryUnitArgs).
 */
/**
 * Пишет секреты движка в файл `EnvironmentFile` юнита с правами 0600.
 *
 * Через `--setenv=NAME=VALUE` значение попало бы в argv systemd-run и в `ps`, а форму
 * `--setenv=NAME` без значения systemd 249 не поддерживает. Файл один на все запуски:
 * содержимое у него всегда одно и то же, юнит читает его на старте. Пустые значения
 * пропускаются; без единого секрета файла нет и возвращается null.
 */
async function writeRouteSecretsFile(
  stateDir: string,
  secrets: Record<string, string | undefined>,
): Promise<string | null> {
  const lines = Object.entries(secrets)
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([name, value]) => `${name}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
  if (!lines.length) {
    return null;
  }

  const file = path.join(stateDir, 'route-secrets.env');
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(file, `${lines.join('\n')}\n`, { mode: 0o600 });
  await fs.chmod(file, 0o600);
  return file;
}

export async function spawnRouteEngine(config: RouteConfig, { task, args, extraEnv = {} }: {
  task: string | number;
  args: string[];
  extraEnv?: Record<string, string>;
}): Promise<{
  ok: boolean;
  unit: string | null;
  logFile: string;
  logOffset: number;
  exited?: number | null;
  message?: string;
  failure?: RouteFailure | null;
}> {
  const logFile = path.join(config.stateDir, `t${task}.launch.log`);
  await fs.mkdir(config.stateDir, { recursive: true });
  // launch.log переиспользуется задачей. Typed-ошибку разрешено брать только из
  // текущего запуска, иначе старый preflight замаскирует новый несвязанный отказ.
  const logOffset = await logLength(logFile);
  const env = routeLaunchEnv(config, extraEnv);
  const haveSystemd = await new Promise<boolean>((res) => {
    execFile('systemd-run', ['--version'], (err) => res(!err));
  });

  if (!haveSystemd) {
    // Без systemd — полная отвязка: код возврата виден сразу, вывод в тот же журнал.
    const out = await fs.open(logFile, 'a');
    const child = spawn(config.factoryBin, args, {
      detached: true, stdio: ['ignore', out.fd, out.fd], env: { ...process.env, ...env },
    });
    child.unref();
    const exited = await new Promise<number | null>((res) => {
      let done = false;
      child.on('exit', (code) => { done = true; res(code ?? 1); });
      setTimeout(() => { if (!done) res(null); }, 3000);
    });
    await out.close();
    if (exited) {
      const output = await readLogSince(logFile, logOffset, { lines: 10, limit: 2000 });
      return {
        ok: false,
        unit: null,
        logFile,
        logOffset,
        exited,
        message: routeMessage(exited, output),
        failure: routeFailure(output),
      };
    }
    return { ok: true, unit: null, logFile, logOffset, exited: null };
  }

  const unit = routeUnitName(task);
  const secretsFile = await writeRouteSecretsFile(config.stateDir, {
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
  });
  const argv = [
    ...factoryUnitArgs(task),
    // Без этого отказ движка не оставит следа: у сервиса stdout уходит в журнал
    // systemd, а кокпит его не читает и читать не должен.
    `--property=StandardOutput=append:${logFile}`,
    ...Object.entries(env).filter(([, v]) => v !== '' && v !== undefined).map(([k, v]) => `--setenv=${k}=${v}`),
    // Секрет едет файлом 0600, а не аргументом: в argv systemd-run его нет. Форма
    // `--setenv=NAME` без значения здесь не годится — systemd 249 (Ubuntu 22.04) её не
    // знает и отвергает весь юнит как «Invalid environment block». В non-systemd ветке
    // child и так наследует process.env.
    ...(secretsFile ? [`--property=EnvironmentFile=${secretsFile}`] : []),
    config.factoryBin, ...args,
  ];
  const started = await new Promise<{ ok: boolean; message?: string }>((resolve) => {
    execFile('systemd-run', argv, { timeout: 15000 }, (err, stdout, stderr) => {
      resolve(err ? { ok: false, message: String(stderr || err.message).trim().slice(-400) } : { ok: true });
    });
  });
  if (!started.ok) {
    return {
      ok: false,
      unit,
      logFile,
      logOffset,
      message: `юнит не зарегистрирован: ${started.message}`,
    };
  }
  return { ok: true, unit, logFile, logOffset, exited: null };
}
