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
import { PRODUCER_VERSIONS } from '../../server/src/lib/showcase/formats.ts';
import { publishRecordingTiming } from '../../server/src/lib/showcase/recordingOps.ts';
import { createSyncBindings, syncTextHash } from '../../server/src/lib/showcase/scenes.ts';
import {
  publishSpeechAlignment,
  publishSpeechTiming,
  readFinalManifest,
} from '../../server/src/lib/showcase/syncStore.ts';
import { alignSpeechTiming } from '../../server/src/lib/showcase/voice/alignment.ts';

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

// Фикстуре нужен валидный VP8-контейнер, а не качество картинки. Без этих ключей libvpx
// разворачивается на все ядра и один тест занимает машину целиком, а параллельные прогоны
// в соседних worktree складывают нагрузку и вешают её.
async function makeClip(file, seconds, color) {
  await run('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `color=${color}:s=1280x720:d=${seconds}:r=25`,
    '-f', 'lavfi', '-i', `sine=frequency=200:duration=${seconds}`,
    '-map', '0:v', '-shortest',
    '-c:v', 'libvpx', '-b:v', '200k',
    '-threads', '1', '-deadline', 'realtime', '-cpu-used', '8',
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

async function makeCfrClip(file, seconds, color = 'navy') {
  await run('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `color=${color}:s=1920x1080:d=${seconds}:r=30`,
    '-an', '-c:v', 'libvpx', '-b:v', '300k',
    '-threads', '1', '-deadline', 'realtime', '-cpu-used', '8',
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
        // Версии те же, что у сервиса: подложенный клип должен считаться свежим
        // ровно по тем правилам, по которым его проверит сборка.
        versions: PRODUCER_VERSIONS,
      }),
      producerVersion: PRODUCER_VERSIONS.recorder,
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

async function projectWithExactScene(service, root) {
  let project = await service.createProject({
    ref: { kind: 'project', id: 'demo-profile' },
    profile: 'demo-profile',
    title: 'Точная сборка',
  });

  project = await service.addScene(project.id, project.revision, {
    title: 'Кнопка',
    screenId: 'overview',
    narration: 'Нажимаем кнопку.',
    caption: 'Кнопка',
    subtitleText: 'Нажимаем кнопку.',
    startState: null,
    readyCondition: null,
    actions: [{ kind: 'click', targetId: 'run' }],
  });

  const workDir = path.join(root, 'exact-work');

  await mkdir(workDir, { recursive: true });
  project = await service.importSceneAudio(
    project.id,
    project.revision,
    project.scenes[0].id,
    await makeWav(path.join(workDir, 'speech.wav'), 1),
  );

  const scene = project.scenes[0];
  const names = service.store.namesOf(project.id);
  const targetDir = path.join(names.scenesDir, scene.id, 'artifacts');
  const { clipInputHash } = await import('../../server/src/lib/showcase/artifacts.ts');
  const clip = await publishArtifact({
    file: await makeCfrClip(path.join(workDir, 'clip.webm'), 3),
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
      versions: PRODUCER_VERSIONS,
    }),
    producerVersion: PRODUCER_VERSIONS.recorder,
    durationMs: 3_000,
    targetDir,
  });
  const raw = {
    source: 'whisper',
    words: [
      { text: 'Нажимаем', startMs: 100, endMs: 450 },
      { text: 'кнопку', startMs: 550, endMs: 900 },
    ],
    segments: [{ text: 'Нажимаем кнопку', startMs: 100, endMs: 900 }],
  };
  const speechTiming = await publishSpeechTiming({
    timing: raw,
    sceneInputHash: scene.audio.inputHash,
    audioContentHash: scene.audio.contentHash,
    producerVersion: 'fixture-whisper-1',
    durationMs: 1_000,
    targetDir,
  });

  assert.ok(speechTiming);

  const canonicalText = 'Нажимаем кнопку.';
  const speechAlignment = await publishSpeechAlignment({
    alignment: alignSpeechTiming({ canonicalText, durationMs: 1_000, timing: raw }),
    canonicalText,
    textHash: syncTextHash(canonicalText),
    audioContentHash: scene.audio.contentHash,
    speechTimingContentHash: speechTiming.contentHash,
    targetDir,
  });
  const recordingTiming = await publishRecordingTiming({
    timing: {
      status: 'calibrated',
      durationMs: 3_000,
      sceneReadyMs: 0,
      calibration: {
        method: 'visual-marker-affine-v1',
        errorMs: 20,
        startErrorMs: 15,
        endErrorMs: 20,
        rate: 1,
      },
      actions: [{
        actionIndex: 0,
        kind: 'click',
        startMs: 1_000,
        anchorMs: 1_100,
        endMs: 1_200,
        readyMs: null,
        geometry: null,
      }],
      stableIntervals: [
        {
          id: 'before-click',
          fromMs: 0,
          toMs: 1_000,
          frameMs: 900,
          afterActionIndex: null,
          beforeActionIndex: 0,
        },
        {
          id: 'after-click',
          fromMs: 1_200,
          toMs: 3_000,
          frameMs: 2_900,
          afterActionIndex: 0,
          beforeActionIndex: null,
        },
      ],
      removableWaits: [],
      highlights: [],
    },
    sceneInputHash: clip.inputHash,
    clipContentHash: clip.contentHash,
    actions: scene.actions,
    targetDir,
  });

  assert.ok(speechAlignment);
  assert.ok(recordingTiming);

  const syncBindings = createSyncBindings(scene.narration, scene.actions, [{
    actionIndex: 0,
    from: 0,
    to: 'Нажимаем'.length,
    kind: 'align-start',
    origin: 'manual',
  }]);

  await service.store.updateProject(project.id, null, (current) => ({
    ...current,
    scenes: current.scenes.map((item) => (item.id === scene.id
      ? {
        ...item,
        clip,
        speechTiming,
        speechAlignment,
        recordingTiming,
        syncBindings,
      }
      : item)),
  }));

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

test('production adapter публикует exact manifest из реальных sidecar', async (t) => {
  const { service, root } = await fixture(t);
  const project = await projectWithExactScene(service, root);
  const started = await service.assemble(project.id);
  const finished = await waitForJob(service, started.id);

  assert.equal(finished.state, 'succeeded', finished.error ?? '');

  const built = await service.readProject(project.id);

  assert.equal(built.latestFinal.manifestVersion, 1);

  const manifest = await readFinalManifest({
    manifestId: built.latestFinal.manifestId,
    targetDir: service.store.namesOf(project.id).finalsDir,
    projectId: project.id,
  });

  assert.ok(manifest);
  assert.deepEqual(
    await service.finalManifest(project.id, built.latestFinal.manifestId),
    manifest,
  );
  assert.equal(manifest.mode, 'exact');
  assert.equal(manifest.scenes[0].mode, 'exact');
  assert.equal(manifest.scenes[0].quality, 'word-exact');
  assert.equal(manifest.scenes[0].cues.length, 1);
  assert.ok(manifest.scenes[0].cues[0].errorMs <= 250);
  assert.equal(manifest.subtitleCues.length, 1);
  assert.equal(manifest.subtitleCues[0].text, 'Нажимаем кнопку.');
});

test('битый существующий журнал останавливает сборку для проверки', async (t) => {
  const { service, root } = await fixture(t);
  const project = await projectWithExactScene(service, root);
  const scene = project.scenes[0];
  const targetDir = path.join(service.store.namesOf(project.id).scenesDir, scene.id, 'artifacts');

  await writeFile(path.join(targetDir, `${scene.recordingTiming.id}.json`), '{}\n', 'utf8');

  const started = await service.assemble(project.id);
  const finished = await waitForJob(service, started.id);

  assert.equal(finished.state, 'awaiting_review');
  assert.match(finished.error, /Журнал записи повреждён/);
  assert.equal((await service.readProject(project.id)).latestFinal, null);
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

// У сцены с ЗАГРУЖЕННЫМ звуком правка текста не старит WAV/клип, но обязана
// пересчитать alignment, привязки и итог: прежний manifest относится к другой
// канонической строке и не может оставаться текущим.
test('правка текста при загруженном звуке сохраняет сцену, но старит ролик', async (t) => {
  const { service, root } = await fixture(t);
  const project = await projectWithScenes(service, root);
  const job = await service.assemble(project.id);

  await waitForJob(service, job.id);

  const built = await service.readProject(project.id);
  const edited = await service.updateScene(built.id, built.revision, built.scenes[1].id, {
    narration: 'Совсем другая фраза во второй сцене.',
  });

  assert.equal(edited.scenes[1].stale, false);
  assert.equal(edited.latestFinal.current, false);
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
