// Хранилище раздела «Видео»: что остаётся на диске и когда уходит.
//
// Обещания:
//  - повторная загрузка той же записи не создаёт вторую копию: живой замер показал
//    1,4 ГБ за неделю, из них 700 МБ — три копии одного файла;
//  - записи, кадры и фрагменты живут один срок, а расшифровка переживает их;
//  - рабочие каталоги распознавания не остаются мусором после своего процесса;
//  - уборка трогает только своё: чужой каталог рядом с ней не исчезает.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';
import test from 'node:test';

import {
  MEDIA_STORAGE_LIMITS,
  storeUpload,
  sweepJobs,
  sweepMediaStorage,
  sweepUploads,
  sweepWorkDirs,
  uploadsUsage,
} from '../../server/src/lib/media/storage.js';
import mediaModule from '../../server/src/modules/media/index.js';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

const DAY_MS = 24 * 60 * 60 * 1000;

function tempDir(t, prefix = 'cockpit-media-storage-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function upload(dir, filename, body, options = {}) {
  return storeUpload({
    dir,
    filename,
    source: Readable.from([Buffer.from(body)]),
    ...options,
  });
}

/** Состарить файл или каталог: у уборки один вход — время последнего изменения. */
function age(target, ms) {
  const when = new Date(Date.now() - ms);
  fs.utimesSync(target, when, when);
}

// ── Загрузка кладёт по содержимому ──────────────────────────────────────────

test('та же запись не создаёт вторую копию, а обновляет срок жизни первой', async (t) => {
  const dir = tempDir(t);

  const first = await upload(dir, 'встреча.webm', 'одна и та же запись');
  assert.equal(first.reused, false);
  assert.equal(fs.readdirSync(dir).length, 1);

  // Копию состарили: повторная загрузка обязана продлить ей жизнь, иначе уборка
  // унесёт файл, которым только что воспользовались.
  age(first.filePath, 6 * DAY_MS);

  const second = await upload(dir, 'встреча.webm', 'одна и та же запись');
  assert.equal(second.reused, true);
  assert.equal(second.filePath, first.filePath);
  assert.deepEqual(fs.readdirSync(dir).length, 1, 'на диске по-прежнему одна запись');
  assert.ok(Date.now() - fs.statSync(first.filePath).mtimeMs < 5000, 'срок отсчитывается заново');
});

test('переименованная перед загрузкой запись — та же запись', async (t) => {
  const dir = tempDir(t);

  const first = await upload(dir, 'встреча.webm', 'содержимое');
  const renamed = await upload(dir, 'встреча (1).webm', 'содержимое');

  assert.equal(renamed.reused, true);
  assert.equal(renamed.filePath, first.filePath);
});

test('разные записи с одинаковым именем лежат раздельно', async (t) => {
  const dir = tempDir(t);

  const first = await upload(dir, 'video.mp4', 'первая встреча');
  const second = await upload(dir, 'video.mp4', 'вторая встреча');

  assert.notEqual(first.filePath, second.filePath);
  assert.equal(fs.readdirSync(dir).length, 2);
});

test('обрезанная загрузка не остаётся на диске даже временным файлом', async (t) => {
  const dir = tempDir(t);

  const result = await upload(dir, 'встреча.webm', 'огрызок', { truncated: () => true });

  assert.deepEqual([result.truncated, result.filePath], [true, null]);
  assert.deepEqual(fs.readdirSync(dir), [], 'после отказа каталог пуст');
});

// ── Уборка по возрасту ──────────────────────────────────────────────────────

test('записи старше срока уходят, свежие остаются', async (t) => {
  const dir = tempDir(t);

  const old = await upload(dir, 'старая.webm', 'старая запись');
  const fresh = await upload(dir, 'свежая.webm', 'свежая запись');
  age(old.filePath, MEDIA_STORAGE_LIMITS.uploadTtlMs + DAY_MS);

  const swept = sweepUploads(dir);
  assert.equal(swept.removed, 1);
  assert.equal(swept.bytes > 0, true, 'освобождённое место названо цифрой');
  assert.deepEqual(fs.readdirSync(dir), [path.basename(fresh.filePath)]);
});

test('брошенный временный файл ждёт сутки, а не неделю', async (t) => {
  const dir = tempDir(t);
  const abandoned = path.join(dir, '.upload-777-1-встреча.webm');
  fs.writeFileSync(abandoned, 'половина записи');

  assert.equal(sweepUploads(dir).removed, 0, 'свежий обрывок мог остаться от идущей загрузки');

  age(abandoned, 2 * DAY_MS);
  assert.equal(sweepUploads(dir).removed, 1);
});

test('рабочие каталоги распознавания и диктовки не остаются мусором', (t) => {
  const mediaDir = tempDir(t);
  const stale = path.join(mediaDir, 'ingest-abc123');
  const stream = path.join(mediaDir, 'speech-stream-xyz');
  const foreign = path.join(mediaDir, 'meeting-frames');

  for (const dir of [stale, stream, foreign]) {
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'progress.json'), '{}');
    age(dir, 3 * DAY_MS);
  }

  assert.equal(sweepWorkDirs(mediaDir), 2);
  assert.equal(fs.existsSync(foreign), true, 'кадры убирает своя уборка, а не эта');
});

test('расшифровка переживает свою запись, но не живёт вечно', (t) => {
  const jobsDir = tempDir(t);
  const old = path.join(jobsDir, 'job-old.json');
  const fresh = path.join(jobsDir, 'job-fresh.json');
  const foreign = path.join(jobsDir, 'заметка.txt');

  for (const file of [old, fresh, foreign]) {
    fs.writeFileSync(file, '{}');
  }
  // Старше недели, но моложе месяца: запись такой встречи уже удалена, а её
  // расшифровка — единственный оставшийся след, и он ещё нужен.
  age(old, MEDIA_STORAGE_LIMITS.uploadTtlMs + DAY_MS);
  assert.equal(sweepJobs(jobsDir), 0);

  age(old, MEDIA_STORAGE_LIMITS.jobTtlMs + DAY_MS);
  age(foreign, MEDIA_STORAGE_LIMITS.jobTtlMs + DAY_MS);
  assert.equal(sweepJobs(jobsDir), 1);
  assert.equal(fs.existsSync(fresh), true);
  assert.equal(fs.existsSync(foreign), true, 'чужой файл в каталоге не наш мусор');
});

test('подсчёт занятого места не считает недописанные загрузки', async (t) => {
  const dir = tempDir(t);
  await upload(dir, 'встреча.webm', 'запись на двадцать байт');
  fs.writeFileSync(path.join(dir, '.upload-1-2-встреча.webm'), 'идёт прямо сейчас');

  const usage = uploadsUsage(dir);
  assert.equal(usage.files, 1);
  assert.equal(usage.bytes, Buffer.byteLength('запись на двадцать байт'));
  assert.equal(usage.ttlMs, MEDIA_STORAGE_LIMITS.uploadTtlMs);
});

test('общая уборка отчитывается по каждому виду мусора', async (t) => {
  const mediaDir = tempDir(t);
  const uploadsDir = path.join(mediaDir, 'uploads');
  const jobsDir = path.join(mediaDir, 'jobs');
  fs.mkdirSync(jobsDir);

  const record = await upload(uploadsDir, 'встреча.webm', 'запись');
  age(record.filePath, MEDIA_STORAGE_LIMITS.uploadTtlMs + DAY_MS);
  const workDir = path.join(mediaDir, 'ingest-zzz');
  fs.mkdirSync(workDir);
  age(workDir, 2 * DAY_MS);
  const job = path.join(jobsDir, 'job.json');
  fs.writeFileSync(job, '{}');
  age(job, MEDIA_STORAGE_LIMITS.jobTtlMs + DAY_MS);

  const swept = sweepMediaStorage({ mediaDir, uploadsDir, jobsDir });
  assert.deepEqual(
    [swept.uploads, swept.workDirs, swept.jobs],
    [1, 1, 1],
  );
});

// ── Ручки раздела ───────────────────────────────────────────────────────────

async function buildApp(t) {
  const multipart = requireFromServer('@fastify/multipart');
  const mediaDir = tempDir(t, 'cockpit-media-http-');
  const ingested = [];

  const app = Fastify({ logger: false });
  app.decorate('pluginEnabled', () => true);
  await app.register(multipart);
  await app.register(mediaModule, {
    media: {
      mediaDir,
      uploadsDir: path.join(mediaDir, 'uploads'),
      jobsDir: path.join(mediaDir, 'jobs'),
      doctor: () => ({ ok: true }),
      status: () => null,
      ingest: (options) => { ingested.push(options); return { jobId: 'job-1' }; },
    },
    config: { mediaDir },
  });
  await app.ready();
  t.after(() => app.close());

  const send = (filename, body) => app.inject({
    method: 'POST',
    url: '/api/media/upload',
    headers: { 'content-type': 'multipart/form-data; boundary=X' },
    payload: Buffer.concat([
      Buffer.from(`--X\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n`
        + 'Content-Type: video/webm\r\n\r\n'),
      Buffer.from(body),
      Buffer.from('\r\n--X--\r\n'),
    ]),
  });

  return { app, mediaDir, ingested, send };
}

test('повторно загруженная запись переиспользуется и уезжает в распознавание тем же файлом', async (t) => {
  const { mediaDir, ingested, send } = await buildApp(t);

  const first = await send('встреча.webm', 'одна и та же запись');
  const second = await send('встреча.webm', 'одна и та же запись');

  assert.equal(first.statusCode, 200);
  assert.equal(second.json().reused, true);
  assert.equal(fs.readdirSync(path.join(mediaDir, 'uploads')).length, 1);
  assert.equal(ingested[0].filePath, ingested[1].filePath, 'разбор идёт по единственной копии');
});

test('doctor называет занятое записями место и срок их хранения', async (t) => {
  const { mediaDir, send } = await buildApp(t);
  await send('встреча.webm', 'запись на диске');

  const app = Fastify({ logger: false });
  app.decorate('pluginEnabled', () => true);
  await app.register(mediaModule, {
    media: {
      mediaDir,
      uploadsDir: path.join(mediaDir, 'uploads'),
      jobsDir: path.join(mediaDir, 'jobs'),
      doctor: () => ({ ok: true, ffmpeg: true }),
      status: () => null,
      ingest: () => ({ jobId: 'job-1' }),
    },
    config: { mediaDir },
  });
  await app.ready();
  t.after(() => app.close());

  const res = await app.inject({ method: 'GET', url: '/api/media/doctor' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true, 'проверка окружения осталась на месте');
  assert.equal(body.storage.files, 1);
  assert.equal(body.storage.bytes, Buffer.byteLength('запись на диске'));
  assert.equal(body.storage.ttlMs, MEDIA_STORAGE_LIMITS.uploadTtlMs);
});
