import { chmod, mkdir, mkdtemp, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import { VoiceError } from './contract.ts';

export const MAX_WAV_BYTES = 64 * 1024 * 1024;

/**
 * Проверка отмены не раскрывает внешний signal.reason: он может содержать произвольные данные.
 * Её повторяют перед публикацией, чтобы отменённый запрос не заменил прежний результат.
 */
export function ensureActive(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new VoiceError('Операция отменена.');
  }
}

/**
 * Объединяет отмену команды и конкретной операции без отдельного listener lifecycle.
 * При отсутствии одного источника возвращает второй без новой сущности.
 */
export function combineSignals(left?: AbortSignal, right?: AbortSignal): AbortSignal | undefined {
  if (left && right && left !== right) {
    return AbortSignal.any([left, right]);
  }

  return left ?? right;
}

/**
 * Принимает только конечный пик реального ответа скрипта; пустой JSON и NaN не успех.
 * Сырые stdout и ошибки JSON не включаются в диагностику.
 */
export function checkSpeechFacts(stdout: string): void {
  let value: unknown;

  try {
    value = JSON.parse(stdout.trim().split('\n').at(-1) ?? '');
  } catch {
    throw new VoiceError('Движок не вернул корректные факты о речи.');
  }

  const facts = value && typeof value === 'object' ? value as Record<string, unknown> : {};

  if (typeof facts.peak !== 'number' || !Number.isFinite(facts.peak)) {
    throw new VoiceError('Движок не вернул конечный пик речи.');
  }

  if (facts.peak < 0.005) {
    throw new VoiceError('Движок вернул тишину вместо речи.');
  }
}

/**
 * Проверяет RIFF/WAVE и границы fmt/data без чтения всего звука в память.
 * Одной сигнатуры RIFF недостаточно: обрезанный файл и пустой data отклоняются.
 */
export async function checkWaveFile(file: string): Promise<number> {
  const handle = await open(file, 'r');

  try {
    const info = await handle.stat();
    const header = Buffer.alloc(12);

    if (!info.isFile() || info.size < 44 || info.size > MAX_WAV_BYTES) {
      throw new VoiceError('Движок не оставил допустимый WAV-файл.');
    }

    await handle.read(header, 0, 12, 0);

    if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') {
      throw new VoiceError('Движок вернул файл другого формата вместо WAV.');
    }

    const end = header.readUInt32LE(4) + 8;

    if (end > info.size || end < 44) {
      throw new VoiceError('WAV-файл обрезан или повреждён.');
    }

    let offset = 12;
    let hasFormat = false;
    let hasData = false;
    let chunks = 0;

    while (offset + 8 <= end) {
      const chunk = Buffer.alloc(8);

      await handle.read(chunk, 0, 8, offset);

      const length = chunk.readUInt32LE(4);
      const name = chunk.toString('ascii', 0, 4);

      chunks += 1;

      if (offset + 8 + length > end || chunks > 4096) {
        throw new VoiceError('WAV-файл обрезан или повреждён.');
      }

      if (name === 'fmt ' && length >= 16) {
        const format = Buffer.alloc(16);

        await handle.read(format, 0, 16, offset + 8);
        hasFormat = format.readUInt16LE(2) > 0 && format.readUInt32LE(4) > 0
          && format.readUInt16LE(12) > 0;
      }

      if (name === 'data' && length > 0) {
        hasData = true;
      }

      offset += 8 + length + (length % 2);
    }

    if (!hasFormat || !hasData || offset !== end) {
      throw new VoiceError('WAV-файл не содержит корректной звуковой дорожки.');
    }

    return info.size;
  } finally {
    await handle.close();
  }
}

/**
 * Производитель пишет в приватный соседний каталог на том же файловом разделе.
 * Только принятый WAV заменяет target; при отказе прежний target остаётся целым.
 */
export async function withAudioOutput(
  outputFile: string,
  produce: (temporaryFile: string) => Promise<void>,
  signal?: AbortSignal,
): Promise<{
  file: string;
  bytes: number;
  format: 'wav';
}> {
  ensureActive(signal);

  const target = path.resolve(outputFile);
  const parent = path.dirname(target);

  await mkdir(parent, { recursive: true });

  const work = await mkdtemp(path.join(parent, '.voice-output-'));

  try {
    await chmod(work, 0o700);

    const temporaryFile = path.join(work, 'audio.wav');

    await produce(temporaryFile);
    ensureActive(signal);

    const bytes = await checkWaveFile(temporaryFile);

    ensureActive(signal);
    await rename(temporaryFile, target);

    return {
      file: target,
      bytes,
      format: 'wav',
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
