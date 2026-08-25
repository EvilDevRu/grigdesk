// Кадр записи к черновику задачи.
//
// Задачу с встречи формулирует модель по чужой речи, и проверить формулировку человек
// может только вернувшись к месту записи. Таймкод в описании («На записи: 04:31») это
// уже даёт, но требует открыть файл; кадр показывает то же место сразу и потому решает
// вопрос «о чём вообще шла речь» до создания задачи, а не после.
//
// Секунду берём у ПЕРВОЙ реплики повода — той же, что стоит в описании. Кадр из
// середины обсуждения выглядел бы содержательнее, но его таймкода нет в тексте, и
// сверить картинку с записью было бы нечем: у кадра и у ссылки должно быть одно место.
//
// Наружу уходит только ИМЯ кадра (`<run>/<файл>`), не путь: путь из браузера означал бы
// «покажи любой файл сервера», а вложение по такому пути — «залей любой файл на портал».
import { basename, join } from 'node:path';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';

export const MEETING_FRAME_LIMITS = Object.freeze({
  // Кадры — производный артефакт: исходник записи и расшифровка остаются на месте,
  // а картинки нужны ровно до того, как человек разобрал встречу.
  ttlMs: 7 * 24 * 60 * 60 * 1000,
});

// Имя собирается сервером и проверяется буквально: точек и слэшей внутри частей нет
// вовсе, поэтому выйти из каталога кадров такому имени нечем.
const NAME_RE = /^[0-9a-f]{16}\/p\d{1,2}-\d{5}s\.jpg$/;

/** Имя кадра в том виде, в каком его отдали браузеру. */
export function isMeetingFrameName(value) {
  return typeof value === 'string' && NAME_RE.test(value);
}

/** Абсолютный путь кадра по его имени; `null` — имя не наше или файла нет. */
export function meetingFramePath(root, name) {
  if (!root || !isMeetingFrameName(name)) return null;
  const [run, file] = name.split('/');
  const full = join(root, run, file);
  return existsSync(full) ? full : null;
}

/** Секунда записи, к которой относится задача (сквозная, как таймкоды в описании). */
export function frameSecond(task, segments = []) {
  const index = Array.isArray(task?.segments) ? task.segments[0] : null;
  if (!Number.isSafeInteger(index) || index < 1) return null;
  const at = Number(segments[index - 1]?.start);
  return Number.isFinite(at) && at >= 0 ? at : null;
}

/**
 * Какой части встречи принадлежит сквозная секунда и какая она там локально.
 * Части идут подряд, поэтому подходит последняя, чьё начало не позже искомого.
 */
export function locatePart(at, parts = []) {
  if (!Number.isFinite(at) || at < 0) return null;
  let found = null;
  for (const [index, part] of parts.entries()) {
    const offset = Number(part?.offset) || 0;
    if (offset > at) break;
    found = { index, part, offset };
  }
  if (!found) return null;
  const duration = Number(found.part?.duration);
  let local = Math.round(at - found.offset);
  // Клампим по длительности: `-ss` за концом файла даёт пустой вывод и ненулевой код
  // ffmpeg, то есть один промах отменил бы кадры всей части.
  if (Number.isFinite(duration) && duration > 1) local = Math.min(local, Math.floor(duration) - 1);
  return { index: found.index, part: found.part, seconds: Math.max(0, local) };
}

/**
 * Кадры к задачам плана. Возвращает массив той же длины, что `tasks`: `null` означает
 * «кадра нет» — запись без видеодорожки, исчезнувший файл или отказ ffmpeg. Отсутствие
 * кадра не является отказом разбора: задачи уже разобраны, и терять их из-за картинки
 * нельзя.
 *
 * @param {{tasks:Array, segments:Array, parts:Array, run:string,
 *          extract:Function, log?:object}} opts
 */
export async function buildMeetingFrames({
  tasks = [],
  segments = [],
  parts = [],
  run,
  extract,
  log = console,
} = {}) {
  const out = tasks.map(() => null);
  if (typeof extract !== 'function' || !run) return out;

  // Сначала раскладываем задачи по частям, потом извлекаем: у ffmpeg дорог запуск,
  // и один вызов на часть дешевле, чем один на задачу.
  const wanted = new Map();               // индекс части → Set секунд
  const placed = tasks.map((task) => {
    const at = frameSecond(task, segments);
    const spot = at === null ? null : locatePart(at, parts);
    if (!spot) return null;
    if (!wanted.has(spot.index)) wanted.set(spot.index, new Set());
    wanted.get(spot.index).add(spot.seconds);
    return { at, index: spot.index, seconds: spot.seconds, part: spot.part };
  });

  const made = new Map();                 // `${индекс части}:${секунда}` → имя файла
  for (const [index, seconds] of wanted) {
    const part = parts[index];
    if (!part?.filePath) continue;
    try {
      const frames = await extract({
        filePath: part.filePath,
        seconds: [...seconds].sort((a, b) => a - b),
        run,
        part: index,
      });
      for (const frame of frames || []) {
        made.set(`${index}:${Math.round(Number(frame.seconds))}`, basename(frame.path));
      }
    } catch (error) {
      // Аудиозапись без видеодорожки попадает сюда штатно — это не поломка раздела,
      // поэтому info, а не warn, и разбор продолжается без кадров.
      log?.info?.({ err: error, part: index }, 'разбор встречи: кадры части не сняты');
    }
  }

  for (const [i, spot] of placed.entries()) {
    if (!spot) continue;
    const file = made.get(`${spot.index}:${spot.seconds}`);
    if (file) out[i] = { name: `${run}/${file}`, at: Math.round(spot.at) };
  }
  return out;
}

/**
 * Убирает кадры прошлых разборов. Вызывается перед новым: держать их вечно незачем,
 * а собственного момента «встреча разобрана» у раздела нет — черновик живёт в браузере.
 */
export function sweepMeetingFrames(root, options = {}) {
  return sweepRunDirs(root, { ttlMs: MEETING_FRAME_LIMITS.ttlMs, ...options });
}

/**
 * Уборка каталогов разборов по возрасту. Общая и для кадров, и для фрагментов записи:
 * устроены они одинаково (каталог на разбор, файлы внутри), а вторая копия обхода
 * разошлась бы с первой на первой же правке.
 */
export function sweepRunDirs(root, { ttlMs = MEETING_FRAME_LIMITS.ttlMs, now = Date.now } = {}) {
  if (!root || !existsSync(root)) return 0;
  const edge = now() - ttlMs;
  let removed = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    try {
      if (statSync(dir).mtimeMs >= edge) continue;
      rmSync(dir, { recursive: true, force: true });
      removed += 1;
    } catch { /* каталог мог исчезнуть между чтением и удалением */ }
  }
  return removed;
}
