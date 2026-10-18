// Установка локального голоса: движок и модель приходят один раз, по кнопке.
//
// Почему это отдельное задание, а не действие внутри запроса: скачивание идёт
// минуты, зависит от сети и обязано пережить перезапуск GrigDesk. Поэтому работу
// делает отсоединённый процесс, а сервер остаётся единственным писателем
// состояния — тем же разделением, что и у записи браузера.
//
// Из сети приходит исполняемый код (колёса python) и модель. Поэтому адрес и
// sha256 закреплены в каталоге, а установка объявляется удачной ТОЛЬКО после
// синтеза контрольной фразы: успешный `pip install` голосом ещё не является.
//
// Движков, которые ставятся кнопкой, три — Piper, Silero и Qwen3-TTS, — и у
// каждого своё python-окружение: torch весит сотни мегабайт (с CUDA — гигабайты),
// и его обновление не должно менять состав, на котором проверен другой голос.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { processAlive } from '../processIdentity.ts';
import { launchWorker, readProgressSince, stopWorker } from '../render/runner.ts';
import { PIPER_VOICES } from './piperCatalog.ts';
import type { PiperVoicePackage } from './piperCatalog.ts';
import { QWEN_VOICES } from './qwenCatalog.ts';
import type { QwenVoicePackage } from './qwenCatalog.ts';
import { SILERO_VOICES } from './sileroCatalog.ts';
import type { SileroVoicePackage } from './sileroCatalog.ts';
import { readInstalledVoices } from './piper.ts';
import type { InstalledPiperVoice } from './piper.ts';
import { readInstalledQwenModels } from './qwen.ts';
import { readInstalledSileroModels } from './silero.ts';
import type { JobIdentity } from '../jobs.ts';
import { ShowcaseError } from '../errors.ts';

const WORKER_SCRIPT = fileURLToPath(
  new URL('../../../../scripts/showcaseVoiceInstall.mts', import.meta.url),
);
const REQUIREMENTS: Record<VoiceEngineId, string> = {
  piper: fileURLToPath(new URL('../../../../requirements-showcase-voice.txt', import.meta.url)),
  silero: fileURLToPath(new URL('../../../../requirements-showcase-silero.txt', import.meta.url)),
  qwen: fileURLToPath(new URL('../../../../requirements-showcase-qwen.txt', import.meta.url)),
};

// Сеть бывает медленной, а колёса и модель весят гигабайты. Срок нужен всё
// равно: без него оборванная загрузка держала бы кнопку занятой навсегда.
const INSTALL_DEADLINE_MS = 120 * 60_000;

export type VoiceEngineId = 'piper' | 'silero' | 'qwen';

export type VoicePackage = PiperVoicePackage | SileroVoicePackage | QwenVoicePackage;

export type VoiceInstallState = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';

export interface VoiceInstallRecord {
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
  identity: JobIdentity;
  workDir: string;
  sequence: number;
}

export interface PublicVoiceInstall {
  id: string;
  engineId: string;
  voiceId: string;
  state: VoiceInstallState;
  step: string;
  label: string;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface VoiceInstallStatus {
  // Что можно поставить: размер человек должен видеть ДО нажатия, потому что
  // качается это по его сети и в его каталог. Имена голосов пакета — тоже:
  // модель Silero несёт пять дикторов, и выбирать её стоит зная, кого услышишь.
  available: {
    id: string;
    engineId: VoiceEngineId;
    name: string;
    language: string;
    timbre: string;
    byteSize: number;
    license: string;
    voices: string[];
    installed: boolean;
  }[];
  installed: InstalledPiperVoice[];
  job: PublicVoiceInstall | null;
}

export interface VoiceInstallerOptions {
  voiceDir: string;
  bootstrapPython?: string;
  broadcast: (event: string, data: unknown) => void;
  nodeBin?: string;
  // Исполнитель подменяется, чтобы жизненный цикл установки — повтор нажатия,
  // отмена, потеря процесса — проверялся без скачивания сотен мегабайт. Сам
  // порядок шагов от подмены не зависит: его задаёт worker.
  workerScript?: { file: string; marker: string };
  // Список голосов приходит опцией, а не берётся из модуля напрямую: правила
  // занятости и отказа проверяются на нескольких голосах, а в закреплённом
  // каталоге их немного.
  voices?: readonly VoicePackage[];
  // Вызывается по удачной установке: движки забывают кэш готовности, чтобы
  // событие «голос установлен» показало живой статус, а не прежний отказ.
  onInstalled?: (voiceId: string) => void;
}

export function voiceRuntimePaths(voiceDir: string): { python: string; voicesDir: string } {
  return {
    python: path.join(voiceDir, 'venv', 'bin', 'python'),
    voicesDir: path.join(voiceDir, 'voices'),
  };
}

export function sileroRuntimePaths(voiceDir: string): { python: string; modelsDir: string } {
  return {
    python: path.join(voiceDir, 'silero-venv', 'bin', 'python'),
    modelsDir: path.join(voiceDir, 'silero'),
  };
}

export function qwenRuntimePaths(voiceDir: string): { python: string; modelsDir: string } {
  return {
    python: path.join(voiceDir, 'qwen-venv', 'bin', 'python'),
    modelsDir: path.join(voiceDir, 'qwen'),
  };
}

/** Пакеты старого вида без поля движка — это Piper: другого раньше не было. */
function engineOf(pack: VoicePackage): VoiceEngineId {
  if (pack.engineId === 'silero' || pack.engineId === 'qwen') {
    return pack.engineId;
  }

  return 'piper';
}

function packageVoices(pack: VoicePackage): string[] {
  if (pack.engineId === 'silero' || pack.engineId === 'qwen') {
    return pack.speakers.map((speaker) => speaker.name);
  }

  return [pack.name];
}

function packageBytes(pack: VoicePackage): number {
  if (pack.engineId === 'silero') {
    return pack.fileBytes + pack.engineBytes;
  }

  if (pack.engineId === 'qwen') {
    return pack.modelBytes + pack.engineBytes;
  }

  return pack.archiveBytes;
}

function toPublic(record: VoiceInstallRecord): PublicVoiceInstall {
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
  };
}

export function createVoiceInstaller(options: VoiceInstallerOptions) {
  // Порядок — как у движков в службе: Qwen первым, потому что его ставят ради качества.
  const catalog: readonly VoicePackage[] = options.voices
    ?? [...QWEN_VOICES, ...SILERO_VOICES, ...PIPER_VOICES];
  const piperPaths = voiceRuntimePaths(options.voiceDir);
  const sileroPaths = sileroRuntimePaths(options.voiceDir);
  const qwenPaths = qwenRuntimePaths(options.voiceDir);
  const stateFile = path.join(options.voiceDir, 'install.json');

  let current: VoiceInstallRecord | null = null;
  let loaded = false;

  async function persist(record: VoiceInstallRecord | null): Promise<void> {
    current = record;

    if (!record) {
      await fs.rm(stateFile, { force: true });

      return;
    }

    await fs.mkdir(options.voiceDir, { recursive: true, mode: 0o700 });

    const temporary = `${stateFile}.tmp`;

    await fs.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await fs.rename(temporary, stateFile);
  }

  function publish(record: VoiceInstallRecord): void {
    options.broadcast('showcase-voice', {
      installId: record.id,
      voiceId: record.voiceId,
      state: record.state,
      step: record.step,
      label: record.label,
      error: record.error,
    });
  }

  async function load(): Promise<VoiceInstallRecord | null> {
    if (loaded) {
      return current;
    }

    loaded = true;
    current = await fs.readFile(stateFile, 'utf8').then(
      (text) => JSON.parse(text) as VoiceInstallRecord,
      () => null,
    );

    return current;
  }

  async function readResult(workDir: string): Promise<{
    state: 'succeeded' | 'failed';
    error?: string;
  } | null> {
    return fs.readFile(path.join(workDir, 'result.json'), 'utf8').then(
      (text) => {
        const parsed = JSON.parse(text) as { state?: string; error?: string };

        return parsed.state === 'succeeded' || parsed.state === 'failed'
          ? (parsed as { state: 'succeeded' | 'failed'; error?: string })
          : null;
      },
      () => null,
    );
  }

  async function finish(
    record: VoiceInstallRecord,
    state: VoiceInstallState,
    label: string,
    error: string | null,
  ): Promise<void> {
    const next: VoiceInstallRecord = {
      ...record,
      state,
      label,
      error,
      finishedAt: new Date().toISOString(),
    };

    await persist(next);
    publish(next);

    if (state === 'succeeded') {
      options.onInstalled?.(record.voiceId);
    }
  }

  /**
   * Опрос идущей установки: новые строки журнала попытки и её итог. Вызывается
   * тем же тактом, что и опрос записи, — отдельного таймера у раздела нет.
   */
  async function poll(): Promise<void> {
    const record = await load();

    if (!record || record.state !== 'running') {
      return;
    }

    const lines = await readProgressSince(record.workDir, record.sequence);

    if (lines.length > 0) {
      const last = lines.at(-1)!;
      const next: VoiceInstallRecord = {
        ...record,
        sequence: last.sequence,
        step: last.state,
        label: last.label,
      };

      await persist(next);
      publish(next);
    }

    const fresh = (await load())!;
    const result = await readResult(record.workDir);

    if (result) {
      if (result.state === 'succeeded') {
        await finish(fresh, 'succeeded', 'голос установлен', null);
      } else {
        await finish(fresh, 'failed', 'установка не удалась', result.error ?? 'причина неизвестна');
      }

      return;
    }

    if (Date.now() > Date.parse(fresh.deadlineAt)) {
      stopWorker(fresh.identity);
      await finish(fresh, 'failed', 'установка не уложилась в срок', 'срок установки истёк');

      return;
    }

    if (!processAlive(fresh.identity)) {
      await finish(
        fresh,
        'interrupted',
        'установка оборвалась',
        'процесс установки исчез: повторите её, скачанное сохранено',
      );
    }
  }

  async function status(): Promise<VoiceInstallStatus> {
    const installed = await readInstalledVoices(piperPaths.voicesDir);
    const sileroModels = await readInstalledSileroModels(sileroPaths.modelsDir);
    const qwenModels = await readInstalledQwenModels(qwenPaths.modelsDir);
    const record = await load();
    const presentIds: Record<VoiceEngineId, string[]> = {
      piper: installed.map((voice) => voice.id),
      silero: sileroModels.map((model) => model.id),
      qwen: qwenModels.map((model) => model.id),
    };

    return {
      available: catalog.map((item) => {
        const engineId = engineOf(item);
        const present = presentIds[engineId].includes(item.id);

        return {
          id: item.id,
          engineId,
          name: item.name,
          language: item.language,
          timbre: item.timbre,
          byteSize: packageBytes(item),
          license: item.license,
          voices: packageVoices(item),
          installed: present,
        };
      }),
      installed,
      job: record ? toPublic(record) : null,
    };
  }

  /**
   * Запуск установки. Повторное нажатие по тому же голосу возвращает идущую
   * установку, а не заводит вторую: два pip в один venv портят его состав.
   */
  async function start(voiceId: string): Promise<VoiceInstallStatus> {
    const pack = catalog.find((item) => item.id === voiceId) ?? null;

    if (!pack) {
      throw new ShowcaseError('unknown_voice', `Голос «${voiceId}» не значится в списке.`, 400);
    }

    const record = await load();

    if (record?.state === 'running' && processAlive(record.identity)) {
      if (record.voiceId !== voiceId) {
        throw new ShowcaseError(
          'voice_install_busy',
          `Сейчас ставится другой голос: ${record.voiceId}.`,
          409,
        );
      }

      return status();
    }

    await fs.mkdir(options.voiceDir, { recursive: true, mode: 0o700 });

    const engineId = engineOf(pack);
    const runtime: Record<VoiceEngineId, { venvDir: string; voicesDir: string }> = {
      piper: { venvDir: path.join(options.voiceDir, 'venv'), voicesDir: piperPaths.voicesDir },
      silero: { venvDir: path.join(options.voiceDir, 'silero-venv'), voicesDir: sileroPaths.modelsDir },
      qwen: { venvDir: path.join(options.voiceDir, 'qwen-venv'), voicesDir: qwenPaths.modelsDir },
    };
    const handle = await launchWorker({
      workDir: path.join(options.voiceDir, 'install'),
      nodeBin: options.nodeBin,
      script: options.workerScript ?? { file: WORKER_SCRIPT, marker: 'showcaseVoiceInstall' },
      task: {
        voice: pack,
        venvDir: runtime[engineId].venvDir,
        voicesDir: runtime[engineId].voicesDir,
        requirementsFile: REQUIREMENTS[engineId],
        bootstrapPython: options.bootstrapPython || 'python3',
        deadlineMs: INSTALL_DEADLINE_MS,
      },
    });
    const started: VoiceInstallRecord = {
      schemaVersion: 1,
      id: handle.attemptId,
      engineId,
      voiceId,
      state: 'running',
      step: 'start',
      label: 'установка начата',
      error: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      deadlineAt: new Date(Date.now() + INSTALL_DEADLINE_MS).toISOString(),
      identity: handle.identity,
      workDir: handle.workDir,
      sequence: 0,
    };

    await persist(started);
    publish(started);

    return status();
  }

  async function cancel(): Promise<VoiceInstallStatus> {
    const record = await load();

    if (!record || record.state !== 'running') {
      return status();
    }

    stopWorker(record.identity);
    await finish(record, 'cancelled', 'установка отменена', null);

    return status();
  }

  /**
   * Сверка после перезапуска сервера. Идущая установка остаётся под наблюдением,
   * исчезнувшая честно называется оборванной: «идёт» у мёртвого процесса хуже,
   * чем отказ, потому что человек ждёт впустую.
   */
  async function recover(): Promise<void> {
    const record = await load();

    if (!record || record.state !== 'running') {
      return;
    }

    if (processAlive(record.identity)) {
      return;
    }

    await poll();

    const fresh = await load();

    if (fresh?.state === 'running') {
      await finish(fresh, 'interrupted', 'установка оборвалась', 'сервер не нашёл её процесса');
    }
  }

  return { cancel, paths: piperPaths, poll, recover, start, status };
}

export type VoiceInstaller = ReturnType<typeof createVoiceInstaller>;
