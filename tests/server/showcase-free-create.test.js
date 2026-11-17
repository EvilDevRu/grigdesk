// Свободное создание: ролик живёт без стенда, стенд подключается отдельной операцией.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createShowcaseService } from '../../server/src/lib/showcase/service.ts';

const TARGET_CONTRACT = {
  version: 1,
  environment: 'read-only',
  project: { record: 'http://127.0.0.1:5173', view: 'http://127.0.0.1:5173' },
  sandbox: { recordTemplate: 'http://127.0.0.1:{fePort}', viewTemplate: null },
  allowedOrigins: [],
  capabilities: ['record'],
};

/**
 * Служба использует настоящий каталог и временный профиль без запуска сервера.
 * Инъекции задерживают только внешнее чтение, сохраняя реальный допуск действий.
 */
async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'showcase-free-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  const contractDir = path.join(root, 'profiles', 'demo-profile', 'showcase');

  await mkdir(contractDir, { recursive: true });
  await mkdir(path.join(root, 'state'), { recursive: true });
  await writeFile(path.join(contractDir, 'target.json'), JSON.stringify(TARGET_CONTRACT), 'utf8');
  await writeFile(
    path.join(root, 'profiles', 'demo-profile', 'dashboard.env'),
    'FACTORY_STAND_URL=http://127.0.0.1:5173\n',
    'utf8',
  );

  const service = createShowcaseService({
    voiceBin: path.join(root, 'no-live-voice'),
    showcaseDir: path.join(root, 'showcase'),
    authDir: path.join(root, 'auth'),
    profilesDir: path.join(root, 'profiles'),
    stateDir: path.join(root, 'state'),
    browserPath: null,
    listProjects: async () => ['demo-profile'],
    broadcast: () => {},
    ...options,
    limits: () => ({
      maxScenes: 20,
      maxSceneSeconds: 120,
      maxTotalSeconds: 600,
      retentionDays: 30,
      maxQueued: 4,
      jobTimeoutMs: 60_000,
    }),
  });

  await service.recover();

  return { service, root };
}

test('ролик создаётся без стенда и называется новым роликом', async (t) => {
  const { service } = await fixture(t);
  const project = await service.createProject({});

  assert.equal(project.ref, null);
  assert.equal(project.target, null);
  assert.equal(project.title, 'Новый ролик');
  assert.equal(project.scenes.length, 0);
});

test('без стенда разбор отказывает понятной причиной, а не падает', async (t) => {
  const { service } = await fixture(t);
  const project = await service.createProject({});

  await assert.rejects(
    () => service.analyze(project.id),
    (error) => error.code === 'target_unavailable' && /Стенд не выбран/u.test(error.message),
  );
});

test('стенд подключается к свободному ролику и сохраняется снимком', async (t) => {
  const { service } = await fixture(t);
  const project = await service.createProject({});
  const attached = await service.attachTarget(
    project.id,
    project.revision,
    { kind: 'project', id: 'demo-profile' },
  );

  assert.deepEqual(attached.ref, { kind: 'project', id: 'demo-profile' });
  assert.equal(attached.target.status, 'ready');
  assert.equal(attached.target.scope.profile, 'demo-profile');

  const read = await service.readProject(project.id);

  assert.equal(read.target.status, 'ready');
});

test('подключение несуществующего стенда отказывает причиной, ролик не меняется', async (t) => {
  const { service } = await fixture(t);
  const project = await service.createProject({});

  await assert.rejects(
    () => service.attachTarget(project.id, project.revision, { kind: 'sandbox', id: '9999' }),
    (error) => error.code === 'target_unavailable',
  );
  assert.equal((await service.readProject(project.id)).ref, null);
});

test('старое создание по стенду продолжает работать', async (t) => {
  const { service } = await fixture(t);
  const project = await service.createProject({ ref: { kind: 'project', id: 'demo-profile' } });

  assert.equal(project.target.status, 'ready');
  assert.equal(project.title, 'Проект demo-profile');
});

test('неполная пара kind/id отвергается формой', async (t) => {
  const { service } = await fixture(t);

  // Ручка проверяет пару до службы; на уровне службы неполный вход не доходит.
  // Проверка ручки — в showcase-http-gate.test.js (шаг 2 п.7а обновляет матрицу).
  await assert.rejects(
    () => service.createProject({ ref: { kind: 'sandbox', id: '' } }),
    (error) => error.code === 'target_unavailable',
  );
});

test('смена стенда посреди задания отказывает занятостью', async (t) => {
  const { service } = await fixture(t);
  const project = await service.createProject({ ref: { kind: 'project', id: 'demo-profile' } });

  // Активное задание ставится журналом службы напрямую (рабочий способ один):
  await service.jobs.enqueue({
    projectId: project.id,
    kind: 'voice',
    idempotencyKey: 'busy-test-key',
    inputHashes: {},
    inputRevision: project.revision,
  });

  await assert.rejects(
    () => service.attachTarget(project.id, project.revision, { kind: 'project', id: 'demo-profile' }),
    (error) => error.code === 'target_busy',
  );
});

for (const action of ['analyze', 'saveSource', 'startBuild', 'startRecording', 'synthesizeScenes',
  'assemble', 'prepareData']) {
  test(`подключаемый стенд защищён до resolver: ${action}`, async (t) => {
    const gate = Promise.withResolvers();
    const entered = Promise.withResolvers();
    let blocked = false;
    const { service } = await fixture(t, {
      sandboxOverview: async () => {
        if (blocked) {
          blocked = false;
          entered.resolve();
          await gate.promise;
        }

        return { sandboxes: [] };
      },
    });
    const project = await service.createProject({ ref: { kind: 'project', id: 'demo-profile' } });

    blocked = true;

    const attaching = service.attachTarget(project.id, project.revision, project.ref);

    try {
      await entered.promise;
      await assert.rejects(
        () => service[action](project.id, project.revision, 'reserved-test'),
        (error) => error.code === 'target_busy',
      );
      assert.equal(service.buildRuns.active(project.id).length, 0);
    } finally {
      gate.resolve();
      await attaching;
    }
  });
}

test('задание другого ролика не блокирует подключение', async (t) => {
  const { service } = await fixture(t);
  const project = await service.createProject({});

  await service.jobs.enqueue({
    projectId: 'other-project',
    kind: 'voice',
    idempotencyKey: 'another-project',
    inputHashes: {},
    inputRevision: 1,
  });

  const attached = await service.attachTarget(project.id, project.revision, {
    kind: 'project', id: 'demo-profile',
  });

  assert.equal(attached.target.status, 'ready');
});

test('неизвестная сцена пересъёмки отказывает до проверки браузера', async (t) => {
  const { service } = await fixture(t);
  const project = await service.createProject({});

  await assert.rejects(service.startRecording(project.id, { forceSceneIds: ['missing'] }),
    (error) => error.code === 'bad_scene');
});
