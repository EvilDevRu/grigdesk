// Хранилище раздела «Видео»: что лежит на диске между разборами и когда уходит.
//
// Раздел копил всё подряд: исходники в `uploads` не удалялись НИКОГДА, а рабочие
// каталоги распознавания оставались с `progress.json` внутри. Живой замер: 1,4 ГБ за
// неделю работы, причём больше половины — повторные загрузки одного и того же файла
// (одна запись лежала шестью копиями, другая — тремя по 234 МБ). Отсюда два правила:
// файл кладётся ПО СОДЕРЖИМОМУ, поэтому повторная загрузка не создаёт вторую копию,
// а всё, что старше своего срока, подметается перед следующей работой.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const DAY_MS = 24 * 60 * 60 * 1000;

export const MEDIA_STORAGE_LIMITS = {
  // Столько же живут кадры, фрагменты и сам сеанс разбора в браузере: у артефактов
  // одной встречи один срок. Переживи запись свой сеанс — она осталась бы висеть
  // гигабайтами ради разбора, который уже никто не откроет.
  uploadTtlMs: 7 * DAY_MS,
  // Расшифровка весит килобайты и остаётся единственным следом разобранной встречи,
  // поэтому живёт дольше записи — но тоже не вечно.
  jobTtlMs: 30 * DAY_MS,
  // Рабочий каталог распознавания переживает свой процесс только как мусор: wav из
  // него удаляют сразу после расшифровки, остаётся `progress.json` на 31 байт.
  workDirTtlMs: DAY_MS,
  digestChars: 16,
};

// Каталоги, которые создаёт `SpeechRuntime` под один запуск: распознавание видео,
// одиночная диктовка и её потоковый вариант.
const WORK_DIR_PREFIXES = ['ingest-', 'speech-'];
const TMP_PREFIX = '.upload-';

/** Имя файла без символов, опасных для пути; правило то же, что было у загрузки. */
export function safeUploadName(name) {
  return String(name || 'upload').replace(/[^\w.\-а-яё]+/gi, '_');
}

/**
 * Кладёт загруженную запись в хранилище раздела, не создавая второй копии.
 *
 * Пишем во временный файл и считаем sha256 ПО ХОДУ записи: второй проход по диску
 * стоил бы ещё одного чтения сотен мегабайт, а так замер на 275 МБ — одна секунда,
 * что на фоне минут распознавания незаметно. Дальше решает содержимое: файл с тем же
 * хешем уже лежит — временный удаляется, а у существующего обновляется время, чтобы
 * уборка считала срок от последнего использования, а не от первой загрузки.
 *
 * `truncated` спрашиваем ПОСЛЕ записи: multipart при упоре в лимит рвёт поток молча,
 * и обрезок нельзя ни оставить на диске, ни отдать распознаванию.
 */
export async function storeUpload({ dir, filename, source, truncated = () => false }) {
  fs.mkdirSync(dir, { recursive: true });

  const safe = safeUploadName(filename);
  const tmpPath = path.join(dir, `${TMP_PREFIX}${process.pid}-${Date.now()}-${safe}`);
  const hash = createHash('sha256');

  try {
    await pipeline(
      source,
      async function* (chunks) {
        for await (const chunk of chunks) {
          hash.update(chunk);
          yield chunk;
        }
      },
      fs.createWriteStream(tmpPath),
    );

    if (truncated()) {
      fs.rmSync(tmpPath, { force: true });
      return { truncated: true, filePath: null, reused: false, bytes: 0 };
    }

    const digest = hash.digest('hex').slice(0, MEDIA_STORAGE_LIMITS.digestChars);
    const bytes = fs.statSync(tmpPath).size;
    const existing = findByDigest(dir, digest);

    if (existing) {
      fs.rmSync(tmpPath, { force: true });
      touch(existing);
      return { truncated: false, filePath: existing, reused: true, bytes };
    }

    const filePath = path.join(dir, `${digest}-${safe}`);
    fs.renameSync(tmpPath, filePath);
    return { truncated: false, filePath, reused: false, bytes };
  } catch (error) {
    fs.rmSync(tmpPath, { force: true });
    throw error;
  }
}

/**
 * Уже лежащая копия того же содержимого. Ищем по префиксу-хешу, а не по полному имени:
 * ту же запись законно переименовали перед повторной загрузкой, и содержимое от этого
 * не изменилось.
 */
function findByDigest(dir, digest) {
  for (const name of safeReaddir(dir)) {
    if (name.startsWith(`${digest}-`)) {
      return path.join(dir, name);
    }
  }

  return null;
}

function touch(filePath) {
  try {
    const now = new Date();
    fs.utimesSync(filePath, now, now);
  } catch { /* файл мог исчезнуть между поиском и обновлением */ }
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Убирает записи старше срока. Возраст считается по времени файла, а повторная
 * загрузка его обновляет, поэтому запись, которой пользуются, не исчезает из-под
 * идущего разбора: тот занимает минуты против недельного срока.
 */
export function sweepUploads(dir, { ttlMs = MEDIA_STORAGE_LIMITS.uploadTtlMs, now = Date.now } = {}) {
  const edge = now() - ttlMs;
  let removed = 0;
  let bytes = 0;

  for (const name of safeReaddir(dir)) {
    const filePath = path.join(dir, name);

    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) continue;
      // Брошенный временный файл (упавшая или оборванная загрузка) ждать неделю незачем.
      const limit = name.startsWith(TMP_PREFIX) ? now() - MEDIA_STORAGE_LIMITS.workDirTtlMs : edge;
      if (stat.mtimeMs >= limit) continue;

      fs.rmSync(filePath, { force: true });
      removed += 1;
      bytes += stat.size;
    } catch { /* файл мог исчезнуть между чтением и удалением */ }
  }

  return { removed, bytes };
}

/** Убирает рабочие каталоги распознавания и диктовки, оставшиеся от прошлых запусков. */
export function sweepWorkDirs(mediaDir, { ttlMs = MEDIA_STORAGE_LIMITS.workDirTtlMs, now = Date.now } = {}) {
  const edge = now() - ttlMs;
  let removed = 0;

  for (const name of safeReaddir(mediaDir)) {
    if (!WORK_DIR_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;

    const dir = path.join(mediaDir, name);

    try {
      const stat = fs.statSync(dir);
      if (!stat.isDirectory() || stat.mtimeMs >= edge) continue;

      fs.rmSync(dir, { recursive: true, force: true });
      removed += 1;
    } catch { /* каталог мог исчезнуть между чтением и удалением */ }
  }

  return removed;
}

/** Убирает расшифровки, к которым уже не вернуться: их запись давно удалена. */
export function sweepJobs(jobsDir, { ttlMs = MEDIA_STORAGE_LIMITS.jobTtlMs, now = Date.now } = {}) {
  const edge = now() - ttlMs;
  let removed = 0;

  for (const name of safeReaddir(jobsDir)) {
    if (!name.endsWith('.json')) continue;

    const filePath = path.join(jobsDir, name);

    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || stat.mtimeMs >= edge) continue;

      fs.rmSync(filePath, { force: true });
      removed += 1;
    } catch { /* файл мог исчезнуть между чтением и удалением */ }
  }

  return removed;
}

/** Сколько сейчас занимают записи — строка о занятом месте в разделе берётся отсюда. */
export function uploadsUsage(dir) {
  let files = 0;
  let bytes = 0;

  for (const name of safeReaddir(dir)) {
    try {
      const stat = fs.statSync(path.join(dir, name));
      if (!stat.isFile() || name.startsWith(TMP_PREFIX)) continue;

      files += 1;
      bytes += stat.size;
    } catch { /* файл мог исчезнуть между чтением и подсчётом */ }
  }

  return { files, bytes, ttlMs: MEDIA_STORAGE_LIMITS.uploadTtlMs };
}

/**
 * Полная уборка хранилища раздела. Зовётся перед новой загрузкой и при открытии
 * раздела: собственного момента «встреча разобрана» у раздела нет, а редкий обход
 * десятков файлов стоит доли миллисекунды.
 */
export function sweepMediaStorage({ mediaDir, uploadsDir, jobsDir }, options = {}) {
  const uploads = sweepUploads(uploadsDir, options);

  return {
    uploads: uploads.removed,
    uploadBytes: uploads.bytes,
    workDirs: sweepWorkDirs(mediaDir, options),
    jobs: sweepJobs(jobsDir, options),
  };
}
