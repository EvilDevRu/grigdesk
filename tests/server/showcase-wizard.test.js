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
import { createScene } from '../../server/src/lib/showcase/scenes.ts';
import {
  briefHashOf, scriptHashOf, SCRIPT_VERIFICATION_VERSION, writeScriptProof,
} from '../../server/src/lib/showcase/script/verification.ts';

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
      // Подпись элемента доезжает до модели; селектор — нет.
      elements: [{ id: 'run', selector: '[data-testid="run"]', title: 'кнопка запуска' }],
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

test('исчерпанный лимит модели оставляет явную причину и освобождает повторный разбор', async (t) => {
  const { service } = await fixture(t, {
    deps: {
      resolveScriptModel: async () => ({
        ok: true,
        ref: { provider: 'claude', model: 'claude-opus-5' },
        executor: {
          runUntrusted: async () => {
            throw new Error("You've hit your session limit · resets 12:50am (Asia/Novosibirsk)");
          },
        },
      }),
    },
  });
  const project = await service.createProject({ ref: { kind: 'project', id: 'demo-profile' } });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(() => service.analyze(project.id), (error) => {
      assert.equal(error.code, 'model_rate_limited');
      assert.match(error.message, /исчерпала лимит/);
      assert.match(error.message, /12:50am/);

      return true;
    });
  }

  assert.equal((await service.readProject(project.id)).scenes.length, 0);
});

test('сборка дожидается уже начатого разбора и не запускает конкурирующую модель', async (t) => {
  let release;
  let entered;
  let calls = 0;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const { service } = await fixture(t, {
    deps: {
      resolveScriptModel: async () => ({
        ok: true,
        ref: { provider: 'claude', model: 'claude-opus-5' },
        executor: {
          runUntrusted: async () => {
            calls += 1;

            if (calls === 1) {
              entered();
              await gate;

              return { reply: JSON.stringify({ points: ['Обзор', 'Действия', 'Результат'] }) };
            }

            return {
              reply: JSON.stringify({ scenes: [{
                title: 'Обзор',
                screenId: 'overview',
                narration: 'Показываем обзор.',
                caption: 'Обзор',
                subtitleText: 'Показываем обзор.',
                actions: [],
              }] }),
            };
          },
        },
      }),
    },
  });
  let project = await service.createProject({ ref: { kind: 'project', id: 'demo-profile' } });

  project = await service.store.updateProject(project.id, project.revision, (current) => ({
    ...current,
    brief: ['Прежний план'],
    scenes: [createScene(current, {
      title: 'Прежняя сцена',
      screenId: 'overview',
      narration: 'Прежний текст.',
      caption: 'Обзор',
      subtitleText: 'Прежний текст.',
      actions: [],
      startState: null,
      readyCondition: null,
    })],
  }));
  const proof = await writeScriptProof(service.store.namesOf(project.id).dir, {
    version: SCRIPT_VERIFICATION_VERSION,
    targetFingerprint: project.target.scope.targetFingerprint,
    policyRevision: project.target.scope.policyRevision,
    dataRevision: project.target.scope.dataRevision,
    briefHash: briefHashOf(project.brief),
    scriptHash: scriptHashOf(project.scenes),
    rehearsal: {
      screens: [],
      observations: [],
      completed: true,
    },
  });

  project = await service.store.updateProject(project.id, project.revision, (current) => ({
    ...current,
    scriptProofHash: proof,
  }));
  const analysis = service.analyze(project.id);

  await started;
  await assert.rejects(() => service.analyze(project.id), (error) => error.code === 'script_busy');
  await service.startBuild(project.id, project.revision, 'build-during-analysis');

  for (let attempt = 0; attempt < 100 && !service.jobs.list().length; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  await service.pollWorkers();
  const job = service.jobs.list().find((entry) => entry.kind === 'script');

  assert.ok(job);
  assert.equal(job.state, 'running');
  assert.match(job.progress.label, /уже запущенного разбора/);
  await assert.rejects(() => service.generateBrief(project.id, ''), (error) => error.code === 'script_busy');
  assert.equal(calls, 1);
  release();
  const analyzed = await analysis;

  assert.equal(calls, 2);
  assert.equal(analyzed.scenes.length, 1);

  for (let attempt = 0; attempt < 100 && service.jobs.read(job.id).state === 'running'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  // Браузер в этой проверке не настроен: отказ наступает только ПОСЛЕ разбора,
  // вместо второй модели и конфликта ревизий сохранённых сцен.
  assert.equal(service.jobs.read(job.id).state, 'failed');
  assert.match(service.jobs.read(job.id).error, /браузер/);
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

/**
 * Модель для разбора: бриф — первым вызовом, сцены — вторым. Ответ сценария
 * задаётся снаружи, чтобы проверять, что раздел делает с тем, что вернула модель.
 */
function scriptedModel(scenesReply) {
  const prompts = [];

  return {
    prompts,
    deps: {
      taskDetails: async () => null,
      scriptModelRef: () => ({ provider: 'claude', model: 'claude-opus-5' }),
      executorConfig: () => ({ claudeBin: '/usr/bin/claude' }),
      resolveScriptModel: async () => ({
        ok: true,
        ref: { provider: 'claude', model: 'claude-opus-5' },
        executor: {
          runUntrusted: async ({ message }) => {
            prompts.push(message);

            return {
              reply: prompts.length % 2 === 1
                ? JSON.stringify({ points: ['первое', 'второе', 'третье'] })
                : JSON.stringify(scenesReply),
            };
          },
        },
      }),
    },
  };
}

// «Разобрать заново» — новый сценарий, а не дописанный к прежнему: раньше каждый
// повтор разбора удваивал список сцен. Голос и темп при этом остаются: их
// выбирал человек для ролика целиком.
test('повторный разбор заменяет сцены, сохраняя выбранный темп ролика', async (t) => {
  const model = scriptedModel({
    scenes: [
      {
        title: 'Обзор',
        screenId: 'overview',
        narration: 'Показываю обзор.',
        caption: 'Обзор',
        subtitleText: 'Показываю обзор.',
        actions: [{ kind: 'hover', targetId: 'run' }],
      },
      {
        title: 'Запуск',
        screenId: 'overview',
        narration: 'Запускаю.',
        caption: 'Запуск',
        subtitleText: 'Запускаю.',
        actions: [],
      },
    ],
    gaps: ['нет экрана результата запуска'],
  });
  const { service } = await fixture(t, { deps: model.deps });
  const project = await service.createProject({ ref: { kind: 'project', id: 'demo-profile' } });
  const analyzed = await service.analyze(project.id);

  assert.equal(analyzed.scenes.length, 2);
  assert.deepEqual(analyzed.scriptGaps, ['нет экрана результата запуска']);
  assert.equal(
    analyzed.scriptMapRevision,
    analyzed.target.scope.mapRevision,
    'сценарий помнит ревизию словаря карты, по которому составлен',
  );

  const paced = await service.setVoice(analyzed.id, analyzed.revision, { voiceRef: null, pace: 'slow' });
  const again = await service.analyze(paced.id);

  assert.match(model.prompts[1], /run \(кнопка запуска\)/, 'подпись элемента видна модели');
  assert.doesNotMatch(model.prompts[1], /data-testid/, 'селектор модели не показывается');
  assert.equal(again.scenes.length, 2, 'повторный разбор не удваивает сцены');
  assert.deepEqual(again.scenes.map((scene) => scene.order), [1, 2]);
  assert.deepEqual(again.scenes.map((scene) => scene.direction.pace), ['slow', 'slow']);
  assert.notEqual(again.scenes[0].id, analyzed.scenes[0].id, 'сцены новые, а не прежние');
  assert.deepEqual(
    again.scenes[0].actions,
    [{ kind: 'hover', targetId: 'run' }],
    'действия модели доезжают до сцены',
  );
});

// После разбора профиль дописал карту экранов. Сцены об этом не знают, и раздел
// обязан отдать разные ревизии: по ним интерфейс говорит «разберите заново».
test('правка карты экранов после разбора видна как расхождение ревизий', async (t) => {
  const model = scriptedModel({
    scenes: [{
      title: 'Обзор',
      screenId: 'overview',
      narration: 'Показываю обзор.',
      caption: 'Обзор',
      subtitleText: 'Показываю обзор.',
      actions: [],
    }],
  });
  const { service, root } = await fixture(t, { deps: model.deps });
  const project = await service.createProject({ ref: { kind: 'project', id: 'demo-profile' } });
  const analyzed = await service.analyze(project.id);

  await writeFile(
    path.join(root, 'profiles', 'demo-profile', 'showcase', 'screens.json'),
    JSON.stringify({
      ...SCREENS_CONTRACT,
      screens: [{
        ...SCREENS_CONTRACT.screens[0],
        elements: [...SCREENS_CONTRACT.screens[0].elements, { id: 'filter', selector: '#filter' }],
      }],
    }),
    'utf8',
  );

  const reread = await service.readProject(project.id);

  assert.equal(reread.scriptMapRevision, analyzed.scriptMapRevision);
  assert.notEqual(reread.target.scope.mapRevision, reread.scriptMapRevision);

  // Правка селектора словарь не меняет: сценарий от неё не стареет.
  await writeFile(
    path.join(root, 'profiles', 'demo-profile', 'showcase', 'screens.json'),
    JSON.stringify({
      ...SCREENS_CONTRACT,
      screens: [{
        ...SCREENS_CONTRACT.screens[0],
        elements: [{ ...SCREENS_CONTRACT.screens[0].elements[0], selector: '#run-renamed' }],
      }],
    }),
    'utf8',
  );

  const selectorOnly = await service.readProject(project.id);

  assert.equal(selectorOnly.target.scope.mapRevision, selectorOnly.scriptMapRevision);
});

test('новый сценарий сохраняет три автоматические связи с серверными ID', async (t) => {
  const model = scriptedModel({
    scenes: [{
      title: 'Синхронный обзор',
      screenId: 'overview',
      narration: 'Сначала запускаем, затем ждём результат и показываем результат.',
      caption: 'Обзор',
      subtitleText: 'Сначала запускаем, затем ждём результат и показываем результат.',
      actions: [
        { kind: 'click', targetId: 'run' },
        { kind: 'waitVisible', targetId: 'run' },
        { kind: 'highlight', targetId: 'run' },
      ],
      bindings: [
        { quote: 'запускаем', occurrence: 1, actionIndex: 0, kind: 'align-start' },
        { quote: 'результат', occurrence: 1, actionIndex: 1, kind: 'ready-before' },
        { quote: 'результат', occurrence: 2, actionIndex: 2, kind: 'hold-through' },
      ],
    }],
  });
  const { service } = await fixture(t, { deps: model.deps });
  const project = await service.createProject({ ref: { kind: 'project', id: 'demo-profile' } });
  const analyzed = await service.analyze(project.id);
  const cues = analyzed.scenes[0].syncBindings.cues;

  assert.equal(cues.length, 3);
  assert.deepEqual(cues.map((cue) => cue.origin), ['generated', 'generated', 'generated']);
  assert.ok(cues.every((cue) => /^cue-[a-f0-9]{12}$/.test(cue.id)));
  assert.deepEqual(cues.map((cue) => cue.actionIndex), [0, 1, 2]);

  const scene = analyzed.scenes[0];
  const corrected = await service.updateScene(analyzed.id, analyzed.revision, scene.id, {
    syncCues: cues.map((cue, index) => ({
      id: cue.id,
      actionIndex: cue.actionIndex,
      from: index === 0 ? 0 : cue.from,
      to: index === 0 ? 'Сначала'.length : cue.to,
      kind: cue.kind,
      ...(index === 0 ? { manual: true } : {}),
    })),
  });
  const correctedScene = corrected.scenes[0];

  assert.equal(correctedScene.syncBindings.cues[0].id, cues[0].id);
  assert.equal(correctedScene.syncBindings.cues[0].origin, 'manual');
  assert.deepEqual(
    correctedScene.syncBindings.cues.slice(1),
    cues.slice(1),
    'неисправленные модельные cue сохраняют ID и origin',
  );
  assert.equal(correctedScene.narration, scene.narration);
  assert.deepEqual(correctedScene.audioSource, scene.audioSource, 'выбор голоса не меняется');
});

test('построение только связей сохраняет ручную сцену и её cue', async (t) => {
  let calls = 0;
  const deps = {
    scriptModelRef: () => ({ provider: 'claude', model: 'claude-opus-5' }),
    executorConfig: () => ({ claudeBin: '/usr/bin/claude' }),
    resolveScriptModel: async () => ({
      ok: true,
      ref: { provider: 'claude', model: 'claude-opus-5' },
      executor: {
        runUntrusted: async ({ message }) => {
          calls += 1;
          const sceneId = message.match(/<scene_id>([^<]+)<\/scene_id>/)?.[1];

          return {
            reply: JSON.stringify({
              scenes: [{
                sceneId,
                bindings: [calls === 1
                  ? { quote: 'результат', occurrence: 1, actionIndex: 1, kind: 'hold-through' }
                  : { quote: 'запускаем', occurrence: 1, actionIndex: 0, kind: 'align-start' }],
              }],
            }),
          };
        },
      },
    }),
  };
  const { service } = await fixture(t, { deps });
  const project = await service.createProject({ ref: { kind: 'project', id: 'demo-profile' } });
  const added = await service.addScene(project.id, project.revision, {
    title: 'Ручная сцена',
    screenId: 'overview',
    narration: 'Сначала запускаем и показываем результат.',
    caption: 'Ручная',
    subtitleText: 'Сначала запускаем и показываем результат.',
    startState: null,
    readyCondition: null,
    actions: [
      { kind: 'click', targetId: 'run' },
      { kind: 'highlight', targetId: 'run' },
    ],
  });
  const scene = added.scenes[0];
  const from = scene.narration.indexOf('результат');
  const manual = await service.updateScene(added.id, added.revision, scene.id, {
    syncCues: [{ actionIndex: 1, from, to: from + 'результат'.length, kind: 'hold-through' }],
  });
  const before = manual.scenes[0];
  const manualCue = before.syncBindings.cues[0];
  const generated = await service.generateBindings(manual.id);
  const after = generated.scenes[0];

  assert.equal(calls, 2, 'после негодного ответа выполняется ровно один repair');
  assert.deepEqual({
    id: after.id,
    title: after.title,
    narration: after.narration,
    actions: after.actions,
    order: after.order,
  }, {
    id: before.id,
    title: before.title,
    narration: before.narration,
    actions: before.actions,
    order: before.order,
  });
  assert.deepEqual(
    after.syncBindings.cues.find((cue) => cue.origin === 'manual'),
    manualCue,
    'ручной cue сохраняется вместе с ID',
  );
  assert.equal(after.syncBindings.cues.find((cue) => cue.origin === 'generated').actionIndex, 0);
});
