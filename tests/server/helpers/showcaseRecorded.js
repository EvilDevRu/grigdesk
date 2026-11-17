// Служебный fixture принятой записи: настоящие файлы, хеши, proof и журналы.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { createFakeShowcaseVoice } from './showcaseVoice.js';
import { createShowcaseService } from '../../../server/src/lib/showcase/service.ts';
import { createRecordingOps, publishRecordingTiming } from '../../../server/src/lib/showcase/recordingOps.ts';
import {
  audioInputHash,
  clipInputHash,
  publishArtifact,
} from '../../../server/src/lib/showcase/artifacts.ts';
import { PRODUCER_VERSIONS, RENDER_STYLE } from '../../../server/src/lib/showcase/formats.ts';
import {
  briefHashOf, scriptHashOf, SCRIPT_VERIFICATION_VERSION, writeScriptProof,
} from '../../../server/src/lib/showcase/script/verification.ts';

const run = promisify(execFile);

/**
 * Формула повторяет входной контракт службы с proof и словарём, без подмены хешей.
 * Готовая цель содержит отпечатки именно той записи, которую принимает publish.
 */
export function recordedInputs(project) {
  const scope = project.target?.status === 'ready' ? project.target.scope : null;

  return {
    targetFingerprint: scope?.targetFingerprint ?? '',
    policyRevision: scope?.policyRevision ?? '',
    dataRevision: scope?.dataRevision ?? '',
    scriptProofHash: project.scriptProofHash ?? undefined,
    style: RENDER_STYLE,
    versions: PRODUCER_VERSIONS,
    stressDictionary: [],
  };
}

/**
 * Проход службы завершается по фактическому состоянию журнала, без угадывания пауз.
 * Таймаут не оставляет вечный тест при регрессии фонового координатора.
 */
export async function settleBuild(service, id) {
  const deadline = Date.now() + 30000;

  while (Date.now() < deadline) {
    await service.pollWorkers();

    const run = service.readBuild(id);

    if (['succeeded', 'failed', 'cancelled', 'interrupted', 'awaiting_review'].includes(run.state)) {
      return run;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.fail('Сборка не завершилась за 30 секунд.');
}

/**
 * Временный sandbox подтверждён доверенным реестром и изменяемым обзором службы.
 * Клипы и звук настоящие, модель/voice изолированы; Chromium для публикации не нужен.
 */
export async function recordedFixture(t, { count = 1, clips = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'showcase-recorded-'));
  const profileDir = path.join(root, 'profiles', 'demo-profile', 'showcase');
  const stateDir = path.join(root, 'state');

  await mkdir(profileDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(profileDir, 'target.json'), JSON.stringify({
    version: 1,
    environment: 'read-only',
    project: null,
    sandbox: { recordTemplate: 'http://127.0.0.1:{fePort}', viewTemplate: null },
    allowedOrigins: [],
    capabilities: ['record'],
  }));
  await writeFile(path.join(profileDir, 'screens.json'), JSON.stringify({
    version: 1, screens: [{
      id: 'overview',
      title: 'Обзор',
      path: '/',
      readySelector: 'body',
      elements: [],
    }],
  }));

  const registry = path.join(stateDir, 't4920.env');

  await writeFile(registry, 'TASK=4920\nSB_K=1\nFE_PORT=5173\nAPI_PORT=8173\n'
    + 'WORKSPACE_MODE=isolated\nSTAND_OWNERSHIP=task\nREPO_COUNT=0\n');

  const sandbox = {
    task: '4920',
    profile: 'demo-profile',
    profileBinding: 'verified',
    owner: 'manual',
    slot: 1,
    fePort: 5173,
    apiPort: 8173,
    repos: [],
    standAlive: true,
    feAlive: true,
    removable: true,
    removableReason: null,
    updatedAt: new Date((await stat(registry)).mtimeMs).toISOString(),
  };
  let alive = true;
  const voice = await createFakeShowcaseVoice(root, { ready: ['piper', 'silero'] });
  const options = {
    ...voice,
    showcaseDir: path.join(root, 'showcase'),
    authDir: path.join(root, 'auth'),
    profilesDir: path.join(root, 'profiles'),
    stateDir,
    browserPath: null,
    listProjects: async () => ['demo-profile'],
    sandboxOverview: async () => ({ sandboxes: alive ? [sandbox] : [] }),
    broadcast: () => { },
    limits: () => ({
      maxScenes: 20,
      maxSceneSeconds: 120,
      maxTotalSeconds: 600,
      retentionDays: 30,
      maxQueued: 4,
      jobTimeoutMs: 60000,
    }),
    resolveScriptModel: async () => ({
      ok: true,
      ref: { provider: 'fixture', model: 'fixture' },
      executor: {
        runUntrusted: async ({ message }) => ({
          reply: JSON.stringify({
            scenes: current.scenes.map((scene) => message.includes('"bindings"')
              ? { sceneId: scene.id, bindings: [] }
              : {
                sceneId: scene.id,
                narration: 'Новое описание обзора.',
                subtitleText: 'Новое описание.',
              }),
          })
        })
      },
    }),
  };
  let service = createShowcaseService(options);
  let current;

  t.after(async () => {
    await service.disable();
    await rm(root, { recursive: true, force: true });
  });
  await service.recover();
  current = await service.createProject({ ref: { kind: 'sandbox', id: sandbox.task } });

  for (let index = 0; index < count; index += 1) {
    current = await service.addScene(current.id, current.revision, {
      title: `Обзор ${index + 1}`,
      screenId: 'overview',
      narration: 'Показываем обзор.',
      caption: 'Обзор',
      subtitleText: 'Показываем обзор.',
      actions: [],
      startState: null,
      readyCondition: null,
    });
  }

  current = await service.store.updateProject(current.id, current.revision, (project) => ({
    ...project,
    voiceRef: 'piper:irina',
    brief: ['Показать обзор'],
    scenes: project.scenes.map((scene) => ({
      ...scene, audioSource: { ...scene.audioSource, voiceRef: 'piper:irina' },
    })),
  }));

  const clipFile = path.join(root, 'clip.webm');

  await run('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'color=navy:s=1920x1080:d=3:r=30', '-an', '-c:v', 'libvpx', '-b:v', '200k',
    '-threads', '1', '-deadline', 'realtime', '-cpu-used', '8', clipFile,
  ]);

  const timing = {
    status: 'calibrated',
    durationMs: 3000,
    sceneReadyMs: 0,
    calibration: {
      method: 'visual-marker-affine-v1',
      errorMs: 20,
      startErrorMs: 20,
      endErrorMs: 20,
      rate: 1,
    },
    actions: [],
    stableIntervals: [{
      id: 'stable',
      fromMs: 0,
      toMs: 3000,
      frameMs: 1500,
      afterActionIndex: null,
      beforeActionIndex: null,
    }],
    removableWaits: [],
    highlights: [],
  };

  /**
   * Proof соответствует живой области, снимок цели в store намеренно не трогаем.
   * Обновлять policy/data принятой записи вправе только publishRecording.
   */
  async function prove() {
    const live = await service.readProject(current.id);
    const scope = live.target.scope;
    const hash = await writeScriptProof(service.store.namesOf(current.id).dir, {
      version: SCRIPT_VERIFICATION_VERSION,
      targetFingerprint: scope.targetFingerprint,
      policyRevision: scope.policyRevision,
      dataRevision: scope.dataRevision,
      briefHash: briefHashOf(live.brief),
      scriptHash: scriptHashOf(live.scenes),
      rehearsal: {
        screens: [],
        observations: [],
        completed: true,
      },
    });

    current = await service.store.updateProject(current.id, null, (project) => ({
      ...project, scriptProofHash: hash,
    }));

    return service.readProject(current.id);
  }

  await prove();

  if (clips) {
    const inputs = recordedInputs(current);

    for (const scene of current.scenes) {
      const targetDir = path.join(service.store.namesOf(current.id).scenesDir, scene.id, 'artifacts');
      const audioFile = path.join(root, `${scene.id}-audio.wav`);
      const videoFile = path.join(root, `${scene.id}-clip.webm`);

      await copyFile(`${voice.marker}.wav`, audioFile);
      await copyFile(clipFile, videoFile);

      const audio = await publishArtifact({
        file: audioFile,
        kind: 'audio',
        inputHash: audioInputHash(scene, inputs),
        producerVersion: PRODUCER_VERSIONS.voice,
        durationMs: 1500,
        targetDir,
      });
      const clip = await publishArtifact({
        file: videoFile,
        kind: 'clip',
        inputHash: clipInputHash(scene, inputs),
        producerVersion: PRODUCER_VERSIONS.recorder,
        durationMs: 3000,
        targetDir,
      });
      const recordingTiming = await publishRecordingTiming({
        timing,
        sceneInputHash: clip.inputHash,
        clipContentHash: clip.contentHash,
        actions: scene.actions,
        targetDir,
      });

      assert.ok(recordingTiming);
      current = await service.store.updateProject(current.id, null, (project) => ({
        ...project, scenes: project.scenes.map((item) => item.id === scene.id
          ? {
            ...item,
            audio,
            clip,
            recordingTiming,
          } : item),
      }));
    }
  }

  /**
   * Публикация проходит настоящую транзакцию job→файл→sidecar→store.
   * Можно передать прежний hash или часть сцен, не обходя охранную границу.
   */
  async function publish({
    ids = current.scenes.map((scene) => scene.id), inputHashes = null, beforeCommit = null,
  } = {}) {
    const live = await service.readProject(current.id);
    const inputs = recordedInputs(live);
    const { record: job } = await service.jobs.enqueue({
      projectId: current.id,
      kind: 'record',
      idempotencyKey: `publish-${Date.now()}-${Math.random()}`,
      inputRevision: live.revision,
      inputHashes: inputHashes ?? Object.fromEntries(live.scenes.map((scene) => [
        scene.id, clipInputHash(scene, inputs),
      ])),
    });
    const ops = createRecordingOps({
      assertEnabled: () => { },
      attempts: new Map(),
      broadcast: () => { },
      resolveBrowserPath: async () => null,
      acquireTargetLease: async () => null,
      inputsOf: recordedInputs,
      jobs: service.jobs,
      limits: options.limits,
      readProject: async (id) => {
        const project = await service.readProject(id);

        await beforeCommit?.();

        return project;
      },
      store: service.store,
      targets: service.targets,
    });

    const rawFiles = new Map();

    for (const sceneId of ids) {
      const file = path.join(root, `${job.id}-${sceneId}.webm`);

      await copyFile(clipFile, file);
      rawFiles.set(sceneId, file);
    }

    await ops.publishRecording(job.id, {
      attemptId: 'fixture-attempt',
      state: 'succeeded',
      scenes: live.scenes.filter((scene) => ids.includes(scene.id)).map((scene) => ({
        sceneId: scene.id,
        attempts: 1,
        rawPath: rawFiles.get(scene.id),
        readyOffsetMs: 0,
        recordedMs: 3000,
        durationMs: 3000,
        blockedRequests: 0,
        recordingTiming: timing,
      })),
    });
    await service.jobs.finish(job.id, { state: 'succeeded' });
    current = await service.store.readProject(current.id);

    return service.readProject(current.id);
  }

  return {
    root,
    profileDir,
    options,
    clipFile,
    sandbox,
    prove,
    publish,
    get service() { return service; },
    get project() { return current; },
    removeStand: () => {
      alive = false;
    },
    restart: async ({ resume = false } = {}) => {
      if (!resume) {
        await service.disable();
      }

      service = createShowcaseService(options);
      await service.recover();

      return service;
    },
  };
}
