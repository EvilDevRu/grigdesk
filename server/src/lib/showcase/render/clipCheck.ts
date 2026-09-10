// Детерминированная проверка записанного клипа.
//
// Опытный прогон захода 0 показал два способа получить «успешный» пустой результат:
// браузер иногда пишет полностью однотонный файл при выполненном условии готовности
// (две записи из двадцати), и он же может умереть молча, оставив обрезок. Поэтому
// клип принимается по СВОЕМУ содержимому, а не по тому, что запись завершилась без
// исключения.
//
// Однотонность считается разбросом яркости внутри кадра, а не средней яркостью:
// тёмная тема стенда — обычное дело, а вот кадр, где все пиксели одинаковы, это
// белый лист или чёрный экран, но не интерфейс.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';

const run = promisify(execFile);

const MIN_BYTES = 12_000;
const FLAT_SPREAD = 8;

export interface ClipCheckResult {
  ok: boolean;
  reason: string;
  byteSize: number;
  durationMs: number;
  flatFrames: number;
  sampledFrames: number;
}

export async function probeDurationMs(file: string): Promise<number> {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    file,
  ]);
  const seconds = Number(stdout.trim());

  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0;
}

interface FrameStat {
  min: number;
  max: number;
}

/**
 * Статистика яркости по кадрам. Считается одним проходом ffprobe: вытаскивать кадры
 * картинками и разбирать их сторонним инструментом дороже и добавило бы разделу
 * зависимость ради того, что медиа-стек уже умеет.
 */
async function frameStats(file: string): Promise<FrameStat[]> {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-f', 'lavfi',
    '-i', `movie=${file.replaceAll('\\', '\\\\').replaceAll(':', '\\:')},signalstats`,
    '-show_entries', 'frame_tags=lavfi.signalstats.YMIN,lavfi.signalstats.YMAX',
    '-of', 'json',
  ], { maxBuffer: 32 * 1024 * 1024 });
  const parsed = JSON.parse(stdout) as {
    frames?: { tags?: Record<string, string> }[];
  };

  return (parsed.frames ?? []).map((frame) => ({
    min: Number(frame.tags?.['lavfi.signalstats.YMIN'] ?? 0),
    max: Number(frame.tags?.['lavfi.signalstats.YMAX'] ?? 0),
  }));
}

/**
 * Клип принимается, если он не пуст, длится хотя бы заданный минимум и содержит
 * кадры с картинкой. Причина отказа возвращается словами: повтор сцены имеет смысл
 * только тогда, когда понятно, что именно не получилось.
 */
export async function checkSceneClip(
  file: string,
  { minDurationMs = 200 }: { minDurationMs?: number } = {},
): Promise<ClipCheckResult> {
  const info = await fs.stat(file).catch(() => null);
  const empty: ClipCheckResult = {
    ok: false,
    reason: '',
    byteSize: info?.size ?? 0,
    durationMs: 0,
    flatFrames: 0,
    sampledFrames: 0,
  };

  if (!info || !info.isFile()) {
    return { ...empty, reason: 'Файл записи не появился.' };
  }

  if (info.size < MIN_BYTES) {
    return { ...empty, reason: `Запись подозрительно мала: ${info.size} Б.` };
  }

  const durationMs = await probeDurationMs(file);

  if (durationMs < minDurationMs) {
    return { ...empty, durationMs, reason: `Запись короче ожидаемого: ${durationMs} мс.` };
  }

  const frames = await frameStats(file);
  const flat = frames.filter((frame) => frame.max - frame.min < FLAT_SPREAD);

  if (frames.length === 0) {
    return { ...empty, durationMs, reason: 'В записи не нашлось ни одного кадра.' };
  }

  // Одиночный однотонный кадр бывает на переходе; сплошной однотонный клип означает,
  // что экран так и не отрисовался.
  if (flat.length === frames.length) {
    return {
      ...empty,
      durationMs,
      flatFrames: flat.length,
      sampledFrames: frames.length,
      reason: 'В записи нет картинки: все кадры однотонные.',
    };
  }

  return {
    ok: true,
    reason: '',
    byteSize: info.size,
    durationMs,
    flatFrames: flat.length,
    sampledFrames: frames.length,
  };
}
