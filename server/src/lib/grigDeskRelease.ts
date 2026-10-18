import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';

import type {
  CheckoutState,
  DisplayVersion,
  ReleaseCheckError,
  ReleaseStatus,
  RunningRelease,
  UpdateJob,
} from '../../../shared/runtime/grigDeskUpdateContracts.ts';

// Форму снимка версии читает и веб (плитка версии, настройки сервера): она объявлена в
// общем контракте, а здесь остаётся доступной прежним импортёрам.
export type { ReleaseStatus, UpdateJob } from '../../../shared/runtime/grigDeskUpdateContracts.ts';

const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const TAG_RE = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA_RE = /^[0-9a-f]{40,64}$/i;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const LOCAL_CACHE_MS = 1500;
const STATE_SCHEMA = 1;

// Разобранная строгая версия. Всё, что не `x.y.z`, разбору не подлежит.
export interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

// Итог внешней команды. Форма одна на все вызовы, чтобы `code`/`timedOut`
// проверялись одинаково и в git, и в проверке runtime целевого релиза.
export interface CommandResult {
  code: number;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  file: string,
  args: string[],
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeout?: number;
    maxBuffer?: number;
  },
) => Promise<CommandResult>;

// Тег релиза из `ls-remote`. `sha` заполняется только у аннотированного тега —
// см. разбор ниже, там же и причина.
interface RemoteTag {
  tag: string;
  version: string;
  sha: string | null;
  tagObjectSha: string | null;
  annotated: boolean;
}

// Файл состояния обновления целиком.
export interface PersistentState extends Record<string, unknown> {
  schemaVersion?: number;
  job?: UpdateJob | null;
  releaseCheck?: {
    latest?: { version: string; tag: string; sha: string; url: string | null } | null;
    checkedAt?: string | null;
    checkError?: ReleaseCheckError | null;
  } | null;
}

export class GrigDeskReleaseError extends Error {
  readonly code: string;

  readonly statusCode: number;

  // Код, который разрешено показать человеку. Ставится там, где сообщение уже
  // очищено от вывода команды.
  safeCode?: string;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = 'GrigDeskReleaseError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function parseSemVer(value: unknown): SemVer | null {
  const match = VERSION_RE.exec(String(value || '').trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function compareSemVer(left: string | SemVer | null, right: string | SemVer | null): number {
  const a = typeof left === 'string' ? parseSemVer(left) : left;
  const b = typeof right === 'string' ? parseSemVer(right) : right;
  if (!a || !b) throw new TypeError('Ожидалась строгая SemVer-версия');
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export function parseStableTag(value: unknown): string | null {
  const match = TAG_RE.exec(String(value || '').trim());
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

/**
 * `ls-remote --tags` отдаёт для аннотированного тега две строки: объект тега и
 * peeled commit с `^{}`. Для обновления нужен именно commit SHA.
 */
export function parseRemoteTags(output: unknown): Array<RemoteTag & { sha: string }> {
  const tags = new Map<string, RemoteTag>();
  for (const line of String(output || '').split(/\r?\n/)) {
    if (!line) continue;
    const [sha, ref] = line.trim().split(/\s+/, 2);
    if (!SHA_RE.test(sha || '') || !ref?.startsWith('refs/tags/')) continue;
    const peeled = ref.endsWith('^{}');
    const tag = ref.slice('refs/tags/'.length, peeled ? -3 : undefined);
    const version = parseStableTag(tag);
    if (!version) continue;
    const item: RemoteTag = tags.get(tag)
      || { tag, version, sha: null, tagObjectSha: null, annotated: false };
    if (peeled) {
      item.sha = String(sha).toLowerCase();
      item.annotated = true;
    } else {
      item.tagObjectSha = String(sha).toLowerCase();
    }
    tags.set(tag, item);
  }
  // Stable-релизы обязаны быть аннотированными: lightweight ref намеренно игнорируем.
  return [...tags.values()]
    .filter((item): item is RemoteTag & { sha: string } => item.annotated && Boolean(item.sha))
    .sort((a, b) => compareSemVer(a.version, b.version));
}

export function releaseUrl(remote: unknown, tag: unknown): string | null {
  if (!parseStableTag(tag)) return null;
  const value = String(remote || '').trim();
  let repo: string | null = null;
  let match = /^git@github\.com:([^/\s]+\/[^\s]+?)\/?$/.exec(value);
  if (match) repo = match[1] ?? null;
  if (!repo) {
    try {
      const url = new URL(value);
      if (url.hostname === 'github.com') repo = url.pathname.replace(/^\/+|\/+$/g, '');
    } catch { /* не URL и не GitHub SCP syntax */ }
  }
  if (!repo) return null;
  repo = repo.replace(/\.git$/, '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return null;
  return `https://github.com/${repo}/releases/tag/${encodeURIComponent(String(tag))}`;
}

export const defaultCommandRunner: CommandRunner = (file, args, options = {}) => (
  new Promise<CommandResult>((resolve) => {
    execFile(file, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeout ?? 10_000,
      maxBuffer: options.maxBuffer ?? 2 * 1024 * 1024,
      encoding: 'utf8',
    }, (error, stdout = '', stderr = '') => {
      resolve({
        code: error ? (Number.isInteger(error.code) ? Number(error.code) : 1) : 0,
        signal: error?.signal || null,
        timedOut: !!error?.killed,
        stdout: String(stdout),
        stderr: String(stderr),
      });
    });
  })
);

/**
 * Target smoke требует возможности installed worker публиковать embedded generation.
 * Промежуточный installed-релиз допускает legacy worker для перехода в два релиза.
 */
export async function assertReleasePublishContract(rootDir: string, supplied: string | undefined) {
  const file = path.join(rootDir, 'server/deepseek-runtime-contract.json');
  const contract = JSON.parse(await readFile(file, 'utf8'));

  if (contract.format !== 1 || contract.publishContract !== 1
      || !['installed', 'embedded'].includes(contract.mode)) {
    throw new Error('Неподдерживаемый контракт публикации DeepSeek');
  }

  if (contract.mode === 'embedded' && supplied !== String(contract.publishContract)) {
    throw new Error('Updater требует промежуточного релиза с publish contract 1');
  }
}

/**
 * Проверяет runtime целевого дерева до установки релиза. Проверку исполняет отдельный
 * Node без флагов родителя и NODE_OPTIONS: старый сервер мог включать снятие типов
 * флагом, которого в новом запуске уже нет. Минимум объявляет сам целевой gate.
 * Старые релизы без gate остаются применимыми; новый JS smoke требует его явно.
 */
export async function assertReleaseNodeRuntime(
  rootDir: string,
  { required = false }: { required?: boolean } = {},
): Promise<void> {
  const gatePath = path.join(rootDir, 'server', 'src', 'lib', 'nodeVersion.ts');

  try {
    await stat(gatePath);
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'ENOENT' && !required) {
      return;
    }

    const failure = new GrigDeskReleaseError(
      'node_runtime_check_unavailable',
      'Не удалось прочитать проверку совместимости Node в целевом релизе.',
      409,
    );

    failure.safeCode = failure.code;
    throw failure;
  }

  const env = { ...process.env };

  delete env.NODE_OPTIONS;

  const probe = [
    'try {',
    '  const { assertSupportedNode } = await import(process.argv[1]);',
    '  assertSupportedNode();',
    '} catch (error) {',
    '  process.stderr.write((error instanceof Error ? error.message : String(error)) + "\\n");',
    '  process.exitCode = 1;',
    '}',
  ].join('\n');
  const result = await defaultCommandRunner(process.execPath, [
    '--input-type=module',
    '--eval',
    probe,
    pathToFileURL(gatePath).href,
  ], {
    cwd: rootDir,
    env,
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });

  if (result.code === 0) {
    return;
  }

  const detail = result.stderr.trim().slice(0, 2000);
  const failure = new GrigDeskReleaseError(
    'node_runtime_unsupported',
    `Node ${process.versions.node} не может запустить целевой релиз GrigDesk без дополнительных флагов.`
      + ' Обнови Node перед установкой релиза.'
      + (detail ? ` ${detail}` : ''),
    409,
  );

  failure.safeCode = failure.code;
  throw failure;
}

export async function readPersistentState(statePath: string): Promise<PersistentState> {
  try {
    const data = JSON.parse(await readFile(statePath, 'utf8')) as PersistentState | null;
    return data && data.schemaVersion === STATE_SCHEMA ? data : { schemaVersion: STATE_SCHEMA };
  } catch {
    return { schemaVersion: STATE_SCHEMA };
  }
}

export async function writePersistentState(statePath: string, state: PersistentState): Promise<void> {
  await mkdir(path.dirname(statePath), { recursive: true });
  const tmp = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ ...state, schemaVersion: STATE_SCHEMA }, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, statePath);
  // rename сохраняет mode нового файла, но chmod через writeFile не меняет старый mode
  // при некоторых FS; повторная запись tmp гарантирует 0600 у опубликованного inode.
}

async function withStateWriteLock<Value>(statePath: string, fn: () => Promise<Value>): Promise<Value> {
  const lockPath = `${statePath}.write-lock`;
  await mkdir(path.dirname(statePath), { recursive: true });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code !== 'EEXIST') throw error;
      // Умерший writer не должен навсегда заморозить состояние.
      try {
        const info = await stat(lockPath);
        if (Date.now() - info.mtimeMs > 30_000) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch { continue; }

      await pause(20);
      continue;
    }
    // Ошибка самого writer-а не является конфликтом lock-а, даже если случайно имеет
    // code=EEXIST. Освобождаем lock и отдаём исходную ошибку вызывающему коду.
    try { return await fn(); }
    finally { await rm(lockPath, { recursive: true, force: true }); }
  }
  throw new Error('state_write_lock_timeout');
}

export async function mutatePersistentState(
  statePath: string,
  mutator: (state: PersistentState) => PersistentState | void | Promise<PersistentState | void>,
): Promise<PersistentState> {
  return withStateWriteLock(statePath, async () => {
    const current = await readPersistentState(statePath);
    const next = await mutator(current) || current;
    await writePersistentState(statePath, next);
    return next;
  });
}

function shortSha(sha?: string | null) { return sha?.slice(0, 7) || ''; }

function displayVersion(exactTags: string[], describe: unknown, sha: string): DisplayVersion {
  const stable = exactTags.map(parseStableTag)
    .filter((value): value is string => Boolean(value))
    .sort((a, b) => compareSemVer(b, a))[0];
  if (stable) return { version: `v${stable}`, stableVersion: stable, exactTag: `v${stable}` };
  const described = /^(v\d+\.\d+\.\d+)-(\d+)-g([0-9a-f]+)$/.exec(String(describe || '').trim());
  if (described && parseStableTag(described[1])) {
    const base = String(described[1]).slice(1);
    return {
      version: `${described[1]}+${described[2]}.g${described[3]}`,
      stableVersion: base,
      exactTag: null,
    };
  }
  return { version: `dev.g${shortSha(sha)}`, stableVersion: null, exactTag: null };
}

function safeCheckError(result: CommandResult | null | undefined): ReleaseCheckError {
  if (result?.timedOut) return { code: 'remote_timeout', message: 'Проверка обновлений превысила лимит времени.' };
  return { code: 'remote_unavailable', message: 'Не удалось проверить опубликованные релизы.' };
}

export interface GrigDeskReleaseServiceOptions {
  rootDir: string;
  statePath: string;
  runner?: CommandRunner;
  now?: () => Date;
  broadcast?: (name: string, payload?: unknown) => void;
  checkIntervalMs?: number;
  initialCheckDelayMs?: number;
}

export class GrigDeskReleaseService {
  readonly rootDir: string;

  readonly statePath: string;

  private readonly runner: CommandRunner;

  private readonly now: () => Date;

  private readonly broadcast: (name: string, payload?: unknown) => void;

  private readonly checkIntervalMs: number;

  private readonly initialCheckDelayMs: number;

  readonly instanceId: string;

  private readonly runningPromise: Promise<RunningRelease>;

  private localCache: { at: number; value: ReleaseStatus } | null = null;

  private checkPromise: Promise<unknown> | null = null;

  private timers: Array<ReturnType<typeof setTimeout>> = [];

  constructor({
    rootDir,
    statePath,
    runner = defaultCommandRunner,
    now = () => new Date(),
    broadcast = () => {},
    checkIntervalMs = CHECK_INTERVAL_MS,
    initialCheckDelayMs = 30_000,
  }: GrigDeskReleaseServiceOptions) {
    if (!statePath) {
      throw new Error('GrigDeskReleaseService: statePath is required');
    }

    this.rootDir = rootDir;
    this.statePath = statePath;
    this.runner = runner;
    this.now = now;
    this.broadcast = broadcast;
    this.checkIntervalMs = checkIntervalMs;
    this.initialCheckDelayMs = initialCheckDelayMs;
    this.instanceId = randomUUID();
    this.runningPromise = this.#captureRunning();
  }

  async #runGit(args: string[], { timeout = 10_000, allow = [] }: {
    timeout?: number;
    allow?: number[];
  } = {}): Promise<CommandResult> {
    const result = await this.runner('git', ['-C', this.rootDir, ...args], {
      cwd: this.rootDir, timeout, maxBuffer: 2 * 1024 * 1024,
    });
    if (result.code !== 0 && !allow.includes(result.code)) {
      throw new GrigDeskReleaseError('git_unavailable', 'Не удалось прочитать состояние GrigDesk.', 503);
    }
    return result;
  }

  async #productVersion(): Promise<string> {
    const raw = (await readFile(path.join(this.rootDir, 'VERSION'), 'utf8')).trim();
    if (!parseSemVer(raw)) throw new GrigDeskReleaseError('invalid_product_version', 'Файл VERSION содержит некорректную версию.', 500);
    return raw;
  }

  async #versionAt(sha: string): Promise<DisplayVersion> {
    const [tagResult, describeResult] = await Promise.all([
      this.#runGit(['tag', '--points-at', sha]),
      this.#runGit(['describe', '--tags', '--long', '--always', '--match', 'v[0-9]*.[0-9]*.[0-9]*', sha], { allow: [128] }),
    ]);
    return displayVersion(tagResult.stdout.split(/\r?\n/).filter(Boolean), describeResult.stdout, sha);
  }

  async #captureRunning(): Promise<RunningRelease> {
    const shaResult = await this.#runGit(['rev-parse', 'HEAD']);
    const sha = shaResult.stdout.trim().toLowerCase();
    if (!SHA_RE.test(sha)) throw new GrigDeskReleaseError('invalid_git_sha', 'Git вернул некорректную ревизию.', 500);
    const [described, productVersion] = await Promise.all([this.#versionAt(sha), this.#productVersion()]);
    return {
      ...described,
      productVersion,
      versionTagMismatch: !!described.exactTag && described.exactTag !== `v${productVersion}`,
      sha,
      instanceId: this.instanceId,
      startedAt: this.now().toISOString(),
    };
  }

  async #checkout(): Promise<CheckoutState> {
    const [shaResult, branchResult, statusResult] = await Promise.all([
      this.#runGit(['rev-parse', 'HEAD']),
      this.#runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], { allow: [1] }),
      this.#runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    ]);
    const sha = shaResult.stdout.trim().toLowerCase();
    const described = await this.#versionAt(sha);
    const productVersion = await this.#productVersion();
    return {
      ...described,
      productVersion,
      versionTagMismatch: !!described.exactTag && described.exactTag !== `v${productVersion}`,
      sha,
      branch: branchResult.code === 0 ? branchResult.stdout.trim() : null,
      detached: branchResult.code !== 0,
      dirty: statusResult.stdout.length > 0,
    };
  }

  async #isAncestor(ancestor: string, descendant: string): Promise<boolean | null> {
    if (!SHA_RE.test(ancestor || '') || !SHA_RE.test(descendant || '')) return null;
    const result = await this.#runGit(['merge-base', '--is-ancestor', ancestor, descendant], { allow: [1, 128] });
    if (result.code === 128) return null; // remote commit ещё не получен локально
    return result.code === 0;
  }

  async relation(fromSha: string | null | undefined, targetSha: string | null | undefined): Promise<string> {
    if (!fromSha || !targetSha) return 'unknown';
    if (fromSha === targetSha) return 'at';
    const [fromBeforeTarget, targetBeforeFrom] = await Promise.all([
      this.#isAncestor(fromSha, targetSha),
      this.#isAncestor(targetSha, fromSha),
    ]);
    if (fromBeforeTarget === true) return 'behind';
    if (targetBeforeFrom === true) return 'ahead';
    if (fromBeforeTarget === false && targetBeforeFrom === false) return 'diverged';
    return 'unknown';
  }

  async #localStatus(): Promise<ReleaseStatus> {
    const running = await this.runningPromise;
    const checkout = await this.#checkout();
    const persisted = await readPersistentState(this.statePath);
    let job: UpdateJob | null = persisted.job || null;
    // Новый процесс является подтверждением рестарта. Worker намеренно оставляет job
    // в `restarting`, чтобы смерть старого процесса не могла объявить успех заранее.
    const newProcessInstance = !job?.previousRunningInstanceId
      || job.previousRunningInstanceId !== running.instanceId;

    if (job?.status === 'restarting' && job.targetSha === running.sha && newProcessInstance) {
      const completedAt = this.now().toISOString();
      const finished = job;
      let runtimeError: string | null = null;

      if (job.expectedRuntimeBuildId) {
        try {
          const { resolveDeepSeekRuntime } = await import('./deepseek/runtimeProcess.ts');
          const runtime = resolveDeepSeekRuntime({ deepseekRuntimeMode: 'embedded',
            deepseekGenerationRoot: path.join(this.rootDir, 'server/runtime/deepseek') });

          if (runtime.buildId !== job.expectedRuntimeBuildId) {
            runtimeError = 'runtime_build_mismatch';
          }
        } catch {
          runtimeError = 'runtime_readiness_failed';
        }
      }

      const next = await mutatePersistentState(this.statePath, (state) => ({
        ...state,
        job: state.job?.id === finished.id
          ? {
            ...state.job,
            status: runtimeError ? 'failed' : 'done',
            stage: runtimeError ? 'failed' : 'done',
            completedAt,
            error: runtimeError ? {
              code: runtimeError,
              message: 'Runtime не подтверждён; восстанови согласованный checkout и current.',
            } : null,
          }
          : state.job,
      }));
      job = next.job || job;
      this.broadcast('grigdesk-update', { at: Date.now(), reason: runtimeError ? 'job-failed' : 'job-done' });

      try {
        if (!runtimeError) {
          await this.#cleanupBackups(job);
          job = { ...job, backups: null };
        }
      } catch { /* backup останется для ручной диагностики; статус обновления уже честный */ }
    }
    const latest = persisted.releaseCheck?.latest || null;
    const [checkoutRelation, runningRelation] = latest
      ? await Promise.all([this.relation(checkout.sha, latest.sha), this.relation(running.sha, latest.sha)])
      : ['unknown', 'unknown'];

    let updateAvailable = false;
    if (latest && running.sha !== latest.sha) {
      if (runningRelation === 'behind') updateAvailable = true;
      else if (!['ahead', 'at'].includes(runningRelation)) {
        const base = running.stableVersion || running.productVersion;
        updateAvailable = !!parseSemVer(base) && compareSemVer(latest.version, base) > 0;
      }
    }
    const activeJob = !!job && ['queued', 'preparing', 'installing', 'building', 'testing', 'applying', 'restarting'].includes(job.status);
    const applyBlockReasons: string[] = [];
    if (checkout.dirty) applyBlockReasons.push('working_tree_dirty');
    if (activeJob) applyBlockReasons.push('update_in_progress');

    const installBlockReasons: string[] = [];
    if (!latest) installBlockReasons.push('no_release_checked');
    if (checkout.branch !== 'main') installBlockReasons.push(checkout.detached ? 'detached_head' : 'branch_not_main');
    if (checkout.dirty) installBlockReasons.push('working_tree_dirty');
    if (latest && checkoutRelation === 'ahead') installBlockReasons.push('checkout_ahead');
    if (latest && checkoutRelation === 'diverged') installBlockReasons.push('checkout_diverged');
    if (latest && checkoutRelation === 'at') installBlockReasons.push('checkout_at_release');
    if (latest && !updateAvailable && checkoutRelation !== 'at') installBlockReasons.push('release_not_newer');
    if (checkout.versionTagMismatch) installBlockReasons.push('version_tag_mismatch');
    if (activeJob) installBlockReasons.push('update_in_progress');

    return {
      running,
      checkout,
      latest,
      checkoutChanged: checkout.sha !== running.sha,
      checkoutRelation,
      targetDescendsFromCheckout: checkoutRelation === 'unknown'
        ? null : checkoutRelation === 'behind' || checkoutRelation === 'at',
      updateAvailable,
      canApplyCheckout: applyBlockReasons.length === 0,
      // После `ls-remote` объект нового commit может ещё отсутствовать локально. В этом
      // случае worker сначала получит точный тег и повторит ancestry-preflight; unknown
      // не выдаём за divergence и не делаем кнопку навсегда недоступной.
      canInstallRelease: installBlockReasons.length === 0
        && ['behind', 'unknown'].includes(checkoutRelation) && updateAvailable,
      applyBlockReasons,
      installBlockReasons,
      blockReasons: installBlockReasons,
      checkedAt: persisted.releaseCheck?.checkedAt || null,
      checkError: persisted.releaseCheck?.checkError || null,
      job,
    };
  }

  async getStatus({ fresh = false }: { fresh?: boolean } = {}): Promise<ReleaseStatus> {
    if (!fresh && this.localCache && Date.now() - this.localCache.at < LOCAL_CACHE_MS) return this.localCache.value;
    const value = await this.#localStatus();
    this.localCache = { at: Date.now(), value };
    return value;
  }

  async checkRemote() {
    if (this.checkPromise) return this.checkPromise;
    this.checkPromise = (async () => {
      const result = await this.runner('git', ['-C', this.rootDir, 'ls-remote', '--tags', 'origin'], {
        cwd: this.rootDir,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        timeout: 15_000,
        maxBuffer: 2 * 1024 * 1024,
      });
      const checkedAt = this.now().toISOString();

      if (result.code !== 0) {
        await mutatePersistentState(this.statePath, (state) => ({
          ...state,
          releaseCheck: {
            ...(state.releaseCheck || {}),
            checkError: safeCheckError(result),
          },
        }));
      } else {
        const releases = parseRemoteTags(result.stdout);
        const found = releases.at(-1) || null;
        let url: string | null = null;
        if (found) {
          const remote = await this.runner('git', ['-C', this.rootDir, 'remote', 'get-url', 'origin'], {
            cwd: this.rootDir, timeout: 5000, maxBuffer: 64 * 1024,
          });
          if (remote.code === 0) url = releaseUrl(remote.stdout, found.tag);
        }
        const latest = found ? { version: found.version, tag: found.tag, sha: found.sha, url } : null;
        await mutatePersistentState(this.statePath, (state) => ({
          ...state,
          releaseCheck: { latest, checkedAt, checkError: null },
        }));
      }
      this.localCache = null;
      this.broadcast('grigdesk-update', { at: Date.now(), reason: 'remote-check' });
      return this.getStatus({ fresh: true });
    })().finally(() => { this.checkPromise = null; });
    return this.checkPromise;
  }

  start(): void {
    if (this.timers.length) return;
    const first = setTimeout(() => { this.checkRemote().catch(() => {}); }, this.initialCheckDelayMs);
    const interval = setInterval(() => { this.checkRemote().catch(() => {}); }, this.checkIntervalMs);
    first.unref?.();
    interval.unref?.();
    this.timers.push(first, interval);
  }

  stop(): void {
    for (const timer of this.timers) {
      clearTimeout(timer);
      clearInterval(timer as unknown as ReturnType<typeof setInterval>);
    }
    this.timers = [];
  }

  invalidate(): void { this.localCache = null; }

  async #cleanupBackups(job: UpdateJob): Promise<void> {
    const allowed = [
      `web/dist.grigdesk-backup-${job.id}`,
      `server/node_modules.grigdesk-backup-${job.id}`,
    ];
    const kept = Object.values(job.backups || {})
      .filter((relative): relative is string => Boolean(relative));

    for (const relative of kept) {
      if (!allowed.includes(relative)) continue;
      await rm(path.join(this.rootDir, relative), { recursive: true, force: true });
    }
    await mutatePersistentState(this.statePath, (state) => ({
      ...state,
      job: state.job?.id === job.id ? { ...state.job, backups: null } : state.job,
    }));
  }
}
