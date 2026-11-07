// Сырые отсчёты PCM 16 бит: обёртка в WAV и пик громкости.
//
// Своя обёртка вместо ffmpeg — потому что формат тривиален, а лишний процесс на
// каждую реплику только добавил бы способ упасть. Пик нужен адаптерам облачных
// движков: молчащий ответ, который в остальном выглядит как удачный, не должен
// стать звуком сцены.

/**
 * WAV из сырых отсчётов: заголовок в 44 байта перед PCM 16 бит little-endian.
 */
export function wavOfPcm(pcm: Buffer, sampleRate: number, channels = 1): Buffer {
  const header = Buffer.alloc(44);
  const blockAlign = channels * 2;

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

// Пик в долях полной шкалы: 1 — предельная громкость, 0 — тишина.
export function peakOfPcm(pcm: Buffer): number {
  let peak = 0;

  for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
    peak = Math.max(peak, Math.abs(pcm.readInt16LE(offset)));
  }

  return peak / 32_768;
}

// Тишина заданной длины в тех же отсчётах: ноль в каждом.
export function silencePcm(ms: number, sampleRate: number, channels = 1): Buffer {
  const samples = Math.max(0, Math.round((ms / 1000) * sampleRate));

  return Buffer.alloc(samples * channels * 2, 0);
}
