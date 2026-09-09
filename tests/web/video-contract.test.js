import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MediaContractError,
  parseMediaClip,
  parseMediaDoctor,
  parseMediaJob,
  parseMediaPlan,
  parseMediaUpload,
} from '../../shared/mediaContracts.ts';
import { api } from '../../web/src/shared/api-client.js';
import { mediaApi } from '../../web/src/shared/mediaApi.ts';

const segments = [
  { start: 10, end: 12.5, text: 'Первая реплика.' },
  { start: 13, end: 15, text: 'Вторая реплика.' },
];
const job = {
  status: 'done',
  progress: null,
  error: null,
  result: { duration: 78.89, transcript: { segments } },
};
const frame = { name: 'a1b2c3/p0-00272s.jpg', at: 272 };
const clip = {
  name: 'a1b2c3/p0-00256-030s.mp4', at: 271, from: 256, to: 286, bytes: 383371,
};
const planTask = {
  title: 'Время забора',
  description: 'Добавить в комментарий.',
  confidence: 0.9,
  reason: 'прямая просьба',
  at: 271,
  frame,
};
const plan = {
  model: 'claude/claude-opus-5', truncated: false, count: 42, tasks: [planTask],
};
const contracts = [
  [parseMediaJob, job],
  [parseMediaUpload, { jobId: 'job-1' }],
  [parseMediaDoctor, { ok: true, storage: { files: 3, bytes: 1024, ttlMs: 604800000 } }],
  [parseMediaPlan, plan],
  [parseMediaClip, { clip }],
];

test('контракты раздела «Видео» принимают ответ сервера и отбрасывают лишнее', () => {
  for (const [parse, payload] of contracts) {
    assert.deepEqual(parse({ ...payload, ignored: 'лишнее поле' }), payload);
    for (const invalid of [null, [], 'text', 12, false, {}]) {
      assert.throws(() => parse(invalid), MediaContractError);
    }
  }
  // Пустые состояния законны: разбор идёт, задач не нашлось, куска записи нет.
  const running = { status: 'running', progress: { done: 4, total: 78 }, result: null, error: null };

  assert.deepEqual(parseMediaJob(running).result, null);
  assert.deepEqual(parseMediaClip({ clip: null }).clip, null);
  assert.deepEqual(parseMediaDoctor({ ok: false, storage: null }).storage, null);
});

test('пути машины в контракте раздела не объявлены и через него не проходят', () => {
  const projected = parseMediaJob({ ...job, filePath: '/srv/record.mp4', workDir: '/tmp/job-1' });

  assert.deepEqual(Object.keys(projected).sort(), ['error', 'progress', 'result', 'status']);
  const segment = projected.result.transcript.segments[0];

  assert.deepEqual(Object.keys(segment).sort(), ['end', 'start', 'text']);
});

test('повреждённый ответ отклоняется целиком, а путь поля назван', () => {
  assert.throws(() => parseMediaJob({ ...job, status: 'queued' }), /job\.status/);
  const halfSegment = { duration: 1, transcript: { segments: [{ start: 1, text: 'x' }] } };

  assert.throws(
    () => parseMediaJob({ ...job, result: halfSegment }),
    /job\.result\.transcript\.segments\[0\]\.end/,
  );
  assert.throws(() => parseMediaPlan({ ...plan, tasks: [{ ...planTask, confidence: 'высокая' }] }),
    /plan\.tasks\[0\]\.confidence/);
  assert.throws(() => parseMediaPlan({ ...plan, tasks: [{ ...planTask, frame: { name: 'a.jpg' } }] }),
    /plan\.tasks\[0\]\.frame\.at/);
  assert.throws(() => parseMediaClip({ clip: { ...clip, bytes: -1 } }), /clip\.clip\.bytes/);
});

test('адаптер кодирует id разбора и подтверждает форму каждого ответа', async (t) => {
  const seen = [];
  t.mock.method(api, 'get', async (url) => {
    seen.push(['GET', url]);
    return url.includes('doctor') ? { ok: true, storage: null } : job;
  });
  t.mock.method(api, 'post', async (url, body) => {
    seen.push(['POST', url, body]);
    return url.endsWith('/clip') ? { clip } : plan;
  });

  await mediaApi.doctor();
  await mediaApi.job('job 1/2');
  await mediaApi.planTasks({ jobIds: ['job-1'], hint: 'про сроки' });
  await mediaApi.clip({ jobIds: ['job-1'], at: 271, window: 15 });

  assert.deepEqual(seen, [
    ['GET', '/api/media/doctor'],
    ['GET', `/api/media/ingest/${encodeURIComponent('job 1/2')}`],
    ['POST', '/api/media/plan-tasks', { jobIds: ['job-1'], hint: 'про сроки' }],
    ['POST', '/api/media/clip', { jobIds: ['job-1'], at: 271, window: 15 }],
  ]);
});

test('повреждённый ответ сети не становится состоянием разбора', async (t) => {
  t.mock.method(api, 'get', async () => ({ ...job, status: 'unknown' }));
  t.mock.method(api, 'post', async () => ({ ...plan, tasks: [{ ...planTask, at: 'позже' }] }));

  await assert.rejects(mediaApi.job('job-1'), MediaContractError);
  await assert.rejects(mediaApi.planTasks({ jobIds: ['job-1'], hint: '' }), MediaContractError);
});
