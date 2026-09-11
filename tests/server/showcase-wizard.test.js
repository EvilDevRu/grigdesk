// Мастер раздела «Презентации»: что человек не заполняет руками.
//
// Проверяется ровно то, что мастер обещает: ролик называет себя сам по стенду,
// разбор сам берёт текст связанной задачи, а файлы не живут дольше своего срока.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

const SCREENS_CONTRACT = {
  version: 1,
  screens: [
    {
      id: 'overview',
      title: 'Обзор',
      path: '/',
      readySelector: '[data-testid="ready"]',
      elements: [{ id: 'run', selector: '[data-testid="run"]' }],
    },
  ],
};

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'showcase-wizard-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  const contractDir = path.join(root, 'profiles', 'demo-profile', 'showcase');

  await mkdir(contractDir, { recursive: true });
  await mkdir(path.join(root, 'state'), { recursive: true });
  await writeFile(path.join(contractDir, 'target.json'), JSON.stringify(TARGET_CONTRACT), 'utf8');
  await writeFile(path.join(contractDir, 'screens.json'), JSON.stringify(SCREENS_CONTRACT), 'utf8');
  await writeFile(
    path.join(root, 'profiles', 'demo-profile', 'dashboard.env'),
    'FACTORY_STAND_URL=http://127.0.0.1:5173\n',
    'utf8',
  );

  const service = createShowcaseService({
    showcaseDir: path.join(root, 'showcase'),
    authDir: path.join(root, 'auth'),
    profilesDir: path.join(root, 'profiles'),
    stateDir: path.join(root, 'state'),
    browserPath: null,
    listProjects: async () => ['demo-profile'],
    broadcast: () => {},
    limits: () => ({
      maxScenes: 20,
      maxSceneSeconds: 120,
      maxTotalSeconds: 600,
      retentionDays: options.retentionDays ?? 30,
      maxQueued: 4,
      jobTimeoutMs: 60_000,
    }),
    ...options.deps,
  });

  await service.recover();

  return { service, root };
}

test('ролик берёт имя у стенда, а не у человека', async (t) => {
  const { service } = await fixture(t);
  const project = await service.createProject({ ref: { kind: 'project', id: 'demo-profile' } });

  assert.equal(project.title, 'Проект demo-profile');
});

test('разбор сам читает связанную задачу и не спрашивает её текст', async (t) => {
  const prompts = [];
  const asked = [];
  const { service } = await fixture(t, {
    deps: {
      taskDetails: async (taskId) => {
        asked.push(taskId);

        return { title: 'Фильтры на доске', description: '<p>Нужно показать <b>фильтры</b></p>' };
      },
      scriptModelRef: () => ({ provider: 'claude', model: 'claude-opus-5' }),
      executorConfig: () => ({ claudeBin: '/usr/bin/claude' }),
      resolveScriptModel: async () => ({
        ok: true,
        ref: { provider: 'claude', model: 'claude-opus-5' },
        executor: {
          runUntrusted: async ({ message }) => {
            prompts.push(message);

            // Первый вызов — бриф, второй — сцены: у них разная форма ответа.
            return {
              reply: prompts.length === 1
                ? JSON.stringify({ points: ['первое', 'второе', 'третье'] })
                : JSON.stringify({
                    scenes: [{
                      title: 'Обзор',
                      screenId: 'overview',
                      narration: 'Показываю доску и фильтры на ней.',
                      caption: 'Доска',
                      subtitleText: 'Показываю доску и фильтры на ней.',
                      actions: [],
                    }],
                  }),
            };
          },
        },
      }),
    },
  });

  const project = await service.createProject({ ref: { kind: 'project', id: 'demo-profile' } });
  const analyzed = await service.analyze(project.id);

  assert.deepEqual(asked, [], 'у постоянного стенда задачи в портале нет');
  assert.equal(analyzed.brief.length, 3);
  assert.equal(analyzed.scenes.length, 1);
  assert.ok(
    prompts[0].includes('Фильтры на доске') === false,
    'текст задачи проекта не выдумывается',
  );
});

test('ролик старше срока хранения уходит вместе со своими файлами', async (t) => {
  const { service, root } = await fixture(t, { retentionDays: 1 });
  const project = await service.createProject({ ref: { kind: 'project', id: 'demo-profile' } });

  await service.renameProject(project.id, project.revision, 'Старый ролик');
  await ageProject(root, project.id);
  await service.recover();

  const overview = await service.overview();

  assert.equal(
    overview.projects.some((item) => item.id === project.id),
    false,
    'ролик, которого не касались дольше срока, не остаётся в библиотеке',
  );
});

/**
 * Сдвигает отметку последнего изменения ролика в прошлое. Служба своих файлов
 * наружу не отдаёт, поэтому запись правится там, где лежит, — иначе тест ждал бы
 * реальные тридцать дней.
 */
async function ageProject(root, id) {
  const file = path.join(root, 'showcase', 'projects', id, 'project.json');
  const project = JSON.parse(await readFile(file, 'utf8'));

  project.updatedAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  await writeFile(file, JSON.stringify(project), 'utf8');
}

test('голос и темп меняются у всех синтезируемых сцен разом', async (t) => {
  const { service } = await fixture(t);
  const project = await service.createProject({ ref: { kind: 'project', id: 'demo-profile' } });
  let current = project;

  for (const title of ['Первая', 'Вторая']) {
    current = await service.addScene(current.id, current.revision, {
      title,
      screenId: 'overview',
      narration: `${title} сцена.`,
      caption: '',
      subtitleText: '',
      startState: null,
      readyCondition: null,
      actions: [],
    });
  }

  const changed = await service.setVoice(current.id, current.revision, { voiceRef: null, pace: 'slow' });

  assert.deepEqual(changed.scenes.map((scene) => scene.direction.pace), ['slow', 'slow']);

  // Неустановленный голос выбрать нельзя: сборка упёрлась бы в него позже и молча.
  await assert.rejects(
    () => service.setVoice(changed.id, changed.revision, { voiceRef: 'silero:xenia', pace: null }),
    (error) => error.code === 'voice_unavailable',
  );
  await assert.rejects(
    () => service.previewVoice('nosuch:voice'),
    (error) => error.code === 'unknown_voice_engine',
  );
});

test('новая сцена наследует голос и темп предыдущей', async (t) => {
  const { service } = await fixture(t);
  const project = await service.createProject({ ref: { kind: 'project', id: 'demo-profile' } });
  const draft = (title) => ({
    title,
    screenId: 'overview',
    narration: `${title} сцена.`,
    caption: '',
    subtitleText: '',
    startState: null,
    readyCondition: null,
    actions: [],
  });
  const first = await service.addScene(project.id, project.revision, draft('Первая'));
  const paced = await service.setVoice(first.id, first.revision, { voiceRef: null, pace: 'fast' });
  const second = await service.addScene(paced.id, paced.revision, draft('Вторая'));

  assert.equal(second.scenes[1].direction.pace, 'fast');
});
