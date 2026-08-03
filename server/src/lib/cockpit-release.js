import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const TAG_RE = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA_RE = /^[0-9a-f]{40,64}$/i;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const LOCAL_CACHE_MS = 1500;
const STATE_SCHEMA = 1;

export class CockpitReleaseError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'CockpitReleaseError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function parseSemVer(value) {
  const match = VERSION_RE.exec(String(value || '').trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function compareSemVer(left, right) {
  const a = typeof left === 'string' ? parseSemVer(left) : left;
  const b = typeof right === 'string' ? parseSemVer(right) : right;
  if (!a || !b) throw new TypeError('Ожидалась строгая SemVer-версия');
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export function parseStableTag(value) {
  const match = TAG_RE.exec(String(value || '').trim());
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

/**
 * `ls-remote --tags` отдаёт для аннотированного тега две строки: объект тега и
 * peeled commit с `^{}`. Для обновления нужен именно commit SHA.
 */
export function parseRemoteTags(output) {
  const tags = new Map();
  for (const line of String(output || '').split(/\r?\n/)) {
    if (!line) continue;
    const [sha, ref] = line.trim().split(/\s+/, 2);
    if (!SHA_RE.test(sha || '') || !ref?.startsWith('refs/tags/')) continue;
    const peeled = ref.endsWith('^{}');
    const tag = ref.slice('refs/tags/'.length, peeled ? -3 : undefined);
    const version = parseStableTag(tag);
    if (!version) continue;
    const item = tags.get(tag) || { tag, version, sha: null, tagObjectSha: null, annotated: false };
    if (peeled) {
      item.sha = sha.toLowerCase();
      item.annotated = true;
    } else {
      item.tagObjectSha = sha.toLowerCase();
    }
    tags.set(tag, item);
  }
  // Stable-релизы обязаны быть аннотированными: lightweight ref намеренно игнорируем.
  return [...tags.values()]
    .filter((item) => item.annotated && item.sha)
    .sort((a, b) => compareSemVer(a.version, b.version));
}

export function releaseUrl(remote, tag) {
  if (!parseStableTag(tag)) return null;
  const value = String(remote || '').trim();
  let repo = null;
  let match = /^git@github\.com:([^/\s]+\/[^\s]+?)\/?$/.exec(value);
  if (match) repo = match[1];
  if (!repo) {
    try {
      const url = new URL(value);
      if (url.hostname === 'github.com') repo = url.pathname.replace(/^\/+|\/+$/g, '');
    } catch { /* не URL и не GitHub SCP syntax */ }
  }
  if (!repo) return null;
  repo = repo.replace(/\.git$/, '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return null;
  return `https://github.com/${repo}/releases/tag/${encodeURIComponent(tag)}`;
}

export function defaultCommandRunner(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(file, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeout ?? 10_000,
      maxBuffer: options.maxBuffer ?? 2 * 1024 * 1024,
      encoding: 'utf8',
    }, (error, stdout = '', stderr = '') => {
      resolve({
        code: error ? (Number.isInteger(error.code) ? error.code : 1) : 0,
        signal: error?.signal || null,
        timedOut: !!error?.killed,
        stdout: String(stdout),
        stderr: String(stderr),
      });
    });
  });
}

export async function readPersistentState(statePath) {
  try {
    const data = JSON.parse(await readFile(statePath, 'utf8'));
    return data && data.schemaVersion === STATE_SCHEMA ? data : { schemaVersion: STATE_SCHEMA };
  } catch {
    return { schemaVersion: STATE_SCHEMA };
  }
}

export async function writePersistentState(statePath, state) {
  await mkdir(path.dirname(statePath), { recursive: true });
  const tmp = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ ...state, schemaVersion: STATE_SCHEMA }, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, statePath);
  // rename сохраняет mode нового файла, но chmod через writeFile не меняет старый mode
  // при некоторых FS; повторная запись tmp гарантирует 0600 у опубликованного inode.
}

async function withStateWriteLock(statePath, fn) {
  const lockPath = `${statePath}.write-lock`;
  await mkdir(path.dirname(statePath), { recursive: true });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      // Умерший writer не должен навсегда заморозить состояние.
      try {
        const info = await stat(lockPath);
        if (Date.now() - info.mtimeMs > 30_000) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch { continue; }
      await new Promise((resolve) => { setTimeout(resolve, 20); });
      continue;
    }
    // Ошибка самого writer-а не является конфликтом lock-а, даже если случайно имеет
    // code=EEXIST. Освобождаем lock и отдаём исходную ошибку вызывающему коду.
    try { return await fn(); }
    finally { await rm(lockPath, { recursive: true, force: true }); }
  }
  throw new Error('state_write_lock_timeout');
}

export async function mutatePersistentState(statePath, mutator) {
  return withStateWriteLock(statePath, async () => {
    const current = await readPersistentState(statePath);
    const next = await mutator(current) || current;
    await writePersistentState(statePath, next);
    return next;
  });
}

function shortSha(sha) { return sha?.slice(0, 7) || ''; }

function displayVersion(exactTags, describe, sha) {
  const stable = exactTags.map(parseStableTag).filter(Boolean)
    .sort((a, b) => compareSemVer(b, a))[0];
  if (stable) return { version: `v${stable}`, stableVersion: stable, exactTag: `v${stable}` };
  const described = /^(v\d+\.\d+\.\d+)-(\d+)-g([0-9a-f]+)$/.exec(String(describe || '').trim());
  if (described && parseStableTag(described[1])) {
    const base = described[1].slice(1);
    return {
      version: `${described[1]}+${described[2]}.g${described[3]}`,
      stableVersion: base,
      exactTag: null,
    };
  }
  return { version: `dev.g${shortSha(sha)}`, stableVersion: null, exactTag: null };
}

function safeCheckError(result) {
  if (result?.timedOut) return { code: 'remote_timeout', message: 'Проверка обновлений превысила лимит времени.' };
  return { code: 'remote_unavailable', message: 'Не удалось проверить опубликованные релизы.' };
}

export class CockpitReleaseService {
  constructor({
    rootDir,
    statePath = path.join(rootDir, 'server', '.state', 'cockpit-update.json'),
    runner = defaultCommandRunner,
    now = () => new Date(),
    broadcast = () => {},
    checkIntervalMs = CHECK_INTERVAL_MS,
    initialCheckDelayMs = 30_000,
  }) {
    this.rootDir = rootDir;
    this.statePath = statePath;
    this.runner = runner;
    this.now = now;
    this.broadcast = broadcast;
    this.checkIntervalMs = checkIntervalMs;
    this.initialCheckDelayMs = initialCheckDelayMs;
    this.instanceId = randomUUID();
    this.runningPromise = this.#captureRunning();
    this.localCache = null;
    this.checkPromise = null;
    this.timers = [];
  }

  async #runGit(args, { timeout = 10_000, allow = [] } = {}) {
    const result = await this.runner('git', ['-C', this.rootDir, ...args], {
      cwd: this.rootDir, timeout, maxBuffer: 2 * 1024 * 1024,
    });
    if (result.code !== 0 && !allow.includes(result.code)) {
      throw new CockpitReleaseError('git_unavailable', 'Не удалось прочитать состояние Cockpit.', 503);
    }
    return result;
  }

  async #productVersion() {
    const raw = (await readFile(path.join(this.rootDir, 'VERSION'), 'utf8')).trim();
    if (!parseSemVer(raw)) throw new CockpitReleaseError('invalid_product_version', 'Файл VERSION содержит некорректную версию.', 500);
    return raw;
  }

  async #versionAt(sha) {
    const [tagResult, describeResult] = await Promise.all([
      this.#runGit(['tag', '--points-at', sha]),
      this.#runGit(['describe', '--tags', '--long', '--always', '--match', 'v[0-9]*.[0-9]*.[0-9]*', sha], { allow: [128] }),
    ]);
    return displayVersion(tagResult.stdout.split(/\r?\n/).filter(Boolean), describeResult.stdout, sha);
  }

  async #captureRunning() {
    const shaResult = await this.#runGit(['rev-parse', 'HEAD']);
    const sha = shaResult.stdout.trim().toLowerCase();
    if (!SHA_RE.test(sha)) throw new CockpitReleaseError('invalid_git_sha', 'Git вернул некорректную ревизию.', 500);
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

  async #checkout() {
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

  async #isAncestor(ancestor, descendant) {
    if (!SHA_RE.test(ancestor || '') || !SHA_RE.test(descendant || '')) return null;
    const result = await this.#runGit(['merge-base', '--is-ancestor', ancestor, descendant], { allow: [1, 128] });
    if (result.code === 128) return null; // remote commit ещё не получен локально
    return result.code === 0;
  }

  async relation(fromSha, targetSha) {
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

  async #localStatus() {
    const running = await this.runningPromise;
    const checkout = await this.#checkout();
    const persisted = await readPersistentState(this.statePath);
    let job = persisted.job || null;
    // Новый процесс является подтверждением рестарта. Worker намеренно оставляет job
    // в `restarting`, чтобы смерть старого процесса не могла объявить успех заранее.
    const newProcessInstance = !job?.previousRunningInstanceId
      || job.previousRunningInstanceId !== running.instanceId;
    if (job?.status === 'restarting' && job.targetSha === running.sha && newProcessInstance) {
      const completedAt = this.now().toISOString();
      const next = await mutatePersistentState(this.statePath, (state) => ({
        ...state,
        job: state.job?.id === job.id
          ? { ...state.job, status: 'done', stage: 'done', completedAt, error: null }
          : state.job,
      }));
      job = next.job || job;
      this.broadcast('cockpit-update', { at: Date.now(), reason: 'job-done' });
      try {
        await this.#cleanupBackups(job);
        job = { ...job, backups: null };
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
    const applyBlockReasons = [];
    if (checkout.dirty) applyBlockReasons.push('working_tree_dirty');
    if (activeJob) applyBlockReasons.push('update_in_progress');

    const installBlockReasons = [];
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

  async getStatus({ fresh = false } = {}) {
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
        let url = null;
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
      this.broadcast('cockpit-update', { at: Date.now(), reason: 'remote-check' });
      return this.getStatus({ fresh: true });
    })().finally(() => { this.checkPromise = null; });
    return this.checkPromise;
  }

  start() {
    if (this.timers.length) return;
    const first = setTimeout(() => { this.checkRemote().catch(() => {}); }, this.initialCheckDelayMs);
    const interval = setInterval(() => { this.checkRemote().catch(() => {}); }, this.checkIntervalMs);
    first.unref?.();
    interval.unref?.();
    this.timers.push(first, interval);
  }

  stop() {
    for (const timer of this.timers) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    this.timers = [];
  }

  invalidate() { this.localCache = null; }

  async #cleanupBackups(job) {
    const allowed = [
      `web/dist.cockpit-backup-${job.id}`,
      `server/node_modules.cockpit-backup-${job.id}`,
    ];
    for (const relative of Object.values(job.backups || {}).filter(Boolean)) {
      if (!allowed.includes(relative)) continue;
      await rm(path.join(this.rootDir, relative), { recursive: true, force: true });
    }
    await mutatePersistentState(this.statePath, (state) => ({
      ...state,
      job: state.job?.id === job.id ? { ...state.job, backups: null } : state.job,
    }));
  }
}
