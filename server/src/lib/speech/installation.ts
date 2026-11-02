import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  decodeSpeechInstallation,
  type SpeechInstallation,
  type SpeechInstallJob,
  type SpeechInstallOperation,
} from '../../../../shared/media/speechInstallation.ts';
import { acquireDirectoryLock } from '../../../../shared/node/directoryLock.ts';
import { writeDurableFile } from '../durableFile.ts';
import { runCommand, type PluginCommandRunner, type CommandWorker } from '../packageInstall/runCommand.ts';
import { liveGroupMembers } from '../packageInstall/workerIdentity.ts';
import { speechModel, type SpeechModel } from './catalog.ts';
import { pythonEnv } from './transport.ts';
import { CUDA_PROBE_PY, MODEL_CACHE_PROBE_PY } from './capabilities.ts';

export class SpeechInstallError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 409) {
    super(message);
    this.statusCode = statusCode;
  }
}

interface InstallationOptions {
  dataHome: string;
  rootDir: string;
  pythonPath: string;
  mediaHfDir?: string;
  env?: NodeJS.ProcessEnv;
  runner?: PluginCommandRunner;
  prepareMaintenance: () => Promise<() => void>;
  refresh: () => unknown;
}

/**
 * Канонизирует существующих родителей, сохраняя хвост ещё не созданного venv.
 * Сам python не раскрывается: штатный venv обычно ссылается на системный бинарник.
 */
async function canonicalDirectory(directory: string): Promise<string> {
  try {
    return await fs.realpath(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }

    return path.join(await canonicalDirectory(path.dirname(directory)), path.basename(directory));
  }
}

/**
 * Установщик обслуживает только штатный venv GrigDesk и сохраняет кэш моделей.
 * Supervisor, дисковый исход и замок не зависят от открытой страницы настроек.
 */
export class SpeechInstallationService {
  private readonly options: InstallationOptions;
  private readonly directory: string;
  private readonly stateFile: string;
  private readonly venv: string;
  private readonly python: string;
  private job: SpeechInstallJob | null = null;
  private worker: CommandWorker | null = null;
  private loaded = false;
  private tail: Promise<unknown> = Promise.resolve();
  private task: Promise<void> | null = null;
  private readonly abort = new AbortController();

  constructor(options: InstallationOptions) {
    this.options = options;
    this.directory = path.join(options.dataHome, 'state', 'speech-install');
    this.stateFile = path.join(this.directory, 'current.json');
    this.venv = path.join(options.dataHome, 'state', 'media-venv');
    this.python = path.join(this.venv, 'bin', 'python');
  }

  private serialized<Value>(action: () => Promise<Value>): Promise<Value> {
    const next = this.tail.then(action, action);

    this.tail = next.catch(() => {});

    return next;
  }

  /**
   * Прежний running после рестарта не повторяет команду и не убивает чужой PID.
   * Пока прежняя группа жива, новый старт остаётся заблокированным.
   */
  private async load(): Promise<void> {
    if (this.loaded) {
      return;
    }

    try {
      const raw = JSON.parse(await fs.readFile(this.stateFile, 'utf8'));

      this.job = decodeSpeechInstallation(raw).job;
      this.worker = raw.worker ?? null;

      if (this.worker && (!Number.isSafeInteger(this.worker.pgid) || this.worker.pgid <= 0)) {
        throw new Error('Повреждено владение установкой речи');
      }

      if (this.job?.status === 'running') {
        this.job.status = 'interrupted';
        this.job.error = 'Установка прервана перезапуском сервера. Повторите операцию.';
        await this.persist();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }

    this.loaded = true;
  }

  private async persist(): Promise<void> {
    await writeDurableFile(this.stateFile, JSON.stringify({
      managed: true,
      installed: false,
      job: this.job,
      worker: this.worker,
    }));
  }

  /**
   * Настроенный сторонний Python и ссылка вместо штатного venv не обслуживаются.
   * Наличие файлов проверяется заново перед каждой операцией, включая удаление.
   */
  private async inspect(): Promise<Omit<SpeechInstallation, 'job'>> {
    const stat = await fs.lstat(this.venv).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        return null;
      }

      throw error;
    });
    const managed = /^python(?:3(?:\.\d+)?)?$/.test(path.basename(this.options.pythonPath))
      && await canonicalDirectory(path.dirname(this.options.pythonPath))
        === await canonicalDirectory(path.join(this.venv, 'bin'))
      && (!stat || stat.isDirectory() && !stat.isSymbolicLink());

    return {
      managed,
      installed: Boolean(stat),
    };
  }

  async current(): Promise<SpeechInstallation> {
    return this.serialized(async () => {
      await this.load();

      if (this.task && this.job?.status !== 'running') {
        await this.task;
      }

      return { ...await this.inspect(), job: this.job ? { ...this.job } : null };
    });
  }

  /**
   * Running фиксируется до ответа HTTP; второй клик или другая вкладка не дублирует старт.
   * Допуск runtime закрывает новые распознавания до освобождения файлового замка.
   */
  async start(operation: SpeechInstallOperation, cuda?: boolean, modelId = 'medium')
    : Promise<SpeechInstallation> {
    return this.serialized(async () => {
      await this.load();

      const model = speechModel(modelId);

      if (!model) {
        throw new SpeechInstallError('Неизвестная модель речи.', 400);
      }

      if (this.task && this.job?.status !== 'running') {
        await this.task;
      }

      if (this.abort.signal.aborted || this.task || this.job?.status === 'running') {
        throw new SpeechInstallError('Уже выполняется операция с окружением речи.');
      }

      if (this.worker && (await liveGroupMembers(this.worker.pgid)).length > 0) {
        throw new SpeechInstallError('Предыдущая установка ещё завершается. Повторите позже.');
      }

      const state = await this.inspect();

      if (!state.managed) {
        throw new SpeechInstallError('Внешнее окружение речи обслуживается его владельцем.');
      }
      if (operation === 'install' && state.installed || operation !== 'install' && !state.installed) {
        throw new SpeechInstallError('Состояние окружения изменилось. Обновите страницу настроек.');
      }

      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });

      const lock = await acquireDirectoryLock(path.join(this.directory, 'lock'), { waitMs: 0 })
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'directory_lock_busy') {
            throw new SpeechInstallError('Окружение речи обслуживается другим процессом. Повторите позже.');
          }

          throw error;
        });
      let release: (() => void) | null = null;

      try {
        release = await this.options.prepareMaintenance();
        this.worker = null;
        this.job = {
          id: randomUUID(),
          operation,
          status: 'running',
          stage: operation === 'uninstall' ? 'removal' : 'environment',
          output: '',
          error: '',
        };
        await this.persist();
      } catch (error) {
        release?.();
        await lock.release();

        throw error;
      }

      const releaseMaintenance = release;

      this.task = this.perform(operation, cuda, model).finally(async () => {
        releaseMaintenance();

        try {
          await lock.release();
        } finally {
          this.task = null;
        }
      });
      void this.task.catch(() => {});

      return { ...state, job: { ...this.job! } };
    });
  }

  /**
   * Команда получает только серверные argv, закреплённые requirements и свой supervisor.
   * Хвост вывода ограничен; ошибка команды не становится успешной установкой.
   */
  private async command(file: string, args: string[]): Promise<string> {
    const append = (chunk: string) => {
      this.job!.output = (this.job!.output + chunk).slice(-32_768);
    };
    const result = await (this.options.runner ?? runCommand)(file, args, {
      env: {
        ...pythonEnv({
          mediaHfDir: this.options.mediaHfDir ?? path.join(this.options.dataHome, 'state', 'hf'),
          pythonPath: this.python,
          baseEnv: this.options.env ?? process.env,
        }),
        PYTHONNOUSERSITE: '1',
        PIP_NO_INPUT: '1',
        PIP_DISABLE_PIP_VERSION_CHECK: '1',
      },
      timeoutMs: 30 * 60_000,
      signal: this.abort.signal,
      onStdout: append,
      onStderr: append,
      ownership: {
        started: async (worker) => {
          this.worker = worker;
          await this.persist();
        },
        finished: async () => {
          this.worker = null;
          await this.persist();
        },
      },
    });

    if (result.code !== 0 || result.signal || result.aborted || result.timedOut) {
      append(result.stderr || '');

      const missingVenv = this.job!.stage === 'environment'
        && /ensurepip is not\s+available|No module named ['"]?(?:ensurepip|venv)\b/
          .test(`${result.stdout}\n${result.stderr}`);

      this.job!.dependency = missingVenv ? 'python_venv'
        : file === 'ffmpeg' || file === 'ffprobe' ? 'ffmpeg' : undefined;

      const reason = missingVenv
        ? 'На сервере отсутствует компонент Python для создания окружения.'
          + ' Установите системный пакет python3-venv (Debian/Ubuntu) и повторите операцию.'
        : file === 'ffmpeg' || file === 'ffprobe'
          ? 'На сервере требуются работающие ffmpeg и ffprobe.'
          : this.job!.stage === 'model' ? 'Не удалось скачать и проверить модель речи.'
            : this.job!.stage === 'environment' ? 'Не удалось создать окружение Python 3 с venv.'
              : 'Не удалось подготовить компоненты распознавания речи.';

      throw new Error(result.timedOut ? 'Превышено время установки. Повторите операцию.'
        : `${reason} Подробности доступны в деталях установки.`);
    }

    return result.stdout;
  }

  private async stage(stage: SpeechInstallJob['stage']): Promise<void> {
    this.job!.stage = stage;
    await this.persist();
  }

  /**
   * Базовые и CUDA-зависимости ставятся одинаковыми аргументами в штатный Python.
   * Закреплённый requirements берётся из текущего выпуска и проходит общий supervisor.
   */
  private installRequirements(file: string): Promise<string> {
    return this.command(this.python, [
      '-m', 'pip', 'install', '--upgrade', '-r',
      path.join(this.options.rootDir, 'server', file),
    ]);
  }

  /**
   * Базовый пакет уже поставлен: canary различает отсутствие GPU и его библиотек.
   * Ручной выбор имеет приоритет, а решение и результат проверки остаются в деталях.
   */
  private async installCuda(cuda?: boolean): Promise<void> {
    await this.stage('gpu');

    let enabled = cuda;

    if (enabled === undefined) {
      const output = await this.command(this.python, [CUDA_PROBE_PY]);
      const probe = JSON.parse(output);

      if (!['ready', 'missing_library', 'no_device'].includes(probe.state)) {
        throw new Error('Не удалось проверить NVIDIA GPU. Выберите CUDA вручную в расширенных настройках.');
      }

      enabled = probe.state !== 'no_device';
      this.job!.output += `\nNVIDIA GPU: ${probe.state}. ${probe.reason ?? ''}\n`;
    }

    this.job!.output += enabled ? '\nCUDA: установка библиотек NVIDIA.\n' : '\nCUDA: выбран CPU.\n';

    if (enabled) {
      await this.installRequirements('requirements-media-cuda.txt');
    }
  }

  /**
   * Пакеты и pinned модель готовятся под одним maintenance и supervisor.
   * Повторная offline-проверка и загрузка весов не дают принять частичный кэш за успех.
   */
  private async installModel(model: SpeechModel): Promise<void> {
    await this.stage('model');
    await this.command(this.python, ['-c', [
      'import json, runpy, sys',
      'from huggingface_hub import snapshot_download',
      'model = json.loads(sys.argv[1])',
      'snapshot_download(repo_id=model["repo"], revision=model["revision"])',
      'inspect = runpy.run_path(sys.argv[2])["inspect_model"]',
      'result = inspect(snapshot_download, model)',
      'assert result["cached"], result["reason"]',
      'from faster_whisper import WhisperModel',
      'WhisperModel(result["snapshotPath"], device="cpu", compute_type="int8", local_files_only=True)',
    ].join('\n'), JSON.stringify(model), MODEL_CACHE_PROBE_PY]);
  }

  /**
   * Удаление ограничено корнем venv, модели и настройки лежат отдельно.
   * Успех подтверждается импортом библиотек и загрузкой выбранных весов, затем обновляется диагностика.
   */
  private async perform(operation: SpeechInstallOperation, cuda: boolean | undefined, model: SpeechModel)
    : Promise<void> {
    try {
      if (operation === 'uninstall') {
        const marker = await fs.stat(path.join(this.venv, 'pyvenv.cfg')).catch(() => null);

        if (!marker?.isFile()) {
          throw new Error('Каталог не является Python-окружением. Автоматическое удаление недоступно.');
        }

        await fs.rm(this.venv, { recursive: true });
      } else {
        await this.command('python3', ['-m', 'venv', this.venv]);

        await this.stage('packages');
        await this.installRequirements('requirements-media.txt');
        await this.installCuda(cuda);
        await this.stage('verification');
        await this.command(this.python, [
          '-c', 'import faster_whisper, ctranslate2, huggingface_hub, numpy',
        ]);
        await this.command('ffmpeg', ['-version']);
        await this.command('ffprobe', ['-version']);
        await this.installModel(model);
      }

      this.job!.stage = 'done';
      this.job!.status = 'succeeded';
    } catch (error) {
      this.job!.status = this.abort.signal.aborted ? 'interrupted' : 'failed';
      this.job!.error = (error as Error).message;
    } finally {
      await Promise.resolve().then(() => this.options.refresh()).catch(() => {});
      await this.persist();
    }
  }

  /**
   * Завершение сервера останавливает только supervisor собственной операции.
   * Закрытие настроек этот метод не вызывает и не отменяет установку.
   */
  async close(): Promise<void> {
    this.abort.abort();
    await this.task;
  }
}
