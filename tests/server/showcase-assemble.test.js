// Сборка ролика на настоящих медиа-фикстурах.
//
// Проверяется приёмка первого прохода: три независимые сцены дают воспроизводимый
// mp4 объявленного формата, субтитры идут по общему таймлайну, а результат прошлой
// редакции не встаёт на место актуального.
//
// Браузер здесь не нужен: клипы сцен подкладываются готовыми — предмет проверки
// сборка, а не запись.
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { createShowcaseService } from '../../server/src/lib/showcase/service.ts';
import { publishArtifact } from '../../server/src/lib/showcase/artifacts.ts';

const run = promisify(execFile);

const TARGET_CONTRACT = {
  version: 1,
  environment: 'read-only',
  project: { record: 'http://127.0.0.1:5173', view: 'http://127.0.0.1:5173' },
  sandbox: null,
  allowedOrigins: [],
  capabilities: ['record'],
};

const SCREENS_CONTRACT = {
  version: 1,
  screens: [
    {
      id: 'overview',
      title: 'Обзор',
      path: '/',
      readySelector: '#ready',
      elements: [{ id: 'run', selector: '#run' }],
    },
  ],
};

const SCENES = [
  { title: 'Первая', narration: 'Открываем обзор.', seconds: 1.5, color: 'navy' },
  { title: 'Вторая', narration: 'Смотрим список задач.', seconds: 2.0, color: 'darkgreen' },
  { title: 'Третья', narration: 'Скачиваем готовый ролик.', seconds: 1.2, color: 'maroon' },
];

async function makeClip(file, seconds, color) {
  await run('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `color=${color}:s=1280x720:d=${seconds}:r=25`,
    '-f', 'lavfi', '-i', `sine=frequency=200:duration=${seconds}`,
    '-map', '0:v', '-shortest',
    '-c:v', 'libvpx', '-b:v', '200k',
    file,
  ]);

  return file;
}

async function makeWav(file, seconds) {
  await run('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `sine=frequency=330:duration=${seconds}:sample_rate=48000`,
    '-c:a', 'pcm_s16le', '-ac', '1',
    file,
  ]);

  return file;
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'showcase-assemble-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  const contractDir = path.join(root, 'profiles', 'demo-profile', 'showcase');

  await mkdir(contractDir, { recursive: true });
  await mkdir(path.join(root, 'state'), { recursive: true });
  await writeFile(path.join(contractDir, 'target.json'), JSON.stringify(TARGET_CONTRACT), 'utf8');
  await writeFile(path.join(contractDir, 'screens.json'), JSON.stringify(SCREENS_CONTRACT), 'utf8');

  const events = [];
  const service = createShowcaseService({
    showcaseDir: path.join(root, 'showcase'),
    authDir: path.join(root, 'auth'),
    profilesDir: path.join(root, 'profiles'),
    stateDir: path.join(root, 'state'),
    browserPath: null,
    listProjects: async () => ['demo-profile'],
    broadcast: (name, data) => events.push([name, data]),
    limits: () => ({
      maxScenes: 20,
      maxSceneSeconds: 120,
      maxTotalSeconds: 600,
      retentionDays: 30,
      maxQueued: 4,
      jobTimeoutMs: 10 * 60_000,
    }),
  });

  await service.recover();

  return { service, root, events };
}

/**
 * Готовит ролик из трёх сцен с подложенными клипами и звуком. Артефакты
 * публикуются тем же путём, каким их публикует задание записи, поэтому хеши
 * входов настоящие: подделанные пропустили бы мимо проверку свежести.
 */
async function projectWithScenes(service, root) {
  let project = await service.createProject({
    ref: { kind: 'project', id: 'demo-profile' },
    profile: 'demo-profile',
    title: 'Ролик приёмки',
  });

  assert.equal(project.target.status, 'ready');

  for (const draft of SCENES) {
    project = await service.addScene(project.id, project.revision, {
      title: draft.title,
      screenId: 'overview',
      narration: draft.narration,
      caption: draft.title,
      subtitleText: draft.narration,
      startState: null,
      readyCondition: null,
      actions: [{ kind: 'wait', ms: 500 }],
    });
  }

  const workDir = path.join(root, 'work');

  await mkdir(workDir, { recursive: true });

  for (const [index, scene] of project.scenes.entries()) {
    const source = SCENES[index];
    const wav = await makeWav(path.join(workDir, `${scene.id}.wav`), source.seconds);

    project = await service.importSceneAudio(project.id, project.revision, scene.id, wav);
  }

  // Клип подкладывается напрямую: предмет проверки — сборка, а запись браузером
  // проверяется отдельно и требует установленного браузера.
  const names = service.store.namesOf(project.id);
  const inputs = service.withFreshness(project);

  for (const [index, scene] of inputs.scenes.entries()) {
    const source = SCENES[index];
    const clip = await makeClip(
      path.join(workDir, `${scene.id}.webm`),
      source.seconds + 0.5,
      source.color,
    );
    const { clipInputHash } = await import('../../server/src/lib/showcase/artifacts.ts');
    const artifact = await publishArtifact({
      file: clip,
      kind: 'clip',
      inputHash: clipInputHash(scene, {
        targetFingerprint: project.target.scope.targetFingerprint,
        policyRevision: project.target.scope.policyRevision,
        dataRevision: project.target.scope.dataRevision,
        style: {
          width: 1920,
          height: 1080,
          fps: 30,
          theme: 'dark',
          locale: 'ru-RU',
          burnSubtitles: false,
        },
        versions: { recorder: 'recorder-1', voice: 'imported-1', assembler: 'assembler-1' },
      }),
      producerVersion: 'recorder-1',
      durationMs: Math.round((source.seconds + 0.5) * 1000),
      targetDir: path.join(names.scenesDir, scene.id, 'artifacts'),
    });

    await service.store.updateProject(project.id, null, (current) => ({
      ...current,
      scenes: current.scenes.map((item) => (item.id === scene.id ? { ...item, clip: artifact } : item)),
    }));
  }

  return service.readProject(project.id);
}

async function waitForJob(service, jobId, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const job = service.jobs.read(jobId);

    if (job.state !== 'queued' && job.state !== 'running') {
      return job;
    }

    await new Promise((resolve) => { setTimeout(resolve, 200); });
  }

  throw new Error('задание не завершилось за отведённое время');
}

test('три независимые сцены собираются в воспроизводимый ролик', async (t) => {
  const { service, root } = await fixture(t);
  const project = await projectWithScenes(service, root);

  assert.equal(project.scenes.length, 3);
  assert.deepEqual(project.scenes.map((scene) => scene.stale), [false, false, false]);

  const job = await service.assemble(project.id);
  const finished = await waitForJob(service, job.id);

  assert.equal(finished.state, 'succeeded', finished.error ?? '');

  const built = await service.readProject(project.id);

  assert.ok(built.latestFinal, 'итог обязан появиться в записи ролика');
  assert.equal(built.latestFinal.current, true);

  const names = service.store.namesOf(project.id);
  const file = path.join(names.finalsDir, `${built.latestFinal.video.id}.mp4`);
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'stream=codec_name,codec_type,width,height,avg_frame_rate:format=duration',
    '-of', 'json',
    file,
  ]);
  const probed = JSON.parse(stdout);
  const video = probed.streams.find((stream) => stream.codec_type === 'video');
  const audio = probed.streams.find((stream) => stream.codec_type === 'audio');

  assert.equal(video.codec_name, 'h264');
  assert.equal(video.width, 1920);
  assert.equal(video.height, 1080);
  assert.equal(video.avg_frame_rate, '30/1');
  assert.equal(audio.codec_name, 'aac');
  assert.ok(Number(probed.format.duration) > 5, 'ролик из трёх сцен короче пяти секунд не бывает');
});

test('субтитры идут по общему таймлайну и не выходят за ролик', async (t) => {
  const { service, root } = await fixture(t);
  const project = await projectWithScenes(service, root);
  const job = await service.assemble(project.id);

  await waitForJob(service, job.id);

  const built = await service.readProject(project.id);
  const names = service.store.namesOf(built.id);
  const srt = await readFile(
    path.join(names.finalsDir, `${built.latestFinal.subtitles.id}.srt`),
    'utf8',
  );
  const times = [...srt.matchAll(/(\d\d):(\d\d):(\d\d),(\d\d\d) --> (\d\d):(\d\d):(\d\d),(\d\d\d)/g)];

  assert.equal(times.length, 3, 'по реплике на сцену');

  const toMs = (parts, offset) => (
    Number(parts[offset]) * 3_600_000
    + Number(parts[offset + 1]) * 60_000
    + Number(parts[offset + 2]) * 1000
    + Number(parts[offset + 3])
  );
  const cues = times.map((parts) => ({
    start: toMs(parts, 1),
    end: toMs(parts, 5),
  }));

  for (const cue of cues) {
    assert.ok(cue.end > cue.start, 'реплика не может кончаться раньше, чем начинается');
  }

  for (let index = 1; index < cues.length; index += 1) {
    assert.ok(
      cues[index].start >= cues[index - 1].end,
      'реплики соседних сцен не пересекаются',
    );
  }

  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    path.join(names.finalsDir, `${built.latestFinal.video.id}.mp4`),
  ]);

  assert.ok(
    cues[cues.length - 1].end <= Number(stdout.trim()) * 1000,
    'последняя реплика не должна выходить за конец ролика',
  );
});

test('правка субтитра делает собранный ролик предыдущим, не удаляя его', async (t) => {
  const { service, root } = await fixture(t);
  const project = await projectWithScenes(service, root);
  const job = await service.assemble(project.id);

  await waitForJob(service, job.id);

  const built = await service.readProject(project.id);
  const edited = await service.updateScene(built.id, built.revision, built.scenes[1].id, {
    subtitleText: 'Другой письменный текст второй сцены.',
  });

  assert.equal(edited.latestFinal.current, false, 'итог больше не актуален');
  assert.equal(edited.scenes[0].stale, false, 'первая сцена не тронута');
  assert.equal(edited.scenes[1].stale, false, 'субтитр не заставляет переснимать сцену');
  assert.equal(edited.scenes[2].stale, false, 'третья сцена не тронута');
  assert.equal(
    edited.latestFinal.video.id,
    built.latestFinal.video.id,
    'старый файл остаётся на месте: его можно посмотреть как предыдущую сборку',
  );
});

// У сцены с ЗАГРУЖЕННЫМ звуком правка произносимого текста ничего не старит: этот
// звук не переозвучивается, и делать вид, что ролик устарел, было бы неправдой —
// человек и так слышит в нём ровно то, что записал.
test('правка текста при загруженном звуке не старит ни сцену, ни ролик', async (t) => {
  const { service, root } = await fixture(t);
  const project = await projectWithScenes(service, root);
  const job = await service.assemble(project.id);

  await waitForJob(service, job.id);

  const built = await service.readProject(project.id);
  const edited = await service.updateScene(built.id, built.revision, built.scenes[1].id, {
    narration: 'Совсем другая фраза во второй сцене.',
  });

  assert.equal(edited.scenes[1].stale, false);
  assert.equal(edited.latestFinal.current, true);
});

test('сборка отказывается работать с устаревшей сценой', async (t) => {
  const { service, root } = await fixture(t);
  const project = await projectWithScenes(service, root);
  const edited = await service.updateScene(project.id, project.revision, project.scenes[0].id, {
    actions: [{ kind: 'scroll', targetId: null, delta: 400 }],
  });

  assert.equal(edited.scenes[0].stale, true);

  await assert.rejects(
    () => service.assemble(edited.id),
    (error) => error.code === 'scene_not_ready' && /устарел|не записана/.test(error.message),
  );
});

test('повтор сборки с теми же входами возвращает то же задание', async (t) => {
  const { service, root } = await fixture(t);
  const project = await projectWithScenes(service, root);
  const first = await service.assemble(project.id);
  const second = await service.assemble(project.id);

  assert.equal(second.id, first.id, 'двойной клик не заводит вторую сборку');

  await waitForJob(service, first.id);
});
