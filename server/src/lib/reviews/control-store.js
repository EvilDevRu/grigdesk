// Небольшое durable-хранилище человеческих решений и очереди review-run.
// GitHub-снимки и model artifacts живут в ReviewStore, состояние исполнения —
// в ReviewStateStore. Здесь остаётся только связь между ними, которую нельзя
// держать в памяти: scope, очередь и индекс активного запуска одного PR.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { acquireKernelFileLock } from './kernel-lock.js';

const SCHEMA_VERSION = 1;

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function initialState(now) {
  const at = Number(typeof now === 'function' ? now() : now);
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    scopes: {},
    runLinks: {},
    activeRuns: {},
    queue: [],
    runClaims: {},
    runRetries: {},
    nextFence: 0,
    createdAt: at,
    updatedAt: at,
  };
}

function validate(state) {
  if (!state || state.schemaVersion !== SCHEMA_VERSION) {
    const error = new Error('Некорректная схема review control store');
    error.code = 'REVIEW_CONTROL_CORRUPT';
    throw error;
  }
  for (const field of ['scopes', 'runLinks', 'activeRuns']) {
    if (!state[field] || typeof state[field] !== 'object' || Array.isArray(state[field])) {
      const error = new Error(`Повреждён review control store: ${field}`);
      error.code = 'REVIEW_CONTROL_CORRUPT';
      throw error;
    }
  }
  if (!Array.isArray(state.queue)) {
    const error = new Error('Повреждён review control store: queue');
    error.code = 'REVIEW_CONTROL_CORRUPT';
    throw error;
  }
  if (state.runClaims != null
      && (!state.runClaims || typeof state.runClaims !== 'object' || Array.isArray(state.runClaims))) {
    const error = new Error('Повреждён review control store: runClaims');
    error.code = 'REVIEW_CONTROL_CORRUPT';
    throw error;
  }
  if (state.runRetries != null
      && (!state.runRetries || typeof state.runRetries !== 'object' || Array.isArray(state.runRetries))) {
    const error = new Error('Повреждён review control store: runRetries');
    error.code = 'REVIEW_CONTROL_CORRUPT';
    throw error;
  }
  return state;
}

function requireRunClaim(state, {
  runId,
  workerId,
  fencingToken,
  now,
  message,
}) {
  const claim = state.runClaims?.[runId];
  if (!claim
      || claim.workerId !== workerId
      || claim.fencingToken !== fencingToken
      || Number(claim.expiresAt || 0) <= Number(now)) {
    const error = new Error(message);
    error.code = 'STALE_FENCE';
    throw error;
  }
  return claim;
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fs.open(directory, 'r');
    await handle.sync();
  } catch (error) {
    // rename остаётся атомарным на FS без directory fsync, но EIO/ENOSPC
    // означают, что durable commit доказать нельзя.
    if (!['EINVAL', 'ENOTSUP', 'EBADF'].includes(error?.code)) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export class ReviewControlStore {
  constructor({
    filePath,
    stateDir,
    now = Date.now,
    lockTimeoutMs = 5_000,
    lockStaleMs = 30_000,
  } = {}) {
    this.filePath = filePath || path.join(String(stateDir || ''), 'control.json');
    if (!path.isAbsolute(this.filePath)) {
      throw new TypeError('ReviewControlStore требует абсолютный filePath/stateDir');
    }
    this.lockPath = `${this.filePath}.lock`;
    this.now = now;
    this.lockTimeoutMs = lockTimeoutMs;
    this.lockStaleMs = lockStaleMs;
    this.localTail = Promise.resolve();
  }

  async init() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    try {
      validate(JSON.parse(await fs.readFile(this.filePath, 'utf8')));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await this.#withLock(async (assertHeld) => {
        try {
          validate(JSON.parse(await fs.readFile(this.filePath, 'utf8')));
        } catch (inside) {
          if (inside?.code !== 'ENOENT') throw inside;
          await this.#write(initialState(this.now), { assertHeld });
        }
      });
    }
    return this;
  }

  async read() {
    await this.init();
    return clone(validate(JSON.parse(await fs.readFile(this.filePath, 'utf8'))));
  }

  async mutate(mutator, { commitGuard = null } = {}) {
    const operation = this.localTail.then(async () => {
      await this.init();
      return this.#withLock(async (assertHeld) => {
        const current = validate(JSON.parse(await fs.readFile(this.filePath, 'utf8')));
        const next = clone(current);
        const result = await mutator(next, clone(current));
        if (commitGuard) commitGuard(next, current);
        if (JSON.stringify(next) === JSON.stringify(current)) {
          return { changed: false, state: clone(current), result: clone(result) };
        }
        next.revision = current.revision + 1;
        next.updatedAt = Number(typeof this.now === 'function' ? this.now() : this.now);
        await this.#write(next, {
          assertHeld,
          assertCanCommit: commitGuard
            ? () => commitGuard(next, current)
            : undefined,
          expectedRevision: current.revision,
        });
        return { changed: true, state: clone(next), result: clone(result) };
      });
    });
    this.localTail = operation.catch(() => {});
    return operation;
  }

  async claimNextRun({ workerId, leaseMs = 120_000 } = {}) {
    if (!String(workerId || '')) throw new TypeError('claimNextRun требует workerId');
    const outcome = await this.mutate((state) => {
      state.runClaims ||= {};
      state.runRetries ||= {};
      state.nextFence = Math.max(0, Number(state.nextFence || 0));
      const now = Number(typeof this.now === 'function' ? this.now() : this.now);
      for (const [runId, claim] of Object.entries(state.runClaims)) {
        if (!claim || Number(claim.expiresAt || 0) <= now) delete state.runClaims[runId];
      }
      state.queue = state.queue.filter((runId) => {
        if (state.runLinks[runId]) return true;
        delete state.runRetries[runId];
        return false;
      });
      const runId = state.queue.find((candidate) => (
        !state.runClaims[candidate]
        && Number(state.runRetries[candidate]?.availableAt || 0) <= now
      ));
      if (!runId) return null;
      state.nextFence += 1;
      const claim = {
        workerId: String(workerId),
        fencingToken: state.nextFence,
        expiresAt: now + Math.max(1_000, Number(leaseMs) || 120_000),
      };
      state.runClaims[runId] = claim;
      return {
        runId,
        link: clone(state.runLinks[runId]),
        ...claim,
      };
    });
    return clone(outcome.result);
  }

  async renewRunClaim({
    runId,
    workerId,
    fencingToken,
    leaseMs = 120_000,
  } = {}) {
    const assertClaim = (state) => requireRunClaim(state, {
      runId,
      workerId,
      fencingToken,
      now: Number(typeof this.now === 'function' ? this.now() : this.now),
      message: 'Review run claim уже принадлежит другому worker',
    });
    const outcome = await this.mutate((state) => {
      state.runClaims ||= {};
      const claim = assertClaim(state);
      const now = Number(typeof this.now === 'function' ? this.now() : this.now);
      claim.expiresAt = now + Math.max(1_000, Number(leaseMs) || 120_000);
      return claim;
    }, {
      commitGuard: (_next, current) => assertClaim(current),
    });
    return clone(outcome.result);
  }

  async releaseRunClaim({ runId, workerId, fencingToken } = {}) {
    let claimed = false;
    const assertClaim = (state) => requireRunClaim(state, {
      runId,
      workerId,
      fencingToken,
      now: Number(typeof this.now === 'function' ? this.now() : this.now),
      message: 'Просроченный worker не может снять новый run claim',
    });
    const outcome = await this.mutate((state) => {
      state.runClaims ||= {};
      const claim = state.runClaims[runId];
      if (!claim) return false;
      assertClaim(state);
      claimed = true;
      delete state.runClaims[runId];
      return true;
    }, {
      commitGuard: (_next, current) => {
        if (claimed) assertClaim(current);
      },
    });
    return outcome.result;
  }

  /**
   * Отложить только тот run, которым всё ещё владеет вызывающий scheduler.
   * Запись retry и снятие claim атомарны; перенос в хвост не даёт одному
   * временно недоступному PR голодать всю очередь.
   */
  async deferRunClaim({
    runId,
    workerId,
    fencingToken,
    availableAt,
    error = null,
    countAttempt = true,
  } = {}) {
    const assertClaim = (state) => requireRunClaim(state, {
      runId,
      workerId,
      fencingToken,
      now: Number(typeof this.now === 'function' ? this.now() : this.now),
      message: 'Просроченный scheduler не может отложить run',
    });
    const outcome = await this.mutate((state) => {
      state.runClaims ||= {};
      state.runRetries ||= {};
      assertClaim(state);
      const now = Number(typeof this.now === 'function' ? this.now() : this.now);
      const previous = state.runRetries[runId] || {};
      const retry = {
        attempts: Number(previous.attempts || 0) + (countAttempt === false ? 0 : 1),
        availableAt: Math.max(now + 1_000, Number(availableAt) || now + 5_000),
        lastError: error ? {
          code: String(error.code || 'RUN_RETRY').slice(0, 128),
          message: String(error.message || 'Временная ошибка запуска').slice(0, 2_000),
          at: now,
        } : null,
      };
      state.runRetries[runId] = retry;
      delete state.runClaims[runId];
      state.queue = state.queue.filter((candidate) => candidate !== runId);
      if (state.runLinks[runId]) state.queue.push(runId);
      return retry;
    }, {
      commitGuard: (_next, current) => assertClaim(current),
    });
    return clone(outcome.result);
  }

  async completeRunClaim({
    runId,
    workerId,
    fencingToken,
    releaseActive = false,
  } = {}) {
    const assertClaim = (state) => requireRunClaim(state, {
      runId,
      workerId,
      fencingToken,
      now: Number(typeof this.now === 'function' ? this.now() : this.now),
      message: 'Просроченный scheduler не может завершить run claim',
    });
    const outcome = await this.mutate((state) => {
      state.runClaims ||= {};
      state.runRetries ||= {};
      assertClaim(state);
      const link = state.runLinks[runId];
      delete state.runClaims[runId];
      delete state.runRetries[runId];
      state.queue = state.queue.filter((candidate) => candidate !== runId);
      if (releaseActive && link && state.activeRuns[link.pullId] === runId) {
        delete state.activeRuns[link.pullId];
      }
      return true;
    }, {
      commitGuard: (_next, current) => assertClaim(current),
    });
    return outcome.result;
  }

  async clearRunRetry(runId) {
    const outcome = await this.mutate((state) => {
      state.runRetries ||= {};
      if (!state.runRetries[runId]) return false;
      delete state.runRetries[runId];
      return true;
    });
    return outcome.result;
  }

  async #withLock(action) {
    const lock = await acquireKernelFileLock({
      lockPath: this.lockPath,
      timeoutMs: this.lockTimeoutMs,
      timeoutCode: 'REVIEW_CONTROL_LOCK_TIMEOUT',
      unavailableCode: 'REVIEW_CONTROL_LOCK_UNAVAILABLE',
      lostCode: 'REVIEW_CONTROL_LOCK_LOST',
      label: 'review control store',
    });
    try {
      const result = await action(lock.assertHeld);
      lock.assertHeld();
      return result;
    } finally {
      await lock.release();
    }
  }

  async #write(state, {
    assertHeld = () => {},
    assertCanCommit = () => {},
    expectedRevision,
  } = {}) {
    const temporary = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      assertHeld();
      if (expectedRevision !== undefined) {
        const current = validate(JSON.parse(await fs.readFile(this.filePath, 'utf8')));
        if (current.revision !== expectedRevision) {
          const error = new Error('Review control state изменился после потери lock');
          error.code = 'REVIEW_CONTROL_CAS_MISMATCH';
          throw error;
        }
      }
      assertHeld();
      assertCanCommit();
      await fs.rename(temporary, this.filePath);
      assertHeld();
      await syncDirectory(path.dirname(this.filePath));
    } finally {
      await handle?.close().catch(() => {});
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }
}
