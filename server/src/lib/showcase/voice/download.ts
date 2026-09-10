// Скачивание и раскладка файлов голоса.
//
// Вынесено из исполнителя установки, потому что это и есть та часть, где ошибка
// стоит дорого: из сети приходит модель, которую потом исполняет движок. Здесь
// проверяются размер и sha256 — и архива, и каждого распакованного файла.
//
// Сверяется СКАЧАННОЕ, а не заголовки ответа: о своём файле сервер на той стороне
// может сказать что угодно.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

import type { PiperVoicePackage } from './piperCatalog.ts';

const run = promisify(execFile);

export type ProgressReport = (step: string, label: string) => Promise<void> | void;

export async function sha256Of(file: string): Promise<string> {
  const hash = createHash('sha256');

  await pipeline(createReadStream(file), hash);

  return hash.digest('hex');
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

  if (hash.digest('hex') !== pack.archiveSha256) {
    throw new Error('sha256 скачанного голоса не совпал с закреплённым');
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
