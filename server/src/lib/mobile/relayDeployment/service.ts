import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';

import {
  decodeDeploymentInput,
} from '../../../../../shared/mobile/relayDeploymentContracts.ts';
import type {
  DeploymentJob, DeploymentState,
} from '../../../../../shared/mobile/relayDeploymentContracts.ts';
import type { SshTransport, SshTransportSession } from '../../ssh/transport.ts';
import type { HostKeyStore } from '../../ssh/hostKeys.ts';
import type { MobileService } from '../service.ts';
import { MobileInputError } from '../errors.ts';
import { resolveRelayArtifact } from './artifact.ts';
import type { ArtifactOptions, RelayArtifact } from './artifact.ts';
import { DeploymentStateStore } from './stateStore.ts';
import type { DeploymentRecord } from './stateStore.ts';
import { preflight } from './preflight.ts';
import { installRelay } from './installer.ts';
import type { RelayInstallation } from './installer.ts';
import { candidateAddress, verifyCandidate } from './candidate.ts';
import type { CandidateOptions } from './candidate.ts';

export interface DeploymentOptions extends ArtifactOptions {
  transport: SshTransport;
  hostKeys: HostKeyStore;
  now?: () => number;
  verifyCandidate?: (options: CandidateOptions) => Promise<{ verified: boolean; address: string }>;
}

interface Credentials {
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

interface Worker {
  session: SshTransportSession;
  artifact: RelayArtifact;
  expires: number;
  timer: ReturnType<typeof setTimeout>;
}

const terminal: DeploymentState[] = ['ready', 'failed', 'interrupted', 'recovery_required'];

/**
 * Единый владелец заданий для desktop и ctl; HTTP управляет только durable переходами.
 * Секреты не входят в журнал, а принятое действие не зависит от жизни клиента.
 */
export class RelayDeploymentService {
  private store: DeploymentStateStore;
  private workers = new Map<string, Worker>();
  private sessions = new Set<SshTransportSession>();
  private generation = 0;
  private stopped = false;

  private directory: string;
  private mobile: MobileService;
  private options: DeploymentOptions;
  private runtime: {
    fp: () => string;
    vpnGate: CandidateOptions['vpnGate'];
    clientTarget: () => Promise<number>;
    changed: () => void;
    sync: () => Promise<void>;
  };

  constructor(
    directory: string,
    mobile: MobileService,
    options: DeploymentOptions,
    runtime: {
      fp: () => string;
      vpnGate: CandidateOptions['vpnGate'];
      clientTarget: () => Promise<number>;
      changed: () => void;
      sync: () => Promise<void>;
    },
  ) {
    this.directory = directory;
    this.mobile = mobile;
    this.options = options;
    this.runtime = runtime;
    this.store = new DeploymentStateStore(directory);
  }

  /**
   * Boot не повторяет внешние эффекты: старые активные стадии становятся interrupted.
   * Сохранённые ключи и маршруты при восстановлении журнала не меняются.
   */
  async recover(): Promise<void> {
    await this.store.mutate((records) => {
      for (const { job } of records) {
        if (!terminal.includes(job.state)) {
          job.state = 'interrupted';
          job.revision += 1;
          job.error = { code: 'credentials_required' };
        }
      }
    });
  }

  async list(requestId?: string): Promise<DeploymentJob[]> {
    return (await this.store.read()).map((record) => record.job)
      .filter((job) => !requestId || job.requestId === requestId);
  }

  async get(id: string): Promise<DeploymentJob> {
    const job = (await this.list()).find((item) => item.id === id);

    if (!job) {
      throw new MobileInputError('deployment_not_found', 'Задание не найдено.', 404);
    }

    return job;
  }

  /**
   * Admission сериализован вместе с квитанцией создания и проверяет выбранный домашний сервер.
   * Повтор requestId возвращает прежний draft, а другая цель не меняет его смысл.
   */
  async create(value: unknown): Promise<DeploymentJob> {
    let input;

    try {
      input = decodeDeploymentInput(value);
    } catch {
      throw new MobileInputError('bad_deployment_input', 'Проверьте параметры подключения.');
    }

    if (input.expectedServerFp !== this.runtime.fp()) {
      throw new MobileInputError('server_changed', 'Выбран другой домашний сервер.', 409);
    }

    if (input.mode === 'restore') {
      await this.mobile.relay(input.relayId!);
    }

    return this.store.mutate((records) => {
      const previous = records.find((record) => record.job.requestId === input.requestId);

      if (previous) {
        const receipt = previous.receipts.create;

        if (!receipt || receipt.input !== JSON.stringify(input)) {
          throw new MobileInputError('request_conflict', 'Параметры повторного запроса изменились.', 409);
        }

        return receipt.result;
      }

      this.assertAvailable(records, input);

      const job: DeploymentJob = {
        ...input,
        id: randomUUID(),
        revision: 1,
        state: 'draft',
        steps: [],
        service: { state: 'pending' },
      };

      records.push({ job, receipts: { create: {
        input: JSON.stringify(input),
        result: structuredClone(job),
        status: 201,
      } } });

      return job;
    });
  }

  /**
   * Probe не передаёт учётные данные; challenge связан со снимком конкретного задания.
   * Повторная проверка hostVerifier остаётся обязательной при реальном connect.
   */
  async probe(id: string, input: { revision: number }): Promise<DeploymentJob> {
    const job = await this.get(id);

    this.revision(job, input.revision);

    const allowed = ['draft', 'interrupted', 'failed', 'awaiting_host_key', 'awaiting_credentials'];

    if (!allowed.includes(job.state)) {
      throw new MobileInputError('deployment_state', 'Эта стадия уже завершена.', 409);
    }

    let key: Awaited<ReturnType<SshTransport['probe']>>;

    try {
      key = await this.options.transport.probe(job.ssh);
    } catch (cause) {
      await this.probeAbandoned(job.id, this.generation);

      throw cause instanceof MobileInputError ? cause
        : new MobileInputError('ssh_probe_failed', 'Не удалось получить отпечаток SSH.', 409);
    }

    if (!key) {
      await this.probeAbandoned(job.id, this.generation);

      throw new MobileInputError('ssh_probe_failed', 'Не удалось получить отпечаток SSH.', 409);
    }

    const checked = await this.options.hostKeys.check(key);

    return this.update(id, (current, records) => {
      this.revision(current, input.revision);
      this.assertAvailable(records, current, id);
      current.state = checked.status === 'trusted' ? 'awaiting_credentials' : 'awaiting_host_key';
      current.hostKey = {
        challengeId: checked.challengeId,
        decision: checked.decision,
        fingerprint: key.fingerprint,
        revision: current.revision + 1,
      };
      delete current.error;
    });
  }

  /**
   * Черновик без результата probe не держит busy вечно: переход идёт только из draft.
   * Поздний отказ параллельного probe не затирает успешный результат соседа.
   */
  private async probeAbandoned(id: string, generation: number): Promise<void> {
    if (generation !== this.generation || this.stopped) {
      return;
    }

    await this.update(id, (job) => {
      if (job.state === 'draft') {
        job.state = 'failed';
        job.error = { code: 'ssh_probe_failed' };
        job.channel ??= { state: 'unverified' };
      }
    }).catch(() => {});
  }

  /**
   * Доверие относится к одноразовому challenge именно этой revision.
   * Reject расходует решение, сохраняя запрет на ввод секрета.
   */
  async hostKey(id: string, input: {
    revision: number;
    challengeId: string;
    decision: string;
  }): Promise<DeploymentJob> {
    return this.update(id, async (job) => {
      this.revision(job, input.revision);

      if (job.state !== 'awaiting_host_key' || input.challengeId !== job.hostKey?.challengeId) {
        throw new MobileInputError('host_key_conflict', 'Сначала проверьте отпечаток SSH.', 409);
      }

      if (input.decision === 'reject') {
        job.state = 'failed';
        job.error = { code: 'host_key_rejected' };
      } else {
        try {
          await this.options.hostKeys.decide(input.challengeId, input.decision);
        } catch {
          throw new MobileInputError('host_key_conflict', 'Проверка отпечатка истекла.', 409);
        }

        job.state = 'awaiting_credentials';
      }

      delete job.hostKey!.challengeId;
    });
  }

  /**
   * Ввод секрета принимает только закрытая стадия после host key и до первого worker.
   * После connect секрет освобождается, TTL ограничивает ожидание подтверждения preview.
   */
  async credentials(id: string, value: unknown): Promise<DeploymentJob> {
    const input = value as Credentials & { revision: number; attemptId: string };

    if (!input || typeof input.attemptId !== 'string' || !/^[\w-]{1,128}$/.test(input.attemptId)
      || Object.keys(input).some((key) => !['password', 'privateKey', 'passphrase',
        'revision', 'attemptId'].includes(key))
      || (typeof input.password === 'string') === (typeof input.privateKey === 'string')
      // Пустая строка деградировала бы в пустой пароль вместо внятного отказа ввода.
      || input.password === '' || input.privateKey === ''
      || input.passphrase !== undefined && typeof input.passphrase !== 'string') {
      throw new MobileInputError('bad_credentials', 'Выберите пароль либо приватный ключ.');
    }

    let accepted = false;
    const job = await this.store.mutate((records) => {
      const record = this.record(records, id);
      const receipt = record.receipts[`credentials:${input.attemptId}`];

      if (receipt) {
        return receipt.result;
      }

      this.revision(record.job, input.revision);

      if (record.job.state !== 'awaiting_credentials') {
        throw new MobileInputError('deployment_state', 'Сначала проверьте отпечаток SSH.', 409);
      }

      record.job.state = 'preflight';
      record.job.revision += 1;
      record.receipts[`credentials:${input.attemptId}`] = {
        input: String(input.revision),
        result: structuredClone(record.job),
        status: 202,
      };
      accepted = true;

      return record.job;
    });

    if (accepted) {
      const secret: Credentials = input.privateKey
        ? { privateKey: input.privateKey, passphrase: input.passphrase } : { password: input.password };

      void this.prepare(job, secret);
    }

    return job;
  }

  /**
   * Preview закрепляет проверенный artifact и сохраняет только безопасный результат проверок.
   * Сырые ошибки ssh2, системных команд и выпуска никогда не становятся DTO или SSE.
   */
  private async prepare(job: DeploymentJob, secret: Credentials): Promise<void> {
    const generation = this.generation;
    let session: SshTransportSession | undefined;
    let authenticated = false;
    let disconnected = false;

    try {
      session = await this.options.transport.connect({
        ...job.ssh,
        ...secret,
        readyTimeout: 20_000,
        hostVerifier: (fp) => fp === job.hostKey?.fingerprint,
      });
      authenticated = true;
      this.sessions.add(session);

      const connection = session;

      connection.once('close', () => {
        disconnected = true;

        if (this.sessions.has(connection)) {
          void this.previewDisconnected(job.id, generation);
        }
      });
      await preflight(session, job);

      const artifact = await resolveRelayArtifact(this.directory, this.options);

      if (generation !== this.generation || this.stopped || disconnected) {
        session.close();
        this.sessions.delete(session);

        // Worker ещё не зарегистрирован: staging удаляется вручную, release его не знает.
        if (artifact.staging) {
          void fs.rm(artifact.staging, { recursive: true, force: true }).catch(() => {});
        }

        if (disconnected) {
          throw new Error('ssh_disconnected');
        }

        return;
      }

      const digest = createHash('sha256').update(JSON.stringify({
        ssh: job.ssh,
        public: job.public,
        artifact: artifact.digest,
      })).digest('hex');
      const timer = setTimeout(() => void this.expirePreview(job.id), 300_000);

      timer.unref();
      this.workers.set(job.id, {
        session,
        artifact,
        timer,
        expires: this.now() + 300_000,
      });
      await this.update(job.id, (current) => {
        if (disconnected) {
          throw new Error('ssh_disconnected');
        }

        current.state = 'awaiting_confirmation';
        current.preview = {
          digest,
          changes: ['install_relay_binary', 'create_service_user', 'write_private_config', 'enable_systemd'],
          artifact: { version: artifact.version, digest: artifact.digest },
        };
        current.steps = [{ name: 'preflight', state: 'completed' }];
      });
    } catch (cause) {
      this.release(job.id);
      session?.close();

      if (session) {
        this.sessions.delete(session);
      }

      const safeCode = cause instanceof Error
        && ['unsupported_platform', 'relay_port_busy'].includes(cause.message)
        ? cause.message : authenticated ? 'preflight_failed' : 'ssh_auth_failed';

      await this.fail(job.id, safeCode, generation);
    } finally {
      delete secret.password;
      delete secret.privateKey;
      delete secret.passphrase;
    }
  }

  /**
   * Закрытый SSH делает ожидающий preview непригодным: start не должен использовать мёртвую сессию.
   * Во время preflight/install отказ фиксирует сам worker; штатный release уже удалил соединение.
   */
  private async previewDisconnected(id: string, generation: number): Promise<void> {
    if (generation !== this.generation || this.stopped) {
      return;
    }

    await this.update(id, (job) => {
      if (job.state === 'awaiting_confirmation') {
        job.state = 'interrupted';
        job.error = { code: 'credentials_required' };
        delete job.preview;
        this.release(id);
      }
    }).catch(() => {});
  }

  /**
   * Durable receipt предшествует запуску worker, поэтому lost ACK не повторяет установку.
   * Истёкший preview требует нового секрета и повторных предпроверок.
   */
  async start(id: string, input: {
    requestId: string;
    revision: number;
    previewDigest: string;
  }): Promise<DeploymentJob> {
    let accepted = false;
    let expired = false;
    const job = await this.receipted(id, 'start', input, (record) => {
      const worker = this.workers.get(id);

      this.revision(record.job, input.revision);

      if (record.job.state !== 'awaiting_confirmation') {
        // Идущая установка не имеет подтверждённого preview: сессия не закрывается.
        throw new MobileInputError('deployment_state', 'Задание уже выполняется.', 409);
      }

      if (!worker || worker.expires <= this.now()
        || input.previewDigest !== record.job.preview?.digest) {
        // Дurable возврат к вводу секрета сохраняет trust и снимает заклинившее состояние.
        expired = true;
        this.release(id);
        record.job.state = 'awaiting_credentials';
        delete record.job.preview;

        return;
      }

      clearTimeout(worker.timer);
      record.job.state = 'installing';
      record.job.steps.push({ name: 'install', state: 'running' });
      accepted = true;
    });

    if (expired) {
      throw new MobileInputError('preview_expired', 'Повторите проверку и ввод SSH-доступа.', 409);
    }

    if (accepted) {
      void this.install(job);
    }

    return job;
  }

  /**
   * Истечение preview возвращает задание к вводу секрета без потери trust host key.
   * Без этого перехода TTL оставлял задание в недостижимом awaiting_confirmation.
   */
  private async expirePreview(id: string): Promise<void> {
    this.release(id);

    await this.update(id, (job) => {
      if (job.state === 'awaiting_confirmation') {
        job.state = 'awaiting_credentials';
        delete job.preview;
      }
    }).catch(() => {});
  }

  /**
   * Резервирует identity до удалённого эффекта; восстановление использует прежние секреты.
   * Promotion выполняется только после сетевого доказательства и durable intent.
   */
  private async install(job: DeploymentJob): Promise<void> {
    const generation = this.generation;
    const worker = this.workers.get(job.id);
    let installation: RelayInstallation | undefined;
    let preserveBackup = false;

    if (!worker) {
      // Shutdown между start и install не оставляет осиротевшей записи relay.
      await this.fail(job.id, 'installation_failed', generation);

      return;
    }

    try {
      if (!job.relayId) {
        job = await this.update(job.id, (current) => {
          current.relayId = `r${randomBytes(8).toString('hex')}`;
        });
      }

      const relay = job.mode === 'setup' ? await this.mobile.relays.add({
        name: job.name!,
        host: job.public.host,
        port: job.public.port,
      }, { id: job.relayId!, enabled: false }) : await this.mobile.relay(job.relayId!);

      await this.store.mutate((records) => {
        this.record(records, job.id).before = {
          id: relay.id,
          host: relay.host,
          port: relay.port,
          enabled: relay.enabled,
        };
      });
      installation = await installRelay(
        worker.session, job, worker.artifact, await this.mobile.relayEnv(relay.id),
      );

      if (generation !== this.generation) {
        return;
      }

      await this.update(job.id, (current) => {
        current.state = 'verifying';
        current.service = { state: 'running' };
        current.steps.find((step) => step.name === 'install')!.state = 'completed';
        current.steps.push({ name: 'channel', state: 'running' });
      });

      const promoted = await this.promote(job, relay, generation);

      if (installation.replaced && !promoted) {
        preserveBackup = !await this.rollbackInstallation(job.id, installation, generation);
      }
    } catch (error) {
      if (installation?.replaced) {
        preserveBackup = !await this.rollbackInstallation(job.id, installation, generation);

        return;
      }

      if (error instanceof Error && error.message === 'waiting_vpn') {
        await this.fail(job.id, 'waiting_vpn', generation, 'waiting_vpn');

        return;
      }

      const conflict = error instanceof MobileInputError && error.code === 'route_conflict';
      const rollbackFailed = error instanceof Error && error.message === 'remote_rollback_failed';

      await this.fail(job.id, rollbackFailed ? 'remote_rollback_failed'
        : conflict ? 'route_conflict' : 'installation_failed', generation,
      conflict || rollbackFailed ? 'recovery_required' : 'failed');
    } finally {
      if (!preserveBackup) {
        await installation?.dispose();
      }

      this.release(job.id);
    }
  }

  /**
   * Сетевой отказ не оставляет прежний домашний маршрут указывать на уже заменённую службу.
   * Потерянный SSH отделён от подтверждённого отката: автоматическое продолжение не обещается.
   */
  private async rollbackInstallation(
    id: string,
    installation: RelayInstallation,
    generation: number,
  ): Promise<boolean> {
    if (generation !== this.generation || this.stopped) {
      return false;
    }

    try {
      await this.update(id, (job) => {
        job.steps.push({ name: 'rollback', state: 'running' });
      });
      await installation.rollback();
      await this.update(id, (job) => {
        job.service = { state: installation.wasRunning ? 'running' : 'unknown' };
        job.channel = { state: 'unverified' };
        job.steps.find((step) => step.name === 'rollback')!.state = 'completed';
      });
      await this.fail(id, 'previous_installation_restored', generation, 'recovery_required');

      return true;
    } catch {
      await this.update(id, (job) => {
        job.service = { state: 'unknown' };
        job.channel = { state: 'unverified' };
      }).catch(() => {});
      await this.fail(id, 'remote_rollback_failed', generation, 'recovery_required');

      return false;
    }
  }

  /**
   * Адрес кандидата и публичный DNS проверяются раздельно, старый VPS с тем же pin не подходит.
   * CAS не перезаписывает более свежий маршрут другого владельца.
   */
  private async promote(job: DeploymentJob, relay: Awaited<ReturnType<MobileService['relay']>>,
    generation: number): Promise<boolean> {
    const address = await candidateAddress(job.candidateHost, this.runtime.vpnGate);
    const status = await this.mobile.status();
    const existing = relay.enabled && relay.host === job.candidateHost && relay.port === job.public.port
      && status.relays.find((item) => item.id === relay.id)?.link.state === 'online';

    await (this.options.verifyCandidate ?? verifyCandidate)({
      relay: {
        ...relay,
        host: address,
        port: job.public.port,
      },
      serverFp: this.runtime.fp(),
      vpnGate: this.runtime.vpnGate,
      clientTarget: this.runtime.clientTarget,
      existing,
    });

    let publicAddress: string | undefined;

    try {
      publicAddress = await candidateAddress(job.public.host, this.runtime.vpnGate);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;

      if (!['ENOTFOUND', 'ENODATA', 'EAI_AGAIN'].includes(code ?? '')) {
        throw error;
      }
    }

    if (generation !== this.generation) {
      return false;
    }

    if (address !== publicAddress) {
      await this.update(job.id, (current) => {
        current.state = 'awaiting_dns';
        current.error = { code: 'update_dns' };
      });

      return false;
    }

    await this.update(job.id, (current) => {
      current.channel = { state: 'verified', address };
      current.routeUpdateRequired = job.mode === 'restore'
        && (relay.host !== job.public.host || relay.port !== job.public.port);
    });

    const after = await this.mobile.relays.compareRoute(relay, { ...job.public, enabled: true });

    try {
      await this.runtime.sync();

      if (!this.options.verifyCandidate) {
        const deadline = Date.now() + 6000;

        while (true) {
          const current = (await this.mobile.status()).relays.find((item) => item.id === relay.id);

          if (current?.link.state === 'online') {
            break;
          }

          if (Date.now() > deadline) {
            throw new Error('relay_channel_unavailable');
          }

          await new Promise((resolve) => setTimeout(resolve, 30));
        }
      }

      await this.update(job.id, (current) => {
        current.state = 'ready';
        current.steps.find((step) => step.name === 'channel')!.state = 'completed';
        delete current.error;
      });

      return true;
    } catch {
      await this.mobile.relays.compareRoute(after, relay);
      await this.runtime.sync();

      throw new Error('relay_channel_unavailable');
    }
  }

  /**
   * Повтор после прерывания снова требует probe и секрет, без автоматического SSH.
   * Квитанция сохраняет ответ retry независимо от последующих стадий.
   */
  async retry(id: string, input: { requestId: string; revision: number }): Promise<DeploymentJob> {
    return this.receipted(id, 'retry', input, (record, records) => {
      this.revision(record.job, input.revision);

      const waiting = ['waiting_vpn', 'awaiting_dns'].includes(record.job.state);

      if (!terminal.includes(record.job.state) && !waiting) {
        throw new MobileInputError('deployment_state', 'Задание уже выполняется.', 409);
      }

      this.assertAvailable(records, record.job, id);
      record.job.state = 'draft';
      delete record.job.error;
      delete record.job.hostKey;
      this.release(id);
    });
  }

  /**
   * Отмена завершает только ожидание ввода или подтверждения до удалённых изменений.
   * Принятый worker не прерывается этим действием; потерянный ответ воспроизводится из квитанции.
   */
  async cancel(id: string, input: { requestId: string; revision: number }): Promise<DeploymentJob> {
    const job = await this.receipted(id, 'cancel', input, (record) => {
      this.revision(record.job, input.revision);

      if (!['draft', 'awaiting_host_key', 'awaiting_credentials', 'awaiting_confirmation']
        .includes(record.job.state)) {
        throw new MobileInputError('deployment_state', 'Выполняющееся задание нельзя отменить.', 409);
      }

      record.job.state = 'interrupted';
      record.job.error = { code: 'deployment_cancelled' };
      delete record.job.preview;
      this.release(id);
    });

    this.runtime.changed();

    return job;
  }

  /**
   * Проверка DNS/VPN повторяет только сетевое доказательство, не установку и не ввод секрета.
   * Сохранённая identity позволяет безопасно повторить promotion после ожидания владельца.
   */
  async check(id: string, input: { requestId: string; revision: number }): Promise<DeploymentJob> {
    let accepted = false;
    const job = await this.receipted(id, 'check', input, (record) => {
      this.revision(record.job, input.revision);

      if (!['awaiting_dns', 'waiting_vpn'].includes(record.job.state)) {
        throw new MobileInputError('deployment_state', 'Задание не ожидает проверки сети.', 409);
      }

      record.job.state = 'verifying';
      accepted = true;
    });

    if (accepted) {
      const generation = this.generation;

      // waiting_vpn остаётся возобновляемым: check существует именно для ожидания сети.
      void this.mobile.relay(job.relayId!).then((relay) => this.promote(job, relay, generation))
        .catch((cause) => this.fail(id, cause instanceof Error && cause.message === 'waiting_vpn'
          ? 'waiting_vpn' : 'relay_channel_unavailable', generation,
        cause instanceof Error && cause.message === 'waiting_vpn' ? 'waiting_vpn' : 'failed'));
    }

    return job;
  }

  async busy(relayId: string): Promise<boolean> {
    return (await this.list()).some((job) => job.relayId === relayId && !terminal.includes(job.state));
  }

  /**
   * Общий журнал мутаций хранит запрос без SSH-секрета и ответ до HTTP ACK.
   * Несовпавшие параметры того же requestId отклоняются до любого эффекта.
   */
  private receipted(id: string, action: string, input: { requestId: string },
    mutate: (record: DeploymentRecord, records: DeploymentRecord[]) => void): Promise<DeploymentJob> {
    if (typeof input.requestId !== 'string' || !/^[\w-]{1,128}$/.test(input.requestId)) {
      throw new MobileInputError('bad_request_id', 'Нужен идентификатор запроса.');
    }

    return this.store.mutate((records) => {
      const record = this.record(records, id);
      const key = `${action}:${input.requestId}`;
      const receipt = record.receipts[key];
      const fingerprint = JSON.stringify(input);

      if (receipt) {
        if (receipt.input !== fingerprint) {
          throw new MobileInputError('request_conflict', 'Параметры повторного запроса изменились.', 409);
        }

        return receipt.result;
      }

      mutate(record, records);
      record.job.revision += 1;
      record.receipts[key] = {
        input: fingerprint,
        result: structuredClone(record.job),
        status: 202,
      };

      return record.job;
    });
  }

  /**
   * Проверяет единственного владельца relay и endpoint внутри транзакции журнала.
   * Повтор старого задания проходит тот же admission, что создание нового, исключая только себя.
   */
  private assertAvailable(records: DeploymentRecord[], target: Pick<DeploymentJob, 'relayId' | 'public'>,
    excludingId?: string): void {
    const busy = records.find(({ job }) => job.id !== excludingId && !terminal.includes(job.state)
      && (job.relayId && job.relayId === target.relayId
        || job.public.host === target.public.host && job.public.port === target.public.port));

    if (busy) {
      throw new MobileInputError('deployment_busy', `Продолжите задание ${busy.job.id}.`, 409);
    }
  }

  private record(records: DeploymentRecord[], id: string): DeploymentRecord {
    const record = records.find((item) => item.job.id === id);

    if (!record) {
      throw new MobileInputError('deployment_not_found', 'Задание не найдено.', 404);
    }

    return record;
  }

  private revision(job: DeploymentJob, revision: number): void {
    if (job.revision !== revision || job.expectedServerFp !== this.runtime.fp()) {
      throw new MobileInputError('revision_conflict', 'Состояние изменилось. Обновите задание.', 409);
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /**
   * Изменение состояния сначала фиксируется durable, затем инвалидирует общую SSE-шину.
   * Payload уведомления не содержит credentials, QR или содержимое удалённых файлов.
   */
  private async update(
    id: string,
    action: (job: DeploymentJob, records: DeploymentRecord[]) => void | Promise<void>,
  ): Promise<DeploymentJob> {
    const job = await this.store.mutate(async (records) => {
      const record = this.record(records, id);

      await action(record.job, records);
      record.job.revision += 1;

      return record.job;
    });

    this.runtime.changed();

    return job;
  }

  /**
   * Фиксированные ошибки отделяют отказ сети от успеха установки и защищают журнал от stderr.
   * Поздний worker предыдущего поколения не публикует результат после shutdown.
   */
  private async fail(id: string, code: string, generation: number,
    state: DeploymentState = 'failed'): Promise<void> {
    if (generation !== this.generation || this.stopped) {
      return;
    }

    await this.update(id, (job) => {
      if (job.state === 'installing') {
        job.service = { state: 'unknown' };
      }

      job.state = state;
      job.error = { code };
      job.channel ??= { state: 'unverified' };

      for (const step of job.steps.filter((item) => item.state === 'running')) {
        step.state = 'failed';
      }
    }).catch(() => {});
  }

  /**
   * Освобождает только ресурсы текущего worker, отмечая штатное закрытие до события close.
   * Проверенный архив удаляется вместе с попыткой и не переживает закрытую SSH-сессию.
   */
  private release(id: string): void {
    const worker = this.workers.get(id);

    if (worker) {
      clearTimeout(worker.timer);
      this.sessions.delete(worker.session);
      this.workers.delete(id);
      worker.session.close();

      // Проверенный архив больше не нужен: staging не должен переживать попытку установки.
      if (worker.artifact.staging) {
        void fs.rm(worker.artifact.staging, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  /**
   * Shutdown отзывает поколение и закрывает только собственные SSH-соединения.
   * Durable interrupted оставляет точные выполненные шаги для следующего входа.
   */
  async close(): Promise<void> {
    this.stopped = true;
    this.generation += 1;

    for (const id of this.workers.keys()) {
      this.release(id);
    }

    for (const session of this.sessions) {
      session.close();
    }

    this.sessions.clear();
    await this.recover().catch(() => {});
  }
}
