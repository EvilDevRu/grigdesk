// Тонкий установщик голосов раздела: запускает установщик пакета voice и наблюдает
// за ним. Собственной качки, venv и приёмки у раздела больше нет — пакет voice
// делает это сам и публикует результат только после контрольной фразы.
//
// Каталог пакетов — копия значений utilities/voice/internal/local/packages.json: размер и лицензию
// человек видит ДО нажатия. При обновлении пакета сверяй обе копии.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { ShowcaseError } from '../errors.ts';
import type { ProcessIdentity } from '../processIdentity.ts';
import { readProcessIdentity } from '../../speech/modelJobsProcess.ts';
import { stopWorker } from '../render/runner.ts';

export type VoiceInstallState = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';

export interface PackageInstallRecord {
  schemaVersion: number;
  id: string;
  engineId: string;
  voiceId: string;
  state: VoiceInstallState;
  step: string;
  label: string;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  deadlineAt: string;
  identity: ProcessIdentity;
  workDir: string;
  sequence: number;
}

export interface PublicPackageInstall {
  id: string;
  engineId: string;
  voiceId: string;
  state: VoiceInstallState;
  step: string;
  label: string;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  pid: number | null;
}

export interface PackageInstallStatus {
  available: {
    id: string;
    engineId: string;
    name: string;
    language: string;
    timbre: string;
    byteSize: number;
    license: string;
    voices: string[];
    installed: boolean;
  }[];
  job: PublicPackageInstall | null;
}

export interface PackageInstallerOptions {
  voiceBin: string;
  // Каталог данных пакета voice: установщик и синтез обязаны читать один каталог
  // (находка F15), поэтому он передаётся в env дочернего процесса.
  voiceDir: string;
  installFile: string;
  workRoot: string;
  broadcast: (event: string, data: unknown) => void;
  onInstalled: (voiceId: string) => void;
  readyProbe: (engineId: string) => Promise<boolean>;
  env?: NodeJS.ProcessEnv;
}

// Собственные имена пакетов раздела (проводной id); значения размера/лицензии/
// голосов скопированы из utilities/voice/internal/local/packages.json.
// byteSize — модель + движок (fileBytes + engineBytes): человек видит полный объём
// ДО нажатия; wheels Python ставятся сверх и зависят от платформы (находка F26).
// При обновлении пакета сверяй обе копии.
const PACKAGES = [
  {
    id: 'piper-irina',
    engineId: 'piper',
    name: 'Ирина',
    language: 'ru',
    timbre: 'женский',
    byteSize: 58_340_190,
    license: 'GPLv2 (обучен на корпусе RHVoice)',
    voices: ['irina'],
  },
  {
    id: 'silero-v5_5_ru',
    engineId: 'silero',
    name: 'Silero v5.5',
    language: 'ru',
    timbre: 'три женских и два мужских',
    byteSize: 345_420_684,
    license: 'CC BY-NC-SA 4.0 (некоммерческое использование)',
    voices: ['xenia', 'baya', 'kseniya', 'aidar', 'eugene'],
  },
];

const INSTALL_DEADLINE_MS = 35 * 60_000;

/**
 * Одна очередь владеет допуском, журналом и завершением установки. События child
 * пишут только в свою попытку: поздний close не может завершить следующий запуск.
 */
export function createPackageInstaller(options: PackageInstallerOptions) {
  interface Attempt {
    child: ReturnType<typeof spawn>;
    exited: boolean;
    exitCode: number;
    spawnError: string | null;
    stderrTail: string;
    stderrSeen: string;
    started: Promise<void>;
    closed: Promise<void>;
  }

  let record: PackageInstallRecord | null = null;
  let attempt: Attempt | null = null;
  let mutations: Promise<void> = Promise.resolve();

  /**
   * Допуск резервируется до первого await. После отказа очередь остаётся живой,
   * поэтому повтор и отмена не наследуют отклонённый Promise прошлой операции.
   */
  function exclusive<Value>(operation: () => Promise<Value>): Promise<Value> {
    const result = mutations.then(operation);

    mutations = result.then(() => undefined, () => undefined);

    return result;
  }

  /**
   * Снимок сохраняется атомарно внутри очереди мутаций. Уникальный временный файл
   * не пересекается с прошлой попыткой и удаляется также при отказе rename.
   */
  async function save(): Promise<void> {
    if (!record) {
      return;
    }

    const contents = JSON.stringify(record, null, 2);
    const temporary = `${options.installFile}.tmp-${randomUUID()}`;

    await fs.mkdir(path.dirname(options.installFile), { recursive: true });

    try {
      await fs.writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temporary, options.installFile);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  /**
   * Интерфейс получает только состояние попытки и PID для наблюдения. Внутренние
   * пути, командная строка и окружение процесса в публичную запись не входят.
   */
  function publicJob(): PublicPackageInstall | null {
    if (!record) {
      return null;
    }

    return {
      id: record.id,
      engineId: record.engineId,
      voiceId: record.voiceId,
      state: record.state,
      step: record.step,
      label: record.label,
      error: record.error,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      pid: record.identity.pid,
    };
  }

  /**
   * Событие публикуется после durable-записи. Получатели используют общий SSE,
   * а состояние дочернего процесса остаётся внутри установщика.
   */
  function emit(): void {
    if (!record) {
      return;
    }

    options.broadcast('showcase-voice', {
      installId: record.id,
      voiceId: record.voiceId,
      state: record.state,
      step: record.step,
      label: record.label,
      error: record.error,
    });
  }

  /**
   * Завершение вызывается только из очереди. Успех сбрасывает кэш каталога после
   * сохранения итога, поэтому UI больше не видит прежнее «не установлен».
   */
  async function finish(state: VoiceInstallState, error: string | null): Promise<void> {
    if (!record || record.state !== 'running') {
      return;
    }

    record = {
      ...record,
      state,
      error,
      finishedAt: new Date().toISOString(),
    };

    await save();
    emit();

    if (state === 'succeeded') {
      options.onInstalled(record.voiceId);
    }
  }

  /**
   * Каталог проверяется вне очереди мутаций: длительная проба движка не должна
   * удерживать допуск отмены. Публичное задание читается после получения каталога.
   */
  async function status(): Promise<PackageInstallStatus> {
    const available = [];

    for (const pack of PACKAGES) {
      const installed = await options.readyProbe(pack.engineId).catch(() => false);

      available.push({ ...pack, installed });
    }

    return { available, job: publicJob() };
  }

  /**
   * Отмена ждёт закрытия собственного child перед освобождением допуска. Если
   * процесс не завершился, новый запуск не разрешается и запись остаётся running.
   */
  async function stopAttempt(own: Attempt): Promise<void> {
    if (own.exited) {
      return;
    }

    const pid = own.child.pid;

    if (pid) {
      stopWorker({
        pid,
        starttime: null,
        cmdline: null,
      });
    }

    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      await Promise.race([
        own.closed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new ShowcaseError(
              'voice_install_busy',
              'Процесс установки ещё завершается. Повторите отмену после завершения.',
              409,
            ));
          }, 5000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Child и его callbacks принадлежат одной попытке. Ошибка spawn становится
   * наблюдаемым failed, а не необработанным событием EventEmitter сервера.
   */
  function launch(engineId: string): Attempt {
    const child = spawn(options.voiceBin, ['install', engineId, '--json'], {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        GRIGDESK_VOICE_DIR: options.voiceDir,
        HTTPS_PROXY: process.env.HTTPS_PROXY,
        HTTP_PROXY: process.env.HTTP_PROXY,
        NO_PROXY: process.env.NO_PROXY,
        ...(options.env ?? {}),
      },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let resolveClosed: () => void = () => undefined;
    let resolveStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const own: Attempt = {
      child,
      exited: false,
      exitCode: 1,
      spawnError: null,
      stderrTail: '',
      stderrSeen: '',
      started,
      closed,
    };

    child.stderr!.on('data', (chunk: Buffer) => {
      own.stderrTail = (own.stderrTail + chunk.toString('utf8')).slice(-65_536);
    });
    // stdout дренируется, но успех определяет код выхода CLI; JSON не нужен UI.
    child.stdout!.resume();
    child.on('spawn', resolveStarted);
    child.on('error', (error) => {
      own.spawnError = `Пакет voice не запускается: ${error.message}. Проверьте путь и права файла.`;
      resolveStarted();
    });
    child.on('close', (code) => {
      own.exited = true;
      own.exitCode = code ?? 1;
      resolveClosed();
    });
    child.unref();

    return own;
  }

  /**
   * Запуск и повтор сериализованы вместе с mkdir и записью журнала. Намерение
   * сохраняется до spawn; если последующая запись откажет, child завершается.
   */
  async function start(packageId: string): Promise<PackageInstallStatus> {
    await exclusive(async () => {
      const pack = PACKAGES.find((item) => item.id === packageId);

      if (!pack) {
        throw new ShowcaseError('unknown_voice', `Пакет голоса «${packageId}» не объявлен.`, 400);
      }

      if (record?.state === 'running') {
        if (record.voiceId === packageId) {
          return;
        }

        throw new ShowcaseError(
          'voice_install_busy',
          'Сейчас ставится другой голос. Дождитесь завершения или отмените установку.',
          409,
        );
      }

      const id = `install-${randomUUID()}`;
      const workDir = path.join(options.workRoot, id);

      await fs.mkdir(workDir, { recursive: true, mode: 0o700 });

      record = {
        schemaVersion: 1,
        id,
        engineId: pack.engineId,
        voiceId: packageId,
        state: 'running',
        step: 'install',
        label: `Ставлю ${pack.name}.`,
        error: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        deadlineAt: new Date(Date.now() + INSTALL_DEADLINE_MS).toISOString(),
        identity: {
          pid: null,
          starttime: null,
          cmdline: null,
        },
        workDir,
        sequence: 0,
      };
      attempt = null;

      try {
        await save();
        attempt = launch(pack.engineId);
        await attempt.started;

        if (attempt.spawnError) {
          await attempt.closed;
          await finish('failed', attempt.spawnError);

          return;
        }

        const pid = attempt.child.pid ?? null;

        record.identity = pid ? readProcessIdentity(pid) ?? {
          pid,
          starttime: null,
          cmdline: null,
        } : {
          pid: null,
          starttime: null,
          cmdline: null,
        };

        await save();
        emit();
      } catch (error) {
        if (attempt) {
          await stopAttempt(attempt);
        }

        await finish('failed', error instanceof Error ? error.message : String(error));

        throw error;
      }
    });

    return status();
  }

  /**
   * Отмена удерживает очередь до close собственного процесса. Поздние события
   * этого процесса не имеют доступа к следующей попытке и её журналу.
   */
  async function cancel(): Promise<PackageInstallStatus> {
    await exclusive(async () => {
      if (record?.state !== 'running') {
        return;
      }

      if (attempt) {
        await stopAttempt(attempt);
      }

      await finish('cancelled', null);
    });

    return status();
  }

  /**
   * При перезапуске наблюдение за child утрачено. Запись помечается interrupted;
   * произвольный PID с диска не используется для сигналов постороннему процессу.
   */
  async function recover(): Promise<void> {
    await exclusive(async () => {
      try {
        const raw = JSON.parse(await fs.readFile(options.installFile, 'utf8')) as PackageInstallRecord;

        record = raw?.state === 'running' && raw.identity ? raw : null;
      } catch {
        record = null;
      }

      attempt = null;

      if (record) {
        await finish('interrupted', 'Установка прервана перезапуском сервера. Повторите установку.');
      }
    });
  }

  /**
   * Опрос переносит события текущей попытки в durable-журнал. Живой child отдаёт
   * close/error, поэтому переход shebang → node не проверяется по прежнему cmdline.
   */
  async function poll(): Promise<void> {
    await exclusive(async () => {
      if (!record || record.state !== 'running') {
        return;
      }

      const own = attempt;

      if (!own) {
        await finish('interrupted', 'Наблюдение за установкой потеряно. Повторите установку.');

        return;
      }

      const label = own.stderrTail.trim().split('\n').at(-1) ?? '';

      if (label && label !== own.stderrSeen) {
        own.stderrSeen = label;
        record = {
          ...record,
          label,
          sequence: record.sequence + 1,
        };

        await save();
        emit();
      }

      if (own.exited) {
        const error = own.spawnError || label || 'Установка не удалась.';

        await finish(own.exitCode === 0 && !own.spawnError ? 'succeeded' : 'failed',
          own.exitCode === 0 && !own.spawnError ? null : error);

        return;
      }

      if (Date.now() > Date.parse(record.deadlineAt)) {
        await stopAttempt(own);
        await finish('failed', 'Истёк срок установки голоса.');
      }
    });
  }

  return {
    start,
    cancel,
    recover,
    poll,
    status,
  };
}

export type PackageInstaller = ReturnType<typeof createPackageInstaller>;
