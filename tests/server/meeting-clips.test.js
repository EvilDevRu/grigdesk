// Фрагмент записи к черновику задачи: предпросмотр до постановки и вложение к задаче.
//
// Обещания:
//  - кусок стоит ВОКРУГ той же секунды, что кадр и ссылка в описании;
//  - окно фиксированное, но человек может расширить его в известных границах;
//  - фрагмент режется по границе своей части встречи, а не склеивает соседние;
//  - плеер получает Range, иначе перемотки внутри куска нет;
//  - наружу уходит только ИМЯ: путь из браузера означал бы «нарежь любой файл сервера»,
//    а вложение по такому пути — «залей любой файл на портал».
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

import {
  MEETING_CLIP_LIMITS,
  buildMeetingClip,
  clipRange,
  clipWindow,
  isMeetingClipName,
  meetingClipPath,
  meetingClipRun,
  sweepMeetingClips,
} from '../../server/src/lib/media/meetingClips.ts';
import b24Module from '../../server/src/modules/b24/index.ts';
import mediaModule, { parseByteRange } from '../../server/src/modules/media/index.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

const RUN = '0123456789abcdef';
const PARTS = [
  { filePath: '/a.webm', offset: 0, duration: 300 },
  { filePath: '/b.webm', offset: 300, duration: 80 },
];

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ── Куда попадает фрагмент ──────────────────────────────────────────────────

test('окно стоит вокруг секунды задачи и живёт в её части встречи', () => {
  const middle = clipRange(120, PARTS, 15);
  assert.equal(middle.index, 0);
  assert.deepEqual([middle.from, middle.seconds], [105, 30]);
  // Сквозные секунды — то, что видит человек: таймкоды в описании тоже сквозные.
  assert.deepEqual([middle.fromAt, middle.at, middle.toAt], [105, 120, 135]);

  // 305-я сквозная секунда — это 5-я секунда ВТОРОГО файла, и окно считается в нём.
  const second = clipRange(305, PARTS, 15);
  assert.equal(second.index, 1);
  assert.deepEqual([second.from, second.seconds], [0, 20]);
  assert.deepEqual([second.fromAt, second.toAt], [300, 320]);
});

test('края записи не выходят за файл: `-ss` за концом даёт пустой вывод и отказ ffmpeg', () => {
  // Начало клампится нулём…
  assert.deepEqual(clipRange(5, PARTS, 15), {
    index: 0, part: PARTS[0], from: 0, seconds: 20, at: 5, fromAt: 0, toAt: 20,
  });
  // …конец — длительностью части.
  const tail = clipRange(295, PARTS, 15);
  assert.deepEqual([tail.from, tail.seconds, tail.toAt], [280, 20, 300]);
  assert.equal(clipRange(-1, PARTS, 15), null);
});

test('окно человека не выходит за границы: чужое число не режет полчаса', () => {
  assert.equal(clipWindow(undefined), MEETING_CLIP_LIMITS.windowSec);
  assert.equal(clipWindow('нет'), MEETING_CLIP_LIMITS.windowSec);
  assert.equal(clipWindow(1), MEETING_CLIP_LIMITS.minWindowSec);
  assert.equal(clipWindow(600), MEETING_CLIP_LIMITS.maxWindowSec);
  assert.equal(clipWindow(30), 30);
});

test('каталог разбора считается от самих частей, а не случайно', () => {
  // Тот же разбор обязан попадать в тот же каталог: иначе повторный просмотр резал бы
  // файл заново и множил копии одного куска.
  assert.equal(meetingClipRun(['job-1', 'job-2']), meetingClipRun(['job-2', 'job-1']));
  assert.notEqual(meetingClipRun(['job-1']), meetingClipRun(['job-2']));
  assert.match(meetingClipRun(['job-1']), /^[0-9a-f]{16}$/u);
});

test('отказ ffmpeg оставляет черновик без фрагмента, но не рушит его', async () => {
  const logged = [];
  const clip = await buildMeetingClip({
    at: 120,
    parts: PARTS,
    run: RUN,
    cut: async () => { throw new Error('Output file #0 does not contain any stream'); },
    log: { info: (...args) => logged.push(args) },
  });
  assert.equal(clip, null);
  assert.equal(logged.length, 1, 'причина названа в журнале, а не проглочена');
});

test('вырезанный кусок описывает себя сквозными секундами и весом', async () => {
  const asked = [];
  const clip = await buildMeetingClip({
    at: 305,
    parts: PARTS,
    run: RUN,
    cut: async (options) => {
      asked.push(options);
      return { path: `/tmp/${RUN}/p1-00000-020s.mp4`, bytes: 383371 };
    },
  });
  assert.deepEqual(asked, [{ filePath: '/b.webm', from: 0, seconds: 20, run: RUN, part: 1 }]);
  assert.deepEqual(clip, {
    name: `${RUN}/p1-00000-020s.mp4`, at: 305, from: 300, to: 320, seconds: 20, bytes: 383371,
  });
});

// ── Имя фрагмента — единственное, что уходит наружу ─────────────────────────

test('имя фрагмента проверяется буквально, путь снаружи не принимается', (t) => {
  const root = tempDir(t, 'grigdesk-clips-');
  fs.mkdirSync(path.join(root, RUN), { recursive: true });
  fs.writeFileSync(path.join(root, RUN, 'p0-00105-030s.mp4'), 'mp4-bytes');

  assert.equal(isMeetingClipName(`${RUN}/p0-00105-030s.mp4`), true);
  for (const bad of [
    `${RUN}/../../../etc/passwd`,
    '../../etc/passwd',
    `${RUN}/p0-00105-030s.mp4/../../x`,
    '/etc/passwd',
    `${RUN}/p0-00105-030s.mov`,
    'ZZZZZZZZZZZZZZZZ/p0-00105-030s.mp4',
    `${RUN}/p0-105-30s.mp4`,
    null,
  ]) assert.equal(isMeetingClipName(bad), false, `имя не должно проходить: ${bad}`);

  assert.equal(
    meetingClipPath(root, `${RUN}/p0-00105-030s.mp4`),
    path.join(root, RUN, 'p0-00105-030s.mp4'),
  );
  assert.equal(meetingClipPath(root, `${RUN}/p0-00999-030s.mp4`), null, 'несуществующий файл — не путь');
  assert.equal(meetingClipPath(root, '/etc/passwd'), null);
});

test('фрагменты прошлых разборов убираются по возрасту', (t) => {
  const root = tempDir(t, 'grigdesk-clips-ttl-');
  const old = path.join(root, 'aaaaaaaaaaaaaaaa');
  const fresh = path.join(root, 'bbbbbbbbbbbbbbbb');
  fs.mkdirSync(old, { recursive: true });
  fs.mkdirSync(fresh, { recursive: true });
  const longAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  fs.utimesSync(old, longAgo, longAgo);

  assert.equal(sweepMeetingClips(root), 1);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(fresh), true, 'свежий разбор не трогаем');
});

// ── Range: без него у плеера нет перемотки ──────────────────────────────────

test('Range разбирается по обеим формам плеера, а вылет за файл даёт 416', () => {
  assert.equal(parseByteRange(undefined, 100), null, 'нет заголовка — файл целиком');
  assert.equal(parseByteRange('bytes=0-1,5-6', 100), null, 'составной диапазон плееру не нужен');
  assert.deepEqual(parseByteRange('bytes=10-19', 100), { start: 10, end: 19 });
  assert.deepEqual(parseByteRange('bytes=10-', 100), { start: 10, end: 99 });
  // Хвостом браузер добирает индекс в конце контейнера.
  assert.deepEqual(parseByteRange('bytes=-20', 100), { start: 80, end: 99 });
  assert.deepEqual(parseByteRange('bytes=0-999', 100), { start: 0, end: 99 });
  assert.equal(parseByteRange('bytes=200-300', 100), 'invalid');
});

// ── Ручка раздела ───────────────────────────────────────────────────────────

async function buildMediaApp(t, { clipsRoot, meetingClip, enabled = () => true }) {
  const app = Fastify({ logger: false });
  app.decorate('pluginEnabled', enabled);
  app.register(mediaModule, {
    media: {
      mediaDir: clipsRoot,
      framesRoot: path.join(clipsRoot, 'frames'),
      clipsRoot,
      doctor: () => ({ ok: true }),
      status: (id) => (id === 'job-1' ? {
        status: 'done',
        filePath: '/записи/встреча.webm',
        result: { duration: 1024, transcript: { segments: [{ start: 0, end: 3, text: 'Начали.' }] } },
      } : null),
      ingest: () => ({ jobId: 'job-1' }),
      meetingFrames: async () => [],
      meetingClip,
    },
    config: { mediaDir: clipsRoot },
  });
  await app.ready();
  t.after(() => app.close());
  return app;
}

/** Подставной ffmpeg: кладёт настоящий файл, чтобы отдача байтов проверялась целиком. */
function fakeCut(root, body = 'mp4-bytes-0123456789') {
  const asked = [];
  const cut = async ({ filePath, from, seconds, run, part }) => {
    asked.push({ filePath, from, seconds, part });
    fs.mkdirSync(path.join(root, run), { recursive: true });
    const file = path.join(
      root,
      run,
      `p${part}-${String(from).padStart(5, '0')}-${String(seconds).padStart(3, '0')}s.mp4`,
    );
    fs.writeFileSync(file, body);
    return { path: file, bytes: body.length };
  };
  return { asked, cut };
}

test('фрагмент режется по секунде задачи, а его байты отдаются с перемоткой', async (t) => {
  const root = tempDir(t, 'grigdesk-clips-api-');
  const { asked, cut } = fakeCut(root);
  const app = await buildMediaApp(t, { clipsRoot: root, meetingClip: cut });

  const res = await app.inject({
    method: 'POST',
    url: '/api/media/clip',
    payload: { jobIds: ['job-1'], at: 272 },
  });
  assert.equal(res.statusCode, 200);
  const { clip } = res.json();
  // Путь исходника взят из СВОЕГО job'а, а не из тела запроса.
  assert.deepEqual(asked, [{ filePath: '/записи/встреча.webm', from: 257, seconds: 30, part: 0 }]);
  assert.deepEqual([clip.from, clip.at, clip.to], [257, 272, 287]);
  assert.match(clip.name, /^[0-9a-f]{16}\/p0-00257-030s\.mp4$/u);

  const whole = await app.inject({ method: 'GET', url: `/api/media/clip/${clip.name}` });
  assert.equal(whole.statusCode, 200);
  assert.equal(whole.headers['content-type'], 'video/mp4');
  assert.equal(whole.headers['accept-ranges'], 'bytes');

  // Без 206 плеер не даёт перемотку внутри куска, а Safari вовсе не стартует.
  const part = await app.inject({
    method: 'GET',
    url: `/api/media/clip/${clip.name}`,
    headers: { range: 'bytes=4-9' },
  });
  assert.equal(part.statusCode, 206);
  assert.equal(part.headers['content-range'], 'bytes 4-9/20');
  assert.equal(part.body, 'bytes-');

  const over = await app.inject({
    method: 'GET',
    url: `/api/media/clip/${clip.name}`,
    headers: { range: 'bytes=900-999' },
  });
  assert.equal(over.statusCode, 416);

  const forged = await app.inject({ method: 'GET', url: `/api/media/clip/${RUN}/p0-00001-030s.mp4` });
  assert.equal(forged.statusCode, 404, 'чужое имя не отдаёт байтов');
});

test('человек может расширить окно, но только в известных границах', async (t) => {
  const root = tempDir(t, 'grigdesk-clips-window-');
  const { asked, cut } = fakeCut(root);
  const app = await buildMediaApp(t, { clipsRoot: root, meetingClip: cut });

  await app.inject({ method: 'POST', url: '/api/media/clip', payload: { jobIds: ['job-1'], at: 272, window: 30 } });
  await app.inject({ method: 'POST', url: '/api/media/clip', payload: { jobIds: ['job-1'], at: 272, window: 9000 } });
  assert.deepEqual(asked.map((a) => a.seconds), [60, 120]);
});

test('запись без видеодорожки отвечает пустотой, а не ошибкой разбора', async (t) => {
  const root = tempDir(t, 'grigdesk-clips-audio-');
  const app = await buildMediaApp(t, {
    clipsRoot: root,
    meetingClip: async () => { throw Object.assign(new Error('нет видеодорожки'), { code: 'no_video' }); },
  });
  const res = await app.inject({
    method: 'POST',
    url: '/api/media/clip',
    payload: { jobIds: ['job-1'], at: 10 },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().clip, null);
});

test('без секунды и по чужому job не режем', async (t) => {
  const root = tempDir(t, 'grigdesk-clips-bad-');
  const { cut } = fakeCut(root);
  const app = await buildMediaApp(t, { clipsRoot: root, meetingClip: cut });

  const noAt = await app.inject({ method: 'POST', url: '/api/media/clip', payload: { jobIds: ['job-1'] } });
  assert.equal(noAt.statusCode, 400);

  const alien = await app.inject({
    method: 'POST',
    url: '/api/media/clip',
    payload: { jobIds: ['чужой-job'], at: 10 },
  });
  assert.equal(alien.statusCode, 404);
});

test('выключенный плагин не режет, не отдаёт байтов и не даёт пути для вложения', async (t) => {
  const root = tempDir(t, 'grigdesk-clips-off-');
  const { cut } = fakeCut(root);
  const app = await buildMediaApp(t, { clipsRoot: root, meetingClip: cut, enabled: () => false });

  const res = await app.inject({
    method: 'POST',
    url: '/api/media/clip',
    payload: { jobIds: ['job-1'], at: 272 },
  });
  assert.equal(res.statusCode, 404);
  assert.equal(app.mediaClipPath(`${RUN}/p0-00257-030s.mp4`), null);
});

// ── Вложение на портал ──────────────────────────────────────────────────────

async function buildTaskApp(t, { clipPath }) {
  const created = [];
  const app = Fastify({ logger: false });
  app.decorate('mediaClipPath', clipPath);
  app.register(b24Module, {
    b24: { createTask: async (body) => { created.push(body); return { id: 4242 }; } },
  });
  await app.ready();
  t.after(() => app.close());
  return { app, created };
}

test('фрагмент уезжает на портал ИМЕНЕМ: путь подставляет сервер, а не браузер', async (t) => {
  const { app, created } = await buildTaskApp(t, {
    clipPath: (name) => (name === `${RUN}/p0-00257-030s.mp4` ? '/media/meeting-clips/готовый.mp4' : null),
  });

  const res = await app.inject({
    method: 'POST',
    url: '/api/b24/tasks',
    payload: {
      title: 'Время забора',
      // Произвольный путь в теле — это «залей на портал что скажу»: ручка грузит файлы
      // наружу, поэтому путь она не принимает вовсе.
      clips: [`${RUN}/p0-00257-030s.mp4`, '/etc/passwd', '../../secret.mp4'],
    },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(created[0].images, [{ path: '/media/meeting-clips/готовый.mp4', name: 'фрагмент.mp4' }]);
  assert.equal('clips' in created[0], false, 'сырое поле до клиента портала не доходит');
});

test('пропавший фрагмент не отменяет постановку задачи', async (t) => {
  const { app, created } = await buildTaskApp(t, { clipPath: () => null });
  const res = await app.inject({
    method: 'POST',
    url: '/api/b24/tasks',
    payload: { title: 'Время забора', clips: [`${RUN}/p0-00257-030s.mp4`] },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(created[0].images, undefined);
  assert.equal(created[0].title, 'Время забора');
});
