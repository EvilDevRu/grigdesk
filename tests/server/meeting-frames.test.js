// Кадр записи к черновику задачи: превью до постановки и вложение к задаче.
//
// Обещания:
//  - кадр снимается на том же таймкоде, что стоит в описании задачи;
//  - у встречи из нескольких частей секунда пересчитывается в ЛОКАЛЬНУЮ секунду части;
//  - запись без видеодорожки (или отказ ffmpeg) не отменяет уже разобранные задачи;
//  - наружу уходит только ИМЯ кадра: путь из браузера означал бы «покажи любой файл»,
//    а вложение по такому пути — «залей любой файл на портал».
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

import {
  buildMeetingFrames,
  frameSecond,
  isMeetingFrameName,
  locatePart,
  meetingFramePath,
  sweepMeetingFrames,
} from '../../server/src/lib/media/meetingFrames.ts';
import trackerModule from '../../server/src/modules/tracker/index.ts';
import mediaModule from '../../server/src/modules/media/index.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

const RUN = '0123456789abcdef';

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ── Куда смотрит кадр ───────────────────────────────────────────────────────

test('секунда кадра — первая реплика повода, та же, что в описании задачи', () => {
  const segments = [{ start: 0 }, { start: 271.5 }, { start: 640 }];
  // Кадр из середины обсуждения выглядел бы содержательнее, но его таймкода нет в
  // тексте задачи — сверить картинку с записью было бы нечем.
  assert.equal(frameSecond({ segments: [2, 3] }, segments), 271.5);
  assert.equal(frameSecond({ segments: [] }, segments), null);
  assert.equal(frameSecond({ segments: [9] }, segments), null);
});

test('сквозная секунда пересчитывается в локальную секунду своей части', () => {
  const parts = [
    { filePath: '/a.webm', offset: 0, duration: 300 },
    { filePath: '/b.webm', offset: 300, duration: 80 },
  ];
  assert.deepEqual(locatePart(10, parts), { index: 0, part: parts[0], seconds: 10 });
  // 305 сквозной секунды — это 5-я секунда ВТОРОГО файла.
  assert.deepEqual(locatePart(305, parts), { index: 1, part: parts[1], seconds: 5 });
  // Клампим по длительности: `-ss` за концом файла даёт ненулевой код ffmpeg, то есть
  // один промах отменил бы кадры всей части.
  assert.equal(locatePart(999, parts).seconds, 79);
  assert.equal(locatePart(-1, parts), null);
});

// ── Съёмка ──────────────────────────────────────────────────────────────────

test('кадры снимаются по одному вызову на часть, повторная секунда не дублируется', async () => {
  const parts = [
    { filePath: '/a.webm', offset: 0, duration: 300 },
    { filePath: '/b.webm', offset: 300, duration: 80 },
  ];
  const segments = [{ start: 10 }, { start: 10.2 }, { start: 305 }];
  const calls = [];
  const frames = await buildMeetingFrames({
    tasks: [{ segments: [1] }, { segments: [2] }, { segments: [3] }],
    segments,
    parts,
    run: RUN,
    extract: async ({ filePath, seconds, part }) => {
      calls.push({ filePath, seconds, part });
      return seconds.map((sec) => ({
        seconds: sec,
        path: `/tmp/${RUN}/p${part}-${String(sec).padStart(5, '0')}s.jpg`,
      }));
    },
  });

  assert.equal(calls.length, 2, 'по одному запуску ffmpeg на часть, а не на задачу');
  assert.deepEqual(calls[0], { filePath: '/a.webm', seconds: [10], part: 0 });
  assert.deepEqual(calls[1], { filePath: '/b.webm', seconds: [5], part: 1 });
  assert.deepEqual(frames[0], { name: `${RUN}/p0-00010s.jpg`, at: 10 });
  assert.deepEqual(frames[1], { name: `${RUN}/p0-00010s.jpg`, at: 10 }, 'соседние реплики делят кадр');
  assert.deepEqual(frames[2], { name: `${RUN}/p1-00005s.jpg`, at: 305 });
});

test('запись без видеодорожки оставляет задачи без кадров, но не отменяет их', async () => {
  const logged = [];
  const frames = await buildMeetingFrames({
    tasks: [{ segments: [1] }],
    segments: [{ start: 4 }],
    parts: [{ filePath: '/only-audio.m4a', offset: 0, duration: 60 }],
    run: RUN,
    extract: async () => { throw new Error('Output file #0 does not contain any stream'); },
    log: { info: (...args) => logged.push(args) },
  });
  assert.deepEqual(frames, [null]);
  assert.equal(logged.length, 1, 'причина названа в журнале, а не проглочена');
});

// ── Имя кадра — единственное, что уходит наружу ─────────────────────────────

test('имя кадра проверяется буквально, путь снаружи не принимается', (t) => {
  const root = tempDir(t, 'grigdesk-frames-');
  fs.mkdirSync(path.join(root, RUN), { recursive: true });
  fs.writeFileSync(path.join(root, RUN, 'p0-00271s.jpg'), 'jpeg-bytes');

  assert.equal(isMeetingFrameName(`${RUN}/p0-00271s.jpg`), true);
  for (const bad of [
    `${RUN}/../../../etc/passwd`,
    '../../etc/passwd',
    `${RUN}/p0-00271s.jpg/../../x`,
    '/etc/passwd',
    `${RUN}/p0-00271s.png`,
    'ZZZZZZZZZZZZZZZZ/p0-00271s.jpg',
    `${RUN}/p0-271s.jpg`,
    null,
  ]) assert.equal(isMeetingFrameName(bad), false, `имя не должно проходить: ${bad}`);

  assert.equal(meetingFramePath(root, `${RUN}/p0-00271s.jpg`), path.join(root, RUN, 'p0-00271s.jpg'));
  assert.equal(meetingFramePath(root, `${RUN}/p0-00999s.jpg`), null, 'несуществующий файл — не путь');
  assert.equal(meetingFramePath(root, '/etc/passwd'), null);
});

test('кадры прошлых разборов убираются по возрасту', (t) => {
  const root = tempDir(t, 'grigdesk-frames-ttl-');
  const old = path.join(root, 'aaaaaaaaaaaaaaaa');
  const fresh = path.join(root, 'bbbbbbbbbbbbbbbb');
  fs.mkdirSync(old, { recursive: true });
  fs.mkdirSync(fresh, { recursive: true });
  const longAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  fs.utimesSync(old, longAgo, longAgo);

  assert.equal(sweepMeetingFrames(root), 1);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(fresh), true, 'свежий разбор не трогаем');
  assert.equal(sweepMeetingFrames('/нет/такого/каталога'), 0);
});

// ── Ручка раздела: кадр приезжает вместе с задачей ──────────────────────────

const SEGMENTS = [
  { start: 0, end: 3, text: 'Начали.' },
  { start: 271.5, end: 275, text: 'Надо добавить время забора в комментарий.' },
];
const PLAN = JSON.stringify({
  tasks: [{
    segments: [2],
    title: 'Время забора в комментарии',
    description: 'Добавить время, до которого нужно забрать.',
    confidence: 0.9,
    reason: 'Прямая просьба на встрече.',
  }],
});

async function buildMediaApp(t, { framesRoot, meetingFrames }) {
  const app = Fastify({ logger: false });
  app.decorate('pluginEnabled', () => true);
  app.register(mediaModule, {
    media: {
      mediaDir: framesRoot,
      framesRoot,
      doctor: () => ({ ok: true }),
      status: (id) => (id === 'job-1' ? {
        status: 'done',
        filePath: '/записи/встреча.webm',
        result: { duration: 1024, transcript: { segments: SEGMENTS } },
      } : null),
      ingest: () => ({ jobId: 'job-1' }),
      meetingFrames,
    },
    config: { mediaDir: framesRoot },
    meetingModelRef: () => ({ provider: 'claude', model: 'claude-opus-5' }),
    providerSettings: () => ({}),
    resolveMeetingTarget: async ({ modelRef }) => ({
      ok: true,
      ref: modelRef,
      executor: { runUntrusted: async () => ({ reply: PLAN }) },
    }),
  });
  await app.ready();
  t.after(() => app.close());
  return app;
}

test('к задаче приезжает кадр её таймкода, и его байты отдаёт отдельная ручка', async (t) => {
  const root = tempDir(t, 'grigdesk-frames-api-');
  const asked = [];
  const app = await buildMediaApp(t, {
    framesRoot: root,
    meetingFrames: async ({ filePath, seconds, run, part }) => {
      asked.push({ filePath, seconds, part });
      fs.mkdirSync(path.join(root, run), { recursive: true });
      return seconds.map((sec) => {
        const file = path.join(root, run, `p${part}-${String(sec).padStart(5, '0')}s.jpg`);
        fs.writeFileSync(file, 'jpeg-bytes');
        return { seconds: sec, path: file };
      });
    },
  });

  const res = await app.inject({ method: 'POST', url: '/api/media/plan-tasks', payload: { jobId: 'job-1' } });
  assert.equal(res.statusCode, 200);
  const task = res.json().tasks[0];
  // Путь исходника взят из СВОЕГО job'а, а не из тела запроса.
  assert.deepEqual(asked, [{ filePath: '/записи/встреча.webm', seconds: [272], part: 0 }]);
  assert.equal(task.frame.at, 272);
  assert.match(task.description, /На записи: 04:31/u, 'кадр и ссылка указывают на одно место');
  assert.match(task.frame.name, /^[0-9a-f]{16}\/p0-00272s\.jpg$/u);

  const image = await app.inject({ method: 'GET', url: `/api/media/frame/${task.frame.name}` });
  assert.equal(image.statusCode, 200);
  assert.equal(image.headers['content-type'], 'image/jpeg');
  assert.equal(image.body, 'jpeg-bytes');

  const forged = await app.inject({ method: 'GET', url: `/api/media/frame/${RUN}/p0-00001s.jpg` });
  assert.equal(forged.statusCode, 404, 'чужое имя не отдаёт байтов');
});

test('отказ ffmpeg оставляет задачи без кадра, а не рушит разбор', async (t) => {
  const root = tempDir(t, 'grigdesk-frames-fail-');
  const app = await buildMediaApp(t, {
    framesRoot: root,
    meetingFrames: async () => { throw new Error('ffmpeg упал'); },
  });
  const res = await app.inject({ method: 'POST', url: '/api/media/plan-tasks', payload: { jobId: 'job-1' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().tasks[0].frame, null);
  assert.equal(res.json().tasks[0].title, 'Время забора в комментарии');
});

// ── Вложение на портал ──────────────────────────────────────────────────────

/**
 * Фикстура проверяет разрешение имени кадра перед отправкой задачи трекеру.
 * Пути файлов остаются под контролем media-декоратора HTTP-модуля.
 */
async function buildTaskApp(t, { framePath }) {
  const created = [];
  const app = Fastify({ logger: false });
  app.decorate('mediaFramePath', framePath);
  app.register(trackerModule, {
    tracker: {
      createTask: async (body) => { created.push(body); return { id: 4242 }; },
    },
  });
  await app.ready();
  t.after(() => app.close());
  return { app, created };
}

test('кадр уезжает на портал ИМЕНЕМ: путь подставляет сервер, а не браузер', async (t) => {
  const { app, created } = await buildTaskApp(t, {
    framePath: (name) => (name === `${RUN}/p0-00272s.jpg` ? '/media/meeting-frames/готовый.jpg' : null),
  });

  const res = await app.inject({
    method: 'POST',
    url: '/api/tracker/tasks',
    payload: {
      title: 'Время забора',
      // Произвольный путь в теле — это «залей на портал что скажу»: ручка грузит файлы
      // наружу, поэтому путь она не принимает вовсе.
      frames: [`${RUN}/p0-00272s.jpg`, '/etc/passwd', '../../secret.jpg'],
    },
  });
  assert.equal(res.statusCode, 200);
  // Имя вложения человеческое: служебное `p0-00272s.jpg` читалось бы на портале мусором.
  assert.deepEqual(created[0].images, [{ path: '/media/meeting-frames/готовый.jpg', name: 'запись.jpg' }]);
  assert.equal('frames' in created[0], false, 'сырое поле до клиента портала не доходит');
});

test('пропавший кадр не отменяет постановку задачи', async (t) => {
  // Истёк TTL или начат новый разбор: описание с таймкодом на месте, и терять из-за
  // картинки уже готовую постановку незачем.
  const { app, created } = await buildTaskApp(t, { framePath: () => null });
  const res = await app.inject({
    method: 'POST',
    url: '/api/tracker/tasks',
    payload: { title: 'Время забора', frames: [`${RUN}/p0-00272s.jpg`] },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(created[0].images, undefined);
  assert.equal(created[0].title, 'Время забора');
});
