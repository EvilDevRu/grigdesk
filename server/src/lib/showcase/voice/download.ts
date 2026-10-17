// Скачивание и раскладка файлов голоса.
//
// Вынесено из исполнителя установки, потому что это и есть та часть, где ошибка
// стоит дорого: из сети приходит модель, которую потом исполняет движок. Здесь
// проверяются размер и sha256 — и архива, и каждого распакованного файла.
//
// Сверяется СКАЧАННОЕ, а не заголовки ответа: о своём файле сервер на той стороне
// может сказать что угодно. При несовпадении ошибка называет обе суммы —
// ожидаемую и полученную: опечатка в каталоге чинится по журналу установки,
// а не повторной загрузкой гигабайтов вручную.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  mkdir, mkdtemp, readFile, rename, rm, stat, truncate, writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

import { setTimeout as pause } from 'node:timers/promises';

import type { PiperVoicePackage } from './piperCatalog.ts';
import type { QwenModelFile, QwenVoicePackage } from './qwenCatalog.ts';
import type { SileroVoicePackage } from './sileroCatalog.ts';

const run = promisify(execFile);

export type ProgressReport = (step: string, label: string) => Promise<void> | void;

export async function sha256Of(file: string): Promise<string> {
  const hash = createHash('sha256');

  await pipeline(createReadStream(file), hash);

  return hash.digest('hex');
}

/**
 * Сумма git blob: sha1 от `blob <байт>\0<содержимое>`. Это единственная сумма,
 * которую репозиторий моделей публикует для файлов вне LFS, и по ней сверяются
 * конфигурации и словари токенизатора.
 */
export async function gitBlobSha1Of(file: string): Promise<string> {
  const { size } = await stat(file);
  const hash = createHash('sha1');

  hash.update(`blob ${size}\0`);
  await pipeline(createReadStream(file), hash);

  return hash.digest('hex');
}

export interface CheckedSource {
  url: string;
  bytes: number;
  // Достаточно одной из сумм; при обеих сверяются обе.
  sha256?: string;
  gitBlobSha1?: string;
}

function mismatch(kind: string, expected: string, received: string): Error {
  return new Error(`${kind} не совпал: ожидалось ${expected}, получено ${received}`);
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(() => true, () => false);
}

/**
 * Загрузка архива с проверкой размера и суммы. Проценты сообщаются десятками:
 * человеку нужен признак движения, а не строка на каждый килобайт.
 */
export async function downloadVoiceArchive(
  pack: PiperVoicePackage,
  target: string,
  report: ProgressReport,
): Promise<void> {
  await report('voice', `скачиваю голос «${pack.name}»`);

  const response = await fetch(pack.url, { redirect: 'follow' });

  if (!response.ok || !response.body) {
    throw new Error(`источник голоса ответил ${response.status}`);
  }

  const hash = createHash('sha256');
  const output = createWriteStream(target, { mode: 0o600 });
  let received = 0;
  let announced = 0;

  await pipeline(
    Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
    async function* (source) {
      for await (const chunk of source) {
        const buffer = chunk as Buffer;

        hash.update(buffer);
        received += buffer.byteLength;

        const percent = Math.floor((received / pack.archiveBytes) * 100);

        if (percent >= announced + 10) {
          announced = percent;
          await report('voice', `скачано ${Math.min(percent, 100)}%`);
        }

        yield buffer;
      }
    },
    output,
  );

  if (received !== pack.archiveBytes) {
    throw new Error(`размер голоса не совпал: ${received} вместо ${pack.archiveBytes}`);
  }

  const actual = hash.digest('hex');

  if (actual !== pack.archiveSha256) {
    throw new Error(
      `sha256 скачанного голоса не совпал с закреплённым: ожидалось ${pack.archiveSha256}, `
        + `получено ${actual}`,
    );
  }
}

/**
 * Раскладка голоса в каталог раздела. Уже лежащие файлы с верными суммами
 * повторно не качаются: прерванную установку человек повторяет тем же нажатием,
 * и платить за это второй загрузкой ему незачем.
 */
export async function installVoiceFiles(
  pack: PiperVoicePackage,
  voicesDir: string,
  report: ProgressReport,
): Promise<string> {
  const voiceDir = path.join(voicesDir, pack.id);
  const modelFile = path.join(voiceDir, pack.modelName);
  const configFile = path.join(voiceDir, pack.configName);
  const ready = await exists(modelFile)
    && await exists(configFile)
    && await sha256Of(modelFile) === pack.modelSha256
    && await sha256Of(configFile) === pack.configSha256;

  if (ready) {
    await report('voice', 'файлы голоса уже на месте');

    return voiceDir;
  }

  const staging = await mkdtemp(path.join(os.tmpdir(), 'showcase-voice-'));

  try {
    const archive = path.join(staging, 'voice.tar.gz');

    await downloadVoiceArchive(pack, archive, report);
    await report('voice', 'распаковываю');
    // Распаковка отдельным процессом: свой разбор tar здесь означал бы свой
    // разбор путей внутри архива, а это ровно тот код, в котором ошибаются.
    await run('tar', ['-xzf', archive, '-C', staging], { timeout: 120_000 });

    const unpackedModel = path.join(staging, pack.modelName);
    const unpackedConfig = path.join(staging, pack.configName);

    if (await sha256Of(unpackedModel) !== pack.modelSha256) {
      throw new Error('sha256 модели голоса не совпал с закреплённым');
    }

    if (await sha256Of(unpackedConfig) !== pack.configSha256) {
      throw new Error('sha256 описания голоса не совпало с закреплённым');
    }

    await mkdir(voiceDir, { recursive: true, mode: 0o700 });
    await rename(unpackedModel, modelFile);
    await rename(unpackedConfig, configFile);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }

  return voiceDir;
}

// Сеть рвёт длинные загрузки: у файла на гигабайты обрыв посреди пути — обычное
// дело, и качать его заново с нуля значило бы никогда не докачать. Поэтому файл
// копится в `.part` рядом с целью, повтор продолжает с места обрыва запросом
// Range, пауза между повторами растёт, а число попыток ограничено — бесконечно
// перебирать мёртвый источник нельзя. Нестабильной сети нужны десятки попыток:
// каждая из них — не «ещё раз с нуля», а следующий кусок того же файла.
const DOWNLOAD_ATTEMPTS = 30;
const RETRY_PAUSE_MS = 3000;
const RETRY_PAUSE_MAX_MS = 30_000;

export interface DownloadOptions {
  attempts?: number;
  pauseMs?: number;
}

/**
 * Отказ ИСТОЧНИКА: сеть, обрыв, код ответа. Он отличается от несовпадения суммы
 * или размера — те говорят о каталоге или о содержимом, и другой источник с ними
 * не поможет, а вот недоступный хост стоит заменить зеркалом.
 */
export class SourceError extends Error {
  transient: boolean;

  constructor(message: string, transient: boolean) {
    super(message);
    this.name = 'SourceError';
    this.transient = transient;
  }
}

async function sizeOf(file: string): Promise<number> {
  return stat(file).then((info) => info.size, () => 0);
}

/**
 * Одна попытка загрузки в `.part`: с начала или с места обрыва. Источник, который
 * не понял Range и ответил 200, отдаёт файл целиком — тогда накопленное
 * отбрасывается, иначе в файле оказался бы кусок посреди кусков. Обрыв до
 * заявленного размера — временный отказ: следующая попытка продолжит.
 */
async function downloadPart(
  source: CheckedSource,
  partial: string,
  label: string,
  report: ProgressReport,
): Promise<void> {
  const have = await sizeOf(partial);

  if (have >= source.bytes) {
    return;
  }

  const percentOf = (bytes: number) => Math.floor((bytes / source.bytes) * 100);

  await report('voice', have > 0
    ? `${label}: продолжаю с ${percentOf(have)}%`
    : `скачиваю ${label}`);

  let response: Response;

  try {
    response = await fetch(source.url, {
      redirect: 'follow',
      headers: have > 0 ? { range: `bytes=${have}-` } : {},
    });
  } catch (error) {
    const cause = (error as { cause?: { message?: unknown } }).cause?.message;
    const message = typeof cause === 'string' ? cause : (error instanceof Error ? error.message : '');

    throw new SourceError(`источник недоступен: ${message || 'сеть'}`, true);
  }

  if (response.status === 416) {
    // Источник не принял смещение: накопленный кусок длиннее файла или испорчен.
    await truncate(partial, 0);

    throw new SourceError('источник отверг докачку, начинаю заново', true);
  }

  if (!response.ok || !response.body) {
    throw new SourceError(
      `источник ответил ${response.status}`,
      response.status === 429 || response.status >= 500,
    );
  }

  const resumed = have > 0 && response.status === 206;

  if (have > 0 && !resumed) {
    await truncate(partial, 0);
  }

  const output = createWriteStream(partial, { flags: resumed ? 'a' : 'w', mode: 0o600 });
  let received = resumed ? have : 0;
  let announced = percentOf(received);

  try {
    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      async function* (stream) {
        for await (const chunk of stream) {
          const buffer = chunk as Buffer;

          received += buffer.byteLength;

          const percent = percentOf(received);

          if (percent >= announced + 10) {
            announced = percent;
            await report('voice', `${label}: скачано ${Math.min(percent, 100)}%`);
          }

          yield buffer;
        }
      },
      output,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    throw new SourceError(`соединение оборвалось: ${message}`, true);
  }

  if (received === source.bytes) {
    return;
  }

  // Меньше заявленного бывает по двум причинам, и лечатся они по-разному: обрыв
  // докачивается, а полностью отданный источником файл другого размера — ошибка
  // каталога, и повторять её незачем. Различает их content-length ответа.
  const declared = Number(response.headers.get('content-length') ?? Number.NaN);
  const complete = Number.isFinite(declared) && declared === received - (resumed ? have : 0);

  if (received < source.bytes && !complete) {
    throw new SourceError(
      `соединение оборвалось на ${percentOf(received)}% файла ${label}`,
      true,
    );
  }

  await truncate(partial, 0);

  throw new Error(`размер файла ${label} не совпал: ${received} вместо ${source.bytes}`);
}

/**
 * Загрузка одного файла с проверкой размера и суммы. Сверяется СКАЧАННОЕ, а не
 * заголовки ответа: о своём файле сервер на той стороне может сказать что угодно.
 * Суммы считаются по готовому файлу с диска, а не на лету: докачанный кусок
 * иначе пришлось бы хешировать вместе с уже лежащим началом.
 *
 * Файл с неверной суммой остаётся в `.part` вместе с отметкой, какую сумму от него
 * ждали: опечатку в каталоге чинят по журналу, и следующая попытка с исправленной
 * суммой примет уже скачанное; та же сумма второй раз означает испорченный файл,
 * и он качается заново.
 */
export async function downloadChecked(
  source: CheckedSource,
  target: string,
  label: string,
  report: ProgressReport,
  options: DownloadOptions = {},
): Promise<void> {
  if (!source.sha256 && !source.gitBlobSha1) {
    throw new Error(`у файла ${label} в каталоге нет ни одной суммы`);
  }

  const attempts = Math.max(1, options.attempts ?? DOWNLOAD_ATTEMPTS);
  const pauseMs = options.pauseMs ?? RETRY_PAUSE_MS;

  const partial = `${target}.part`;
  const marker = `${partial}.mismatch`;
  const expected = source.sha256 ?? source.gitBlobSha1 ?? '';
  const previousMismatch = await readFile(marker, 'utf8').catch(() => '');

  if (previousMismatch && previousMismatch === expected) {
    await rm(partial, { force: true });
  }

  await rm(marker, { force: true });

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await downloadPart(source, partial, label, report);

      break;
    } catch (error) {
      const transient = error instanceof SourceError && error.transient;

      if (!transient || attempt === attempts) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);

      await report('voice', `${label}: ${message} — повтор ${attempt} из ${attempts - 1}`);
      await pause(Math.min(pauseMs * attempt, Math.max(pauseMs, RETRY_PAUSE_MAX_MS)));
    }
  }

  const received = await sizeOf(partial);

  if (received !== source.bytes) {
    throw new Error(`размер файла ${label} не совпал: ${received} вместо ${source.bytes}`);
  }

  if (source.sha256) {
    const actual = await sha256Of(partial);

    if (actual !== source.sha256) {
      await writeFile(marker, source.sha256, 'utf8');

      throw mismatch(`sha256 файла ${label}`, source.sha256, actual);
    }
  }

  if (source.gitBlobSha1) {
    const actual = await gitBlobSha1Of(partial);

    if (actual !== source.gitBlobSha1) {
      await writeFile(marker, source.gitBlobSha1, 'utf8');

      throw mismatch(`git blob sha1 файла ${label}`, source.gitBlobSha1, actual);
    }
  }

  await rename(partial, target);
}

/** Лежащий на диске файл совпадает с каталогом по размеру и известной сумме. */
async function matchesSource(file: string, source: Omit<CheckedSource, 'url'>): Promise<boolean> {
  const info = await stat(file).catch(() => null);

  if (!info || info.size !== source.bytes) {
    return false;
  }

  if (source.sha256) {
    return await sha256Of(file) === source.sha256;
  }

  return Boolean(source.gitBlobSha1) && await gitBlobSha1Of(file) === source.gitBlobSha1;
}

/**
 * Раскладка модели Silero. Модель — один файл torch-пакета; уже лежащий с верной
 * суммой повторно не качается, прерванная установка повторяется тем же нажатием.
 */
export async function installSileroFiles(
  pack: SileroVoicePackage,
  modelsDir: string,
  report: ProgressReport,
): Promise<string> {
  const modelDir = path.join(modelsDir, pack.id);
  const modelFile = path.join(modelDir, pack.fileName);

  if (await exists(modelFile) && await sha256Of(modelFile) === pack.fileSha256) {
    await report('voice', 'файл модели уже на месте');

    return modelDir;
  }

  const staging = await mkdtemp(path.join(os.tmpdir(), 'showcase-voice-'));

  try {
    const downloaded = path.join(staging, pack.fileName);

    await downloadChecked(
      { url: pack.url, sha256: pack.fileSha256, bytes: pack.fileBytes },
      downloaded,
      `модель «${pack.name}»`,
      report,
    );
    await mkdir(modelDir, { recursive: true, mode: 0o700 });
    await rename(downloaded, modelFile);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }

  return modelDir;
}

/**
 * Один файл с основного источника или с зеркала. Зеркало — не доверенный источник,
 * а запасной адрес тех же байтов: каждый файл сверяется с суммой из каталога, и
 * подмена содержимого на любом из адресов остановит установку. Недоступный адрес
 * запоминается — остальные файлы не ждут его повторов.
 */
async function downloadFromAnySource(
  pack: QwenVoicePackage,
  file: QwenModelFile,
  target: string,
  report: ProgressReport,
  dead: Set<string>,
  options: DownloadOptions,
): Promise<void> {
  const bases = [pack.baseUrl, ...(pack.mirrorUrls ?? [])].filter((base) => !dead.has(base));
  let lastError: unknown = new Error(`ни один источник файла ${file.path} не ответил`);

  for (const base of bases) {
    try {
      await downloadChecked(
        { ...file, url: `${base}${file.path}` },
        target,
        file.path,
        report,
        options,
      );

      return;
    } catch (error) {
      if (!(error instanceof SourceError)) {
        throw error;
      }

      dead.add(base);
      lastError = error;
      await report('voice', `${file.path}: ${error.message}; пробую другой источник`);
    }
  }

  throw lastError;
}

/**
 * Раскладка модели Qwen3-TTS: несколько файлов по подкаталогам. Каждый качается
 * отдельно и сверяется своей суммой; уже лежащий с верной суммой не качается, а
 * недокачанный кусок переживает отказ установки — прерванная на четвёртом
 * гигабайте установка продолжается тем же нажатием с того же места. Промежуточный
 * каталог живёт рядом с моделью, а не в /tmp: переименование четырёх гигабайт
 * между файловыми системами превратилось бы в копирование, а /tmp не пережил бы
 * перезагрузку.
 */
export async function installQwenFiles(
  pack: QwenVoicePackage,
  modelsDir: string,
  report: ProgressReport,
  options: DownloadOptions = {},
): Promise<string> {
  const modelDir = path.join(modelsDir, pack.id);
  const staging = path.join(modelsDir, '.staging');
  // Источники, которые уже не ответили: следующий файл к ним не возвращается.
  const dead = new Set<string>();

  await mkdir(modelDir, { recursive: true, mode: 0o700 });
  await mkdir(staging, { recursive: true, mode: 0o700 });

  for (const file of pack.files) {
    const target = path.join(modelDir, file.path);

    if (await matchesSource(target, file)) {
      await report('voice', `${file.path} уже на месте`);

      continue;
    }

    const downloaded = path.join(staging, file.path.replaceAll('/', '__'));

    await downloadFromAnySource(pack, file, downloaded, report, dead, options);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await rename(downloaded, target);
  }

  // Убирается только после удачи: при отказе в нём лежат куски для докачки.
  await rm(staging, { recursive: true, force: true });

  return modelDir;
}
