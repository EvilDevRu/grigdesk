// Озвучка сцены установленным локальным голосом — весь продуктовый путь.
//
// Это единственная проверка, где звук производит настоящий движок: остальные
// работают с подменённым. Без установленного голоса тест честно пропускается —
// отсутствие движка не должно выглядеть как пройденная приёмка.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPiperEngine } from '../../server/src/lib/showcase/voice/piper.ts';
import { voiceRuntimePaths } from '../../server/src/lib/showcase/voice/install.ts';
import { createShowcaseService } from '../../server/src/lib/showcase/service.ts';

const SCREENS = {
  version: 1,
  screens: [
    {
      id: 'overview',
      title: 'Обзор',
      path: '/',
      readySelector: '[data-testid="ready"]',
      elements: [],
    },
  ],
};

/**
 * Каталог установленного голоса. Считается от корня репозитория: прогон запускает
 * тесты из каталога пакета, и путь по рабочему каталогу указывал бы мимо — тест
 * молча пропускался бы при установленном голосе.
 */
function voiceDirOf() {
  return process.env.COCKPIT_SHOWCASE_VOICE_DIR || path.join(
    fileURLToPath(new URL('../..', import.meta.url)),
    'server',
    '.state',
    'showcase-voice',
  );
}

async function fixture(t, voiceDir) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'showcase-live-voice-'));
  let service = null;

  t.after(async () => {
    await service?.disable().catch(() => null);
    await rm(root, { recursive: true, force: true });
  });

  const contractDir = path.join(root, 'profiles', 'demo-profile', 'showcase');

  await mkdir(contractDir, { recursive: true });
  await mkdir(path.join(root, 'state'), { recursive: true });
  await writeFile(
    path.join(contractDir, 'target.json'),
    JSON.stringify({
      version: 1,
      environment: 'read-only',
      project: { record: 'http://127.0.0.1:9', view: 'http://127.0.0.1:9' },
      sandbox: null,
      allowedOrigins: [],
      capabilities: ['record'],
    }),
    'utf8',
  );
  await writeFile(path.join(contractDir, 'screens.json'), JSON.stringify(SCREENS), 'utf8');

  service = createShowcaseService({
    showcaseDir: path.join(root, 'showcase'),
    authDir: path.join(root, 'auth'),
    profilesDir: path.join(root, 'profiles'),
    stateDir: path.join(root, 'state'),
    browserPath: null,
    voiceDir,
    listProjects: async () => ['demo-profile'],
    broadcast: () => {},
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

  return service;
}

async function waitForJob(service, jobId, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const job = service.jobs.read(jobId);

    if (job.state !== 'queued' && job.state !== 'running') {
      return job;
    }

    await new Promise((resolve) => { setTimeout(resolve, 250); });
  }

  throw new Error('озвучка не завершилась за отведённое время');
}

test('установленный кнопкой голос озвучивает сцену через службу раздела', async (t) => {
  const voiceDir = voiceDirOf();
  const engine = createPiperEngine(voiceRuntimePaths(voiceDir));
  const doctor = await engine.doctor();

  if (doctor.status !== 'ready') {
    t.skip(`локальный голос не установлен: ${doctor.reason}`);

    return;
  }

  const piperVoice = (await engine.voices()).find((voice) => voice.available);

  assert.ok(piperVoice, 'готовый Piper обязан объявить доступный голос');

  const service = await fixture(t, voiceDir);
  const catalog = await service.voiceCatalog();
  const ready = catalog.engines.find((item) => item.doctor.status === 'ready');

  assert.ok(ready, 'установленный голос обязан быть виден в каталоге раздела');
  assert.ok(catalog.install.installed.length > 0, 'установленное перечислено отдельно');

  let project = await service.createProject({
    ref: { kind: 'project', id: 'demo-profile' },
    profile: 'demo-profile',
    title: 'Живая озвучка',
  });

  project = await service.addScene(project.id, project.revision, {
    title: 'Обзор',
    screenId: 'overview',
    narration: 'Раздел собирает ролик из сцен и складывает их в один файл.',
    caption: 'Обзор',
    subtitleText: 'Раздел собирает ролик из сцен.',
    startState: null,
    readyCondition: null,
    actions: [],
  });

  // Тест проверяет именно Piper. Голос по умолчанию выбирать нельзя: если рядом
  // установлен Qwen, registry ставит его раньше и «лёгкая» live-проверка грузит
  // многогигабайтную модель во время общего suite.
  project = await service.setVoice(project.id, project.revision, {
    voiceRef: `piper:${piperVoice.id}`,
    pace: null,
  });

  const job = await service.synthesizeScenes(project.id);
  const finished = await waitForJob(service, job.id);

  assert.equal(finished.state, 'succeeded', finished.error ?? '');

  const voiced = await service.readProject(project.id);
  const [scene] = voiced.scenes;

  assert.ok(scene.audio, 'у сцены обязан появиться звук');
  assert.ok(scene.audio.byteSize > 20_000, 'настоящая речь весит больше пустышки');
  assert.ok(
    (scene.audio.durationMs ?? 0) > 2000,
    'фраза из десятка слов короче двух секунд не звучит',
  );

  // Проверка речи без распознавания не притворяется пройденной: раздел обязан
  // сказать «пропущено», а не покрасить место в зелёный.
  const speech = scene.checks.find((check) => check.kind === 'speech');

  assert.ok(speech, 'проверка речи обязана появиться у озвученной сцены');
  assert.equal(speech.status, 'skipped');
});
