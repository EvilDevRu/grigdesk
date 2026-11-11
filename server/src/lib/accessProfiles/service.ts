import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { processOwnerState } from '../../../../shared/node/directoryLock.ts';
import type { DirectoryLockOwner } from '../../../../shared/node/directoryLock.ts';
import type {
  AccessAttempt, AccessProfileList, AccessSnapshot,
} from '../../../../shared/chat/accessProfileContracts.ts';
import type { ExecutorAdapter } from '../executors/index.ts';
import { AccessStore, readPrivate, accessStateDirectory } from './store.ts';
import { writeDurableFile } from '../durableFile.ts';
import { startCliLogin, type CliAttemptProcess } from './cliProcess.ts';
import { FactoryStateAdapter } from '../../adapters/factoryState.ts';
import type {
  AccessCapability, AccessConfig, AccessEvidence, AccessManifest, AccessOptions, PrivateAttempt,
  PrivateProfile, VerifiedAccess,
} from './types.ts';

interface Reservation {
  owner: DirectoryLockOwner;
  profileId: string;
}

interface PipelineAccess {
  task: string;
  attempt: string | null;
  launchId?: string;
  secretRef: string;
  profileId: string;
}

export interface SelectedAccess {
  snapshot: AccessSnapshot;
  env: NodeJS.ProcessEnv;
  keys: string[];
  profile: PrivateProfile;
  isCurrent(): Promise<boolean>;
  release(): Promise<void>;
}

export interface AccessParticipant {
  busy(provider: string): boolean;
  closeIdle(provider: string): Promise<void>;
}

const TERMINAL = new Set(['saved', 'failed', 'cancelled', 'interrupted', 'expired']);
const services = new Map<string, AccessProfileService>();

/**
 * Владелец определяется PID и временем старта, а не случайным ID экземпляра сервиса.
 * Это позволяет отличить аварийный рестарт от работы второго процесса с общим store.
 */
async function processIdentity(token: string, pid = process.pid): Promise<DirectoryLockOwner> {
  const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
  const starttime = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u)[19];

  if (!starttime) {
    throw new Error('Не удалось определить владельца попытки входа');
  }

  return {
    pid,
    starttime,
    token,
  };
}

/**
 * Ошибки общего сервиса содержат только безопасный код и объяснение.
 * Исключения транспорта и приватные ответы поставщика наружу не передаются.
 */
export function accessError(statusCode: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { statusCode, code });
}

/**
 * Публичный снимок попытки собирается явным allowlist.
 * Candidate, owner и сведения об аккаунте никогда не попадают в DTO.
 */
export function attemptView(attempt: PrivateAttempt): AccessAttempt {
  const { id, profileId, name, methodId, revision, expiresAt, state, step, error } = attempt;

  return {
    id,
    profileId,
    name,
    methodId,
    revision,
    expiresAt,
    state,
    step,
    ...(error ? { error } : {}),
  };
}

/**
 * Один сервис на каталог состояния используется также не-HTTP потребителями.
 * Реестр остаётся capability-oriented и не знает названий поставщиков.
 */
export function accessService(config: AccessConfig): AccessProfileService | undefined {
  return services.get(accessStateDirectory(config));
}

export class AccessProfileService {
  readonly store: AccessStore;
  readonly config: AccessConfig;
  readonly env: NodeJS.ProcessEnv;
  readonly options: AccessOptions;
  readonly owner = randomUUID();
  readonly participants = new Set<AccessParticipant>();
  readonly drivers = new Map<string, CliAttemptProcess>();
  readonly adaptersOf: () => Promise<Map<string, ExecutorAdapter>>;
  changed: (provider: string) => void = () => {};

  constructor(config: AccessConfig, env: NodeJS.ProcessEnv,
    adaptersOf: () => Promise<Map<string, ExecutorAdapter>>, options: AccessOptions = {}) {
    this.config = { ...config, stateDir: accessStateDirectory(config) };
    this.env = env;
    this.options = options;
    this.adaptersOf = adaptersOf;
    this.store = new AccessStore(config, options);
    services.set(accessStateDirectory(config), this);
  }

  /**
   * Capability проверяется у адаптера, включая синтетические расширения.
   * Старое подключение без capability не перенаправляется в новый store.
   */
  async adapter(provider: string): Promise<{ adapter: ExecutorAdapter; capability: AccessCapability }> {
    const adapter = (await this.adaptersOf()).get(provider);

    if (!adapter?.accessProfiles) {
      throw accessError(404, 'unsupported_access_profiles', 'Исполнитель не поддерживает профили доступа.');
    }

    return { adapter, capability: adapter.accessProfiles as AccessCapability };
  }

  /**
   * Первое чтение импортирует только объявленные подключения и сохраняет исходники.
   * Повторный запуск использует manifest и не создаёт дубликатов из старого env.
   */
  async manifest(provider: string): Promise<AccessManifest> {
    const saved = await this.store.read(provider);

    if (saved) {
      await this.reconcileAttempts(provider, saved);

      return saved;
    }

    const { capability } = await this.adapter(provider);
    const manifest: AccessManifest = {
      revision: 1,
      activeProfileId: null,
      profiles: [],
      attempts: [],
      operations: {},
    };

    for (const legacy of capability.legacy(this.env, this.config)) {
      const method = capability.methods.find((item) => item.id === legacy.methodId);

      if (!method) {
        continue;
      }

      const id = randomUUID();
      const profile: PrivateProfile = {
        id,
        name: method.label,
        methodId: method.id,
        ...(method.mode ? { mode: method.mode } : {}),
        authState: 'ready',
        revision: 1,
        accessRevision: 1,
        accountGeneration: 1,
        memoryGeneration: 1,
        secretRef: await this.store.secret(provider, legacy.env),
        evidence: { kind: 'unknown' },
      };

      manifest.profiles.push(profile);

      if (legacy.active) {
        manifest.activeProfileId = id;
      }
    }

    await this.store.write(provider, manifest);

    return manifest;
  }

  /**
   * После аварии сохранённый commit остаётся итогом, недоказанный вход прерывается.
   * Живой владелец другого процесса и неизвестная identity не считаются умершими.
   */
  async reconcileAttempts(provider: string, manifest: AccessManifest): Promise<void> {
    let changed = false;

    for (const attempt of manifest.attempts) {
      if (!attempt.ownerProcess
        || await processOwnerState(attempt.ownerProcess) !== 'dead') {
        continue;
      }

      if (attempt.childProcess && await processOwnerState(attempt.childProcess) !== 'dead') {
        if (await processOwnerState(attempt.childProcess) !== 'alive') {
          throw accessError(409, 'access_busy', 'Не удалось проверить завершение прежнего входа CLI.');
        }

        process.kill(attempt.childProcess.pid, 'SIGTERM');

        for (let check = 0; check < 40; check += 1) {
          if (await processOwnerState(attempt.childProcess) === 'dead') {
            break;
          }

          await new Promise((resolve) => setTimeout(resolve, 50));
        }

        if (await processOwnerState(attempt.childProcess) !== 'dead') {
          throw accessError(409, 'access_busy', 'Прежний процесс входа CLI ещё завершается.');
        }
      }

      if (attempt.loginStarting || attempt.childProcess) {
        delete attempt.loginStarting;
        delete attempt.childProcess;
        changed = true;
      }

      if (!TERMINAL.has(attempt.state)) {
        attempt.state = 'interrupted';
        attempt.revision += 1;
        attempt.step = {
          id: randomUUID(),
          kind: 'result',
          message: 'Вход прерван перезапуском сервера. Повторите попытку.',
        };
        changed = true;
      }
    }

    if (changed) {
      await this.store.write(provider, manifest);
    }
  }

  /**
   * Список раскрывает только редактируемые метаданные и способы входа.
   * Активность задаётся единственным отдельным идентификатором manifest.
   */
  async list(provider: string): Promise<AccessProfileList> {
    const { capability } = await this.adapter(provider);

    return this.store.locked(provider, async () => {
      const manifest = await this.manifest(provider);

      return {
        revision: manifest.revision,
        activeProfileId: manifest.activeProfileId,
        profiles: manifest.profiles.map(({ secretRef, evidence, memoryGeneration, ...profile }) => profile),
        methods: capability.methods,
      };
    });
  }

  /**
   * Все живые reservations проверяются по PID и времени старта.
   * Неизвестный владелец блокирует переключение; возраст файла не является разрешением.
   */
  async assertIdle(provider: string, ownAttempt?: string): Promise<void> {
    await this.assertNoLogin(provider, await this.manifest(provider), ownAttempt);

    const pipelines = path.join(this.store.directory(provider), 'pipelines');

    await fs.mkdir(pipelines, { recursive: true, mode: 0o700 });

    for (const name of await fs.readdir(pipelines)) {
      const file = path.join(pipelines, name);
      const pin = await readPrivate<PipelineAccess>(file);
      const ledger = pin && await this.pipelineLedger(pin.task);

      if (!pin || !ledger || pin.attempt && pin.attempt !== ledger.attempt
        || !ledger.terminal && ledger.cursor?.state !== 'stopped') {
        throw accessError(409, 'access_busy', 'Доступ закреплён за незавершённым конвейером.');
      }

      await fs.rm(file);
    }

    const directory = path.join(this.store.directory(provider), 'reservations');

    await fs.mkdir(directory, { recursive: true, mode: 0o700 });

    for (const name of await fs.readdir(directory)) {
      const file = path.join(directory, name);
      const reservation = await readPrivate<Reservation>(file);

      if (!reservation || await processOwnerState(reservation.owner) !== 'dead') {
        throw accessError(409, 'access_busy', 'Исполнитель занят. Дождитесь завершения работы.');
      }

      await fs.rm(file);
    }

    for (const participant of this.participants) {
      if (participant.busy(provider)) {
        throw accessError(409, 'access_busy', 'Исполнитель занят ходом, фоном или ожидающим заданием.');
      }
    }

    for (const participant of this.participants) {
      await participant.closeIdle(provider);
    }
  }

  /**
   * Неизолированный login занимает тот же допуск на всём сроке серверной попытки.
   * Запуск после проверки свободы не может обогнать ещё работающий мастер.
   */
  async assertNoLogin(provider: string, manifest: AccessManifest, ownAttempt?: string): Promise<void> {
    const { capability } = await this.adapter(provider);

    for (const attempt of manifest.attempts) {
      const method = capability.methods.find((item) => item.id === attempt.methodId);

      if (attempt.id === ownAttempt || !method || method.isolated) {
        continue;
      }

      const childRunning = attempt.childProcess
        && await processOwnerState(attempt.childProcess) !== 'dead';

      if (!TERMINAL.has(attempt.state) || attempt.loginStarting || childRunning) {
        throw accessError(409, 'access_busy', 'Завершите или отмените текущий вход исполнителя.');
      }
    }
  }

  /**
   * Закрепление записывается под тем же mutex до spawn и не зависит от PID сервера.
   * Пауза держит доступ; освобождение разрешает только проверенный журнал завершения.
   */
  async pinPipeline(provider: string, task: string, attempt: string | null,
    launchId?: string): Promise<NodeJS.ProcessEnv> {
    if (!/^[1-9][0-9]{0,18}$/u.test(task)) {
      throw accessError(400, 'invalid_task', 'Неверная задача конвейера.');
    }

    return this.store.locked(provider, async () => {
      const manifest = await this.manifest(provider);
      const directory = path.join(this.store.directory(provider), 'pipelines');
      const file = path.join(directory, `${task}.json`);
      const existing = await readPrivate<PipelineAccess>(file);

      if (existing) {
        const ledger = await this.pipelineLedger(task);
        const sameAttempt = !attempt || !existing.attempt || existing.attempt === attempt;
        const sameLaunch = !launchId || !existing.launchId || existing.launchId === launchId;

        if (sameAttempt && sameLaunch) {
          if (attempt && !existing.attempt) {
            if (!ledger || ledger.attempt !== attempt) {
              throw accessError(409, 'access_busy', 'Не подтверждена попытка закреплённого конвейера.');
            }

            existing.attempt = attempt;
            await writeDurableFile(file, JSON.stringify(existing));
          }

          return this.store.credentials(provider, existing.secretRef);
        }

        if (!ledger || ledger.attempt !== existing.attempt
          || !ledger.terminal && ledger.cursor?.state !== 'stopped') {
          throw accessError(409, 'access_busy', 'Другая попытка уже использует этот доступ.');
        }

        await fs.rm(file);
      }

      await this.assertNoLogin(provider, manifest);

      const profile = manifest.profiles.find((item) => item.id === manifest.activeProfileId);

      if (!profile || profile.authState === 'needs-auth') {
        throw accessError(409, 'access_auth_required', 'Войдите в профиль перед запуском конвейера.');
      }

      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await writeDurableFile(file, JSON.stringify({
        task,
        attempt,
        ...(launchId ? { launchId } : {}),
        profileId: profile.id,
        secretRef: profile.secretRef,
      }));

      return this.store.credentials(provider, profile.secretRef);
    });
  }

  /**
   * Журнал Factory подтверждает identity и завершение независимо от процесса сервера.
   * Непроверенная проекция не разрешает освободить или перепривязать доступ.
   */
  async pipelineLedger(task: string) {
    return new FactoryStateAdapter({
      stateDir: String(this.config.stateDir),
      controlDir: String(this.config.factoryControlDir),
      profilesDir: String(this.config.profilesDir),
    }).readTrustedAttempt(task).catch(() => null);
  }

  /**
   * Возобновление включает прежние pins, даже если цепочку этапа поменяли на паузе.
   * Новый исполнитель получает допуск отдельно; старый профиль не подменяется active.
   */
  async pinnedProviders(task: string): Promise<string[]> {
    const providers: string[] = [];

    for (const adapter of (await this.adaptersOf()).values()) {
      if (!adapter.accessProfiles) {
        continue;
      }

      const file = path.join(this.store.directory(adapter.id), 'pipelines', `${task}.json`);

      if (await readPrivate<PipelineAccess>(file)) {
        providers.push(adapter.id);
      }
    }

    return providers;
  }

  /**
   * Живой движок получил окружение при запуске и не может принять новый доступ втайне.
   * Новый участник допускается на паузе перед resume; уже закреплённый доступ неизменен.
   */
  async admitPipelineProvider(provider: string, task: string, attempt: string, alive: boolean) {
    if (!(await this.adaptersOf()).get(provider)?.accessProfiles) {
      return;
    }

    const pins = await this.pinnedProviders(task);

    if (alive && !pins.includes(provider)) {
      throw accessError(409, 'access_restart_required',
        'Приостановите конвейер перед добавлением исполнителя, затем продолжите прогон.');
    }

    await this.pinPipeline(provider, task, attempt);
  }

  /**
   * Подтверждённый HTTP start связывает предварительный dispatch pin с точной попыткой.
   * До этого сбой оставляет консервативную блокировку вместо подстановки нового доступа.
   */
  async sealPipeline(task: string, launchId: string, attempt: string): Promise<void> {
    const ledger = await this.pipelineLedger(task);

    if (!ledger || ledger.attempt !== attempt
      || ledger.queueDispatchId && ledger.queueDispatchId !== launchId) {
      throw accessError(409, 'access_busy', 'Не подтверждена identity нового конвейера.');
    }

    for (const adapter of (await this.adaptersOf()).values()) {
      if (!adapter.accessProfiles) {
        continue;
      }

      await this.store.locked(adapter.id, async () => {
        const file = path.join(this.store.directory(adapter.id), 'pipelines', `${task}.json`);
        const pin = await readPrivate<PipelineAccess>(file);

        if (pin?.launchId === launchId) {
          pin.attempt = attempt;
          await writeDurableFile(file, JSON.stringify(pin));
        }
      });
    }
  }

  /**
   * До границы spawn не было внешнего исполнения, поэтому свой dispatch можно снять.
   * После неё этот метод не вызывается: неизвестный результат сохраняет закрепление.
   */
  async discardPipelineLaunch(provider: string, task: string, launchId: string): Promise<void> {
    await this.store.locked(provider, async () => {
      const file = path.join(this.store.directory(provider), 'pipelines', `${task}.json`);
      const pin = await readPrivate<PipelineAccess>(file);

      if (pin?.launchId === launchId && !pin.attempt) {
        await fs.rm(file);
      }
    });
  }

  /**
   * Чтение активной ревизии и reservation происходят под одним mutex с переключением.
   * Снимок не зависит от последующей мутации process.env или пользовательского запроса.
   */
  async select(provider: string, work = true): Promise<SelectedAccess | null> {
    if (!(await this.adaptersOf()).get(provider)?.accessProfiles) {
      return null;
    }

    return this.store.locked(provider, async () => {
      const manifest = await this.manifest(provider);
      const profile = manifest.profiles.find((item) => item.id === manifest.activeProfileId);

      if (work) {
        await this.assertNoLogin(provider, manifest);
      }

      if (!profile) {
        return null;
      }

      if (work && profile.authState === 'needs-auth') {
        throw accessError(409, 'access_auth_required', 'Требуется повторный вход в профиль доступа.');
      }

      const credentials = await this.store.credentials(provider, profile.secretRef);
      const env = { ...this.env };
      const keys: string[] = [];

      for (const adapter of (await this.adaptersOf()).values()) {
        const capability = adapter.accessProfiles as AccessCapability | undefined;

        for (const key of capability?.envKeys ?? []) {
          keys.push(key);
          delete env[key];
        }
      }

      Object.assign(env, credentials);
      keys.push(...Object.keys(credentials).filter((key) => !keys.includes(key)));

      let reservation: string | undefined;

      if (work) {
        const directory = path.join(this.store.directory(provider), 'reservations');
        const stat = await fs.readFile(`/proc/${process.pid}/stat`, 'utf8');
        const starttime = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u)[19];

        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        reservation = path.join(directory, `${randomUUID()}.json`);
        await writeDurableFile(reservation, JSON.stringify({
          owner: {
            pid: process.pid,
            starttime,
            token: this.owner,
          },
          profileId: profile.id,
        }));
      }

      return {
        profile: { ...profile },
        isCurrent: async () => {
          const latest = await this.store.read(provider);
          const active = latest?.profiles.find((item) => item.id === latest.activeProfileId);

          return active?.id === profile.id && active.accessRevision === profile.accessRevision;
        },
        env: Object.freeze(env),
        keys,
        snapshot: Object.freeze({
          profileId: profile.id,
          accessRevision: profile.accessRevision,
          accountGeneration: profile.accountGeneration,
          scope: `${profile.id}/${profile.accountGeneration}/${profile.accessRevision}`,
        }),
        release: async () => {
          if (reservation) {
            await fs.rm(reservation, { force: true });
          }
        },
      };
    });
  }

  /**
   * Ответ относится только к прочитанной ревизии: поздний refresh не меняет новый вход.
   * Отозванный доступ блокирует запуск; обычное обновление токена сохраняет аккаунт.
   */
  async observe(provider: string, snapshot: AccessSnapshot, result: unknown, refreshed: boolean) {
    await this.store.locked(provider, async () => {
      const manifest = await this.manifest(provider);
      const profile = manifest.profiles.find((item) => item.id === snapshot.profileId);

      if (!profile || profile.accessRevision !== snapshot.accessRevision) {
        return;
      }

      const state = (result as { state?: string } | null)?.state;
      const revoked = state === 'auth_required';

      if (!refreshed && (!revoked || profile.authState === 'needs-auth')) {
        return;
      }

      profile.authState = revoked ? 'needs-auth' : profile.authState;
      profile.revision += 1;
      profile.accessRevision += 1;
      manifest.revision += 1;
      await this.store.write(provider, manifest);
      this.changed(provider);
    });
  }

  /**
   * Изменение метаданных и активация имеют независимые CAS и operationId.
   * Повтор потерянного ACK возвращает доказанный результат до проверки старой ревизии.
   */
  async mutate(provider: string, id: string, action: string, body: Record<string, unknown>) {
    return this.store.locked(provider, async () => {
      const manifest = await this.manifest(provider);
      const operationId = this.operationId(body);

      if (Object.hasOwn(manifest.operations, operationId)) {
        return manifest.operations[operationId];
      }

      const profile = manifest.profiles.find((item) => item.id === id);

      if (!profile) {
        throw accessError(404, 'unknown_profile', 'Профиль не найден.');
      }

      const revision = action === 'activate' ? manifest.revision : profile.revision;

      if (body.expectedRevision !== revision) {
        throw accessError(409, 'stale_revision', 'Профиль изменён в другом окне. Обновите список.');
      }

      if (action === 'activate') {
        await this.assertIdle(provider);
        manifest.activeProfileId = id;
      } else if (action === 'delete') {
        if (manifest.activeProfileId === id || manifest.attempts.some((item) =>
          item.profileId === id && !TERMINAL.has(item.state))) {
          throw accessError(409, 'profile_in_use', 'Сначала выберите другой профиль или завершите вход.');
        }

        manifest.profiles = manifest.profiles.filter((item) => item.id !== id);
      } else {
        profile.name = this.name(body.name);
        profile.revision += 1;
      }

      manifest.revision += 1;
      manifest.operations[operationId] = { state: 'completed', profileId: id };
      await this.store.write(provider, manifest, true);
      this.changed(provider);

      const { secretRef, evidence, memoryGeneration, ...view } = profile;

      return { state: 'completed', profile: view };
    });
  }

  operationId(body: Record<string, unknown>): string {
    if (typeof body.operationId !== 'string' || !/^[\w-]{1,160}$/u.test(body.operationId)
      || Object.hasOwn(Object.prototype, body.operationId)) {
      throw accessError(400, 'invalid_operation', 'Нужен идентификатор операции.');
    }

    return body.operationId;
  }

  name(value: unknown): string {
    if (typeof value !== 'string' || !value.trim() || value.length > 120) {
      throw accessError(400, 'invalid_name', 'Укажите имя профиля длиной до 120 символов.');
    }

    return value.trim();
  }

  /**
   * Создание устойчиво связывает operationId с одной попыткой до запуска login.
   * Произвольные команды, окружение и home не входят во входной контракт.
   */
  async create(provider: string, body: Record<string, unknown>): Promise<AccessAttempt> {
    const { capability } = await this.adapter(provider);
    const op = this.operationId(body);

    const allowed = ['operationId', 'name', 'methodId', 'profileId', 'client'];

    if (Object.keys(body).some((key) => !allowed.includes(key))) {
      throw accessError(400, 'invalid_fields', 'Параметры запуска определяет адаптер.');
    }

    const method = capability.methods.find((item) => item.id === body.methodId);

    if (!method) {
      throw accessError(400, 'unsupported_method', 'Способ входа не поддерживается.');
    }

    let created = false;
    const result = await this.store.locked(provider, async () => {
      const manifest = await this.manifest(provider);
      const previous = Object.hasOwn(manifest.operations, op)
        ? manifest.operations[op]?.attemptId : undefined;

      if (previous) {
        return attemptView(manifest.attempts.find((item) => item.id === previous)!);
      }

      const target = manifest.profiles.find((item) => item.id === body.profileId);

      if (body.profileId && !target) {
        throw accessError(404, 'unknown_profile', 'Профиль не найден.');
      }

      if (target && target.methodId !== method.id) {
        throw accessError(400, 'profile_method_mismatch',
          'Другой способ доступа сохраняется отдельным профилем.');
      }

      if (!method.isolated) {
        await this.assertIdle(provider);
      }

      const attempt: PrivateAttempt = {
        id: randomUUID(),
        name: this.name(body.name),
        methodId: method.id,
        ...(typeof body.profileId === 'string' ? { profileId: body.profileId } : {}),
        revision: 1,
        profileRevision: manifest.profiles.find((item) => item.id === body.profileId)?.revision,
        owner: this.owner,
        ownerProcess: await processIdentity(this.owner),
        ...(method.kind === 'cli' ? { loginStarting: true } : {}),
        expiresAt: new Date((this.options.now?.() ?? Date.now()) + 10 * 60_000).toISOString(),
        state: 'pending',
        step: {
          id: randomUUID(),
          kind: method.kind === 'api-key' ? 'fields' : 'waiting',
          fields: method.fields,
        },
      };

      manifest.attempts.push(attempt);
      manifest.operations[op] = { state: 'completed', attemptId: attempt.id };
      await this.store.write(provider, manifest);
      created = true;
      this.changed(provider);

      return attemptView(attempt);
    });

    if (created && method.kind === 'cli') {
      const context = {
        config: this.config,
        env: this.env,
        fetchImpl: this.options.fetchImpl ?? fetch,
        adapter: (await this.adapter(provider)).adapter,
        method,
        home: path.join(this.store.directory(provider), 'homes', result.id),
      };

      let driver: CliAttemptProcess | undefined;

      try {
        driver = await startCliLogin(capability, context, {
          started: async (pid) => {
            const identity = await processIdentity(this.owner, pid);

            await this.updateLoginLifecycle(provider, result.id, (attempt) => {
              attempt.childProcess = identity;
            });
          },
          step: (step) => this.updateAttempt(provider, result.id, (attempt) => {
            attempt.step = step;
          }),
          complete: (verified) => this.complete(provider, result.id, verified, false, op),
          failed: (code) => this.updateAttempt(provider, result.id, (attempt) => {
            attempt.state = 'failed';
            attempt.error = { code, message: 'Не удалось завершить вход CLI. Повторите попытку.' };
            attempt.step = { id: randomUUID(), kind: 'result' };
          }),
        });

        this.drivers.set(result.id, driver);
        void driver.finished.finally(() => {
          if (this.drivers.get(result.id) === driver) {
            this.drivers.delete(result.id);
          }
        }).catch(() => {});

        if (TERMINAL.has((await this.attempt(provider, result.id)).state)) {
          await driver.cancel();
        }
      } catch {
        await driver?.cancel();
        await this.updateAttempt(provider, result.id, (attempt) => {
          attempt.state = 'failed';
          attempt.error = { code: 'unsupported', message: 'Эта версия CLI не поддерживает мастер входа.' };
          attempt.step = { id: randomUUID(), kind: 'result' };
        });
      } finally {
        await this.updateLoginLifecycle(provider, result.id, (attempt) => {
          delete attempt.loginStarting;
        });
      }
    }

    return this.attempt(provider, result.id);
  }

  /**
   * Срок проверяется сервером при любом чтении и перед вводом.
   * Истёкший шаг становится terminal и не может примениться поздним callback.
   */
  async attempt(provider: string, id: string): Promise<AccessAttempt> {
    return this.store.locked(provider, async () => {
      const manifest = await this.manifest(provider);
      const attempt = manifest.attempts.find((item) => item.id === id);

      if (!attempt) {
        throw accessError(404, 'unknown_attempt', 'Попытка не найдена.');
      }

      if (!TERMINAL.has(attempt.state)
        && Date.parse(attempt.expiresAt) <= (this.options.now?.() ?? Date.now())) {
        attempt.state = 'expired';
        attempt.revision += 1;
        attempt.step = {
          id: randomUUID(),
          kind: 'result',
          message: 'Срок входа истёк. Повторите попытку.',
        };
        await this.store.write(provider, manifest);
        this.changed(provider);
        await this.drivers.get(id)?.cancel();
      }

      return attemptView(attempt);
    });
  }

  /**
   * Ввод сначала получает устойчивое подтверждение приёма, затем проверяется вне lock.
   * Отмена может обогнать ответ поставщика; commit повторно проверяет terminal и CAS.
   */
  async submit(provider: string, id: string, stepId: string, body: Record<string, unknown>) {
    await this.attempt(provider, id);

    const op = this.operationId(body);
    const { adapter, capability } = await this.adapter(provider);
    const pending = await this.store.locked(provider, async () => {
      const manifest = await this.manifest(provider);
      const attempt = manifest.attempts.find((item) => item.id === id)!;

      if (Object.hasOwn(manifest.operations, op)) {
        return null;
      }

      if (TERMINAL.has(attempt.state) || attempt.step.id !== stepId
        || attempt.revision !== body.expectedRevision) {
        throw accessError(409, 'stale_step', 'Шаг уже завершён или изменён. Обновите состояние входа.');
      }

      const input = body.input;

      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw accessError(400, 'invalid_input', 'Проверьте поля входа.');
      }

      const choice = attempt.step.kind === 'choice';

      if (choice && (input as Record<string, unknown>).choice !== 'confirm') {
        throw accessError(400, 'invalid_choice', 'Подтвердите замену доступа или отмените вход.');
      }

      const original = { ...attempt };

      attempt.state = 'verifying';
      attempt.revision += 1;
      attempt.step = { id: randomUUID(), kind: 'verifying' };
      manifest.operations[op] = { state: 'completed', attemptId: id };
      await this.store.write(provider, manifest);

      return {
        attempt: original,
        input: input as Record<string, unknown>,
        choice,
      };
    });

    if (pending) {
      try {
        const method = capability.methods.find((item) => item.id === pending.attempt.methodId)!;

        if (method.kind === 'cli' && !pending.choice) {
          const driver = this.drivers.get(id);

          if (!driver) {
            throw accessError(409, 'interrupted', 'Вход CLI прерван. Повторите попытку.');
          }

          await driver.input(pending.input);

          return this.attempt(provider, id);
        }

        const verified = pending.choice
          ? { env: await this.store.credentials(provider, pending.attempt.candidate!),
            evidence: pending.attempt.evidence! }
          : await capability.verify!(pending.input, {
            config: this.config,
            env: this.env,
            fetchImpl: this.options.fetchImpl ?? fetch,
            adapter,
            method,
            home: path.join(this.store.directory(provider), 'homes', pending.attempt.id),
          });

        await this.complete(provider, id, verified, pending.choice, op);
      } catch (error) {
        const code = (error as { code?: string }).code ?? 'save_failed';

        await this.updateAttempt(provider, id, (attempt) => {
          attempt.state = 'failed';
          attempt.error = { code, message: 'Не удалось завершить вход. Проверьте доступ и повторите.' };
          attempt.step = { id: randomUUID(), kind: 'result' };
        });
      }
    }

    return this.attempt(provider, id);
  }

  /**
   * Проверенный вход сохраняется отдельно от активации.
   * Unknown и смена известного аккаунта требуют устойчивого шага подтверждения.
   */
  async complete(provider: string, id: string, verified: VerifiedAccess, confirmed: boolean, op: string) {
    const { adapter, capability } = await this.adapter(provider);
    const comparison = await this.store.locked(provider, async () => {
      const manifest = await this.manifest(provider);
      const attempt = manifest.attempts.find((item) => item.id === id)!;
      const previous = manifest.profiles.find((item) => item.id === attempt.profileId);
      const method = capability.methods.find((item) => item.id === attempt.methodId)!;

      if (confirmed || TERMINAL.has(attempt.state) || !previous
        || previous.evidence.kind !== 'unknown' || verified.evidence.kind !== 'known'
        || !capability.verify || method.kind !== 'api-key') {
        return null;
      }

      return {
        revision: previous.revision,
        env: await this.store.credentials(provider, previous.secretRef),
        method,
      };
    });
    let previousEvidence: AccessEvidence | undefined;

    if (comparison) {
      try {
        const result = await capability.verify!(comparison.env, {
          config: this.config,
          env: this.env,
          fetchImpl: this.options.fetchImpl ?? fetch,
          adapter,
          method: comparison.method,
          home: '',
        });

        previousEvidence = result.evidence;
      } catch {
        // Старый ключ может быть отозван: новый доступ сохраняется после явного выбора.
        // Отказ сравнения не доказывает ни совпадение, ни смену аккаунта.
        previousEvidence = { kind: 'unknown' };
      }
    }

    await this.store.locked(provider, async () => {
      const manifest = await this.manifest(provider);
      const attempt = manifest.attempts.find((item) => item.id === id)!;

      if (TERMINAL.has(attempt.state)) {
        return;
      }

      if (Date.parse(attempt.expiresAt) <= (this.options.now?.() ?? Date.now())) {
        attempt.state = 'expired';
        attempt.revision += 1;
        attempt.step = {
          id: randomUUID(),
          kind: 'result',
          message: 'Срок входа истёк.',
        };
        await this.store.write(provider, manifest);

        return;
      }

      const method = capability.methods.find((item) => item.id === attempt.methodId)!;
      const previous = manifest.profiles.find((item) => item.id === attempt.profileId);

      if (attempt.profileId && (!previous || previous.revision !== attempt.profileRevision)) {
        throw accessError(409, 'stale_revision', 'Доступ изменён во время повторного входа. Начните заново.');
      }

      const evidence = comparison?.revision === previous?.revision
        ? previousEvidence ?? previous?.evidence : previous?.evidence;
      const unknown = evidence?.kind !== 'known' || verified.evidence.kind !== 'known';
      const changed = previous && (unknown || evidence?.account !== verified.evidence.account);

      if (changed && !confirmed) {
        attempt.candidate = await this.store.secret(provider, verified.env);
        attempt.evidence = verified.evidence;
        attempt.state = 'pending';
        attempt.revision += 1;
        attempt.step = {
          id: randomUUID(),
          kind: 'choice',
          reason: unknown ? 'account_unknown' : 'account_mismatch',
          message: unknown
            ? 'Аккаунт не удалось определить; новый ключ может относиться к другому аккаунту'
            : 'Вход выполнен в другой аккаунт. Подтвердите замену доступа.',
          choices: [{ id: 'confirm', label: 'Подтвердить' }],
        };
        await this.store.write(provider, manifest);
        this.changed(provider);

        return;
      }

      if (previous && manifest.activeProfileId === previous.id) {
        await this.assertIdle(provider, id);
      }

      const resume = previous && !changed && capability.canResume
        ? await capability.canResume(await this.store.credentials(provider, previous.secretRef), verified)
        : false;
      const memoryGeneration = previous
        ? (previous.memoryGeneration ?? previous.accountGeneration) + (resume ? 0 : 1) : 1;
      const profile: PrivateProfile = {
        id: previous?.id ?? randomUUID(),
        name: previous?.name ?? attempt.name,
        methodId: method.id,
        ...(method.mode ? { mode: method.mode } : {}),
        authState: 'ready',
        revision: (previous?.revision ?? 0) + 1,
        accessRevision: (previous?.accessRevision ?? 0) + 1,
        accountGeneration: (previous?.accountGeneration ?? 1) + (changed ? 1 : 0),
        memoryGeneration,
        secretRef: await this.store.secret(provider, verified.env),
        evidence: verified.evidence,
      };

      manifest.profiles = [...manifest.profiles.filter((item) => item.id !== profile.id), profile];
      manifest.revision += 1;
      attempt.profileId = profile.id;
      attempt.state = 'saved';
      attempt.revision += 1;
      attempt.step = {
        id: randomUUID(),
        kind: 'result',
        message: 'Профиль сохранён.',
      };
      manifest.operations[op] = {
        state: 'completed',
        attemptId: id,
        profileId: profile.id,
      };
      await this.store.write(provider, manifest, true);
      this.changed(provider);
    });
  }

  /**
   * Callback меняет только ещё живую попытку под тем же mutex.
   * Поздний успех и поздняя ошибка не оживляют отменённый login.
   */
  async updateAttempt(provider: string, id: string, update: (attempt: PrivateAttempt) => void) {
    await this.store.locked(provider, async () => {
      const manifest = await this.manifest(provider);
      const attempt = manifest.attempts.find((item) => item.id === id)!;

      if (TERMINAL.has(attempt.state)) {
        return;
      }

      update(attempt);
      attempt.revision += 1;
      await this.store.write(provider, manifest);
      this.changed(provider);
    });
  }

  /**
   * Identity процесса сохраняется даже после отмены во время подготовки CLI.
   * Terminal запрещает результат login, но не снимает защиту от ещё живого процесса.
   */
  async updateLoginLifecycle(provider: string, id: string, update: (attempt: PrivateAttempt) => void) {
    await this.store.locked(provider, async () => {
      const manifest = await this.manifest(provider);
      const attempt = manifest.attempts.find((item) => item.id === id)!;

      update(attempt);
      await this.store.write(provider, manifest);
    });
  }

  /**
   * Отмена сохраняется до остановки дочернего login и остаётся terminal при рестарте.
   * Повтор начинает новый attempt с новым сроком, сохраняя прежний результат.
   */
  async cancel(provider: string, id: string, body: Record<string, unknown>) {
    const op = this.operationId(body);

    await this.store.locked(provider, async () => {
      const manifest = await this.manifest(provider);
      const attempt = manifest.attempts.find((item) => item.id === id);

      if (!attempt) {
        throw accessError(404, 'unknown_attempt', 'Попытка не найдена.');
      }

      if (Object.hasOwn(manifest.operations, op)) {
        return;
      }

      if (!TERMINAL.has(attempt.state)) {
        if (body.expectedRevision !== attempt.revision) {
          throw accessError(409, 'stale_revision', 'Состояние входа изменилось.');
        }

        attempt.state = 'cancelled';
        attempt.revision += 1;
        attempt.step = {
          id: randomUUID(),
          kind: 'result',
          message: 'Вход отменён.',
        };
      }

      manifest.operations[op] = { state: 'completed', attemptId: id };
      await this.store.write(provider, manifest);
      this.changed(provider);
    });
    await this.drivers.get(id)?.cancel();

    return this.attempt(provider, id);
  }

  /**
   * При штатном закрытии недоказанные собственные попытки становятся interrupted.
   * Результат уже выполненного commit не меняется и восстанавливается чтением.
   */
  async close(): Promise<void> {
    for (const adapter of (await this.adaptersOf()).values()) {
      if (!adapter.accessProfiles) {
        continue;
      }

      await this.store.locked(adapter.id, async () => {
        const manifest = await this.store.read(adapter.id);

        if (!manifest) {
          return;
        }

        for (const attempt of manifest.attempts) {
          if (attempt.owner === this.owner && !TERMINAL.has(attempt.state)) {
            attempt.state = 'interrupted';
            attempt.revision += 1;
            attempt.step = {
              id: randomUUID(),
              kind: 'result',
              message: 'Вход прерван. Повторите попытку.',
            };
          }
        }

        await this.store.write(adapter.id, manifest);
      });
    }

    await Promise.all([...this.drivers.values()].map((driver) => driver.cancel()));

    if (services.get(String(this.config.stateDir)) === this) {
      services.delete(String(this.config.stateDir));
    }
  }
}
