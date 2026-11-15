import { open } from 'node:fs/promises';

import { MAX_WAV_BYTES } from '../audioFile.ts';
import { VoiceError } from '../contract.ts';

/**
 * Исправляет только наблюдавшуюся пару потоковых размеров в PCM16 mono 24 кГц.
 * Произвольный обрезанный WAV не чинится: строгая проверка публикации остаётся обязательной.
 */
export async function normalizeQwenTokenWav(file: string): Promise<void> {
  const handle = await open(file, 'r+');

  try {
    const info = await handle.stat();
    const header = Buffer.alloc(44);
    const { bytesRead } = await handle.read(header, 0, 44, 0);

    if (bytesRead !== 44 || header.toString('ascii', 0, 4) !== 'RIFF'
      || header.readUInt32LE(4) !== 0x7fffffbf || header.readUInt32LE(40) !== 0x7fffff9b) {
      return;
    }

    if (header.toString('ascii', 8, 16) !== 'WAVEfmt '
      || header.readUInt32LE(16) !== 16 || header.readUInt16LE(20) !== 1
      || header.readUInt16LE(22) !== 1 || header.readUInt32LE(24) !== 24000
      || header.readUInt32LE(28) !== 48000 || header.readUInt16LE(32) !== 2
      || header.readUInt16LE(34) !== 16 || header.toString('ascii', 36, 40) !== 'data'
      || info.size <= 44 || info.size > MAX_WAV_BYTES || (info.size - 44) % 2 !== 0) {
      throw new VoiceError('Некорректный потоковый WAV Qwen Token Plan.');
    }

    header.writeUInt32LE(info.size - 8, 4);
    header.writeUInt32LE(info.size - 44, 40);
    await handle.write(header, 0, 44, 0);
  } finally {
    await handle.close();
  }
}
