// Сквозная проверка записи: служба заводит задание, отсоединённый исполнитель
// пишет сцены, сервер публикует клипы.
//
// Это единственный тест, который проходит ВЕСЬ продуктовый путь записи: остальные
// проверяют его части. Без браузера он пропускается явно — отсутствие зависимости
// не должно выглядеть как успешная приёмка.
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { createShowcaseService } from '../../server/src/lib/showcase/service.ts';
import { readRecordingTiming } from '../../server/src/lib/showcase/recordingOps.ts';

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

async function findBrowser() {
  if (process.env.GRIGDESK_SHOWCASE_BROWSER) {
    return process.env.GRIGDESK_SHOWCASE_BROWSER;
  }

  const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
  const registry = path.join(os.homedir(), '.cache', 'ms-playwright');
  const browsers = await (async () => {
    try {
      const entry = requireFromServer.resolve('playwright-core');

      return JSON.parse(await readFile(path.join(path.dirname(entry), 'browsers.json'), 'utf8'));
    } catch {
      return null;
    }
  })();
  const wanted = browsers?.browsers?.find((item) => item.name === 'chromium');

  if (!wanted) {
    return null;
  }

  const candidate = path.join(registry, `chromium-${wanted.revision}`, 'chrome-linux64', 'chrome');

  return access(candidate).then(() => candidate).catch(() => null);
}

/**
 * Стенд-мишень с двумя экранами. Он же и есть «продукт», который показывает ролик:
 * ничего другого записи не нужно.
 */
async function startTarget() {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Стенд</title>
<style>body{margin:0;background:#101318;color:#eef;font:16px system-ui}main{padding:40px}</style>
</head><body><main>
<h1 data-testid="ready">Экран ${request.url}</h1>
<button data-testid="run">Запустить</button>
</main></body></html>`);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function fixture(t, { browserPath, targetOrigin, screens = SCREENS_CONTRACT }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'showcase-worker-'));
  let service = null;

  // Даже упавшее assertion/timeout обязано сначала снять отсоединённого worker
  // вместе с process group Chromium и лишь затем удалять его рабочий каталог.
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
      project: { record: targetOrigin, view: targetOrigin },
      sandbox: null,
      allowedOrigins: [],
      capabilities: ['record'],
    }),
    'utf8',
  );
  await writeFile(path.join(contractDir, 'screens.json'), JSON.stringify(screens), 'utf8');

  service = createShowcaseService({
    showcaseDir: path.join(root, 'showcase'),
    authDir: path.join(root, 'auth'),
    profilesDir: path.join(root, 'profiles'),
    stateDir: path.join(root, 'state'),
    browserPath,
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

  return { service, root };
}

/**
 * Наблюдение идёт тем же способом, что и в сервере: журнал попытки перечитывается,
 * итог публикуется службой. Своего пути у теста нет — иначе он проверял бы себя.
 */
async function waitForJob(service, jobId, timeoutMs = 180_000, seenLabels = []) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await service.pollWorkers();

    const job = service.jobs.read(jobId);

    if (seenLabels.at(-1) !== job.progress.label) {
      seenLabels.push(job.progress.label);
    }

    if (job.state !== 'queued' && job.state !== 'running') {
      return job;
    }

    await new Promise((resolve) => { setTimeout(resolve, 500); });
  }

  throw new Error('задание записи не завершилось за отведённое время');
}

test('задание записи доходит до опубликованных клипов сцен', async (t) => {
  const browserPath = await findBrowser();

  if (!browserPath) {
    t.skip('браузер записи не установлен: это не успешная приёмка, а её отсутствие');

    return;
  }

  const target = await startTarget();

  t.after(() => target.close());

  const { service, root } = await fixture(t, { browserPath, targetOrigin: target.origin });
  let project = await service.createProject({
    ref: { kind: 'project', id: 'demo-profile' },
    profile: 'demo-profile',
    title: 'Сквозная проверка',
  });

  assert.equal(project.target.status, 'ready');

  for (const title of ['Первая', 'Вторая']) {
    project = await service.addScene(project.id, project.revision, {
      title,
      screenId: 'overview',
      narration: `${title} сцена.`,
      caption: title,
      subtitleText: `${title} сцена.`,
      startState: null,
      readyCondition: null,
      actions: [
        { kind: 'hover', targetId: 'run' },
        { kind: 'wait', ms: 500 },
      ],
    });
  }

  const originalPolicyRevision = project.target.status === 'ready'
    ? project.target.scope.policyRevision
    : '';
  await writeFile(
    path.join(root, 'profiles', 'demo-profile', 'showcase', 'screens.json'),
    JSON.stringify({
      ...SCREENS_CONTRACT,
      screens: SCREENS_CONTRACT.screens.map((screen) => ({
        ...screen,
        elements: screen.elements.map((element) => ({
          ...element,
          title: 'кнопка запуска после правки карты',
        })),
      })),
    }),
    'utf8',
  );
  const changedPolicy = await service.readProject(project.id);

  assert.equal(changedPolicy.target.status, 'ready');
  assert.notEqual(changedPolicy.target.scope.policyRevision, originalPolicyRevision);
  assert.deepEqual(project.scenes.map((scene) => scene.stale), [true, true]);

  const job = await service.startRecording(project.id);
  const labels = [];
  const finished = await waitForJob(service, job.id, 180_000, labels);

  assert.equal(finished.state, 'succeeded', finished.error ?? '');
  // Ход исполнителя доезжает до задания строка за строкой: прежде порог чтения
  // журнала смешивался с номером сообщения, и половина шагов пропадала — человек
  // минуту видел «пишем сцену 4» при идущей десятой.
  for (const title of ['Первая', 'Вторая']) {
    assert.ok(
      labels.some((label) => label.includes(`пишем сцену «${title}»`)),
      `ход записи сцены «${title}» обязан дойти до задания: ${labels.join(' | ')}`,
    );
  }

  const recorded = await service.readProject(project.id);

  for (const scene of recorded.scenes) {
    assert.ok(scene.clip, `у сцены «${scene.title}» обязан появиться клип`);
    assert.ok(scene.recordingTiming, `у нового клипа «${scene.title}» обязан появиться журнал`);
    assert.ok(scene.clip.byteSize > 10_000, 'клип не должен быть пустышкой');
    assert.ok((scene.clip.durationMs ?? 0) > 200, 'клип короче четверти секунды записью не считается');
    const timing = await readRecordingTiming({
      ref: scene.recordingTiming,
      sceneInputHash: scene.clip.inputHash,
      clipContentHash: scene.clip.contentHash,
      actions: scene.actions,
      targetDir: path.join(root, 'showcase', 'projects', recorded.id, 'scenes', scene.id, 'artifacts'),
    });

    assert.ok(timing, `журнал «${scene.title}» проходит codec/hash`);
    assert.equal(timing.status, 'calibrated');
    if (timing.status !== 'calibrated') continue;
    assert.equal(timing.actions.length, scene.actions.length);
    assert.ok(timing.calibration.errorMs <= 100);
  }

  // Повторный запуск не переснимает свежие сцены: ровно ради этого свежесть и
  // считается хешами входов.
  await assert.rejects(
    () => service.startRecording(project.id),
    (error) => error.code === 'nothing_to_record',
  );

  // Legacy-клип без журнала остаётся воспроизводимым, но следующий запуск должен
  // один раз переснять именно его ради measured path — clip freshness этого не скрывает.
  const projectFile = path.join(root, 'showcase', 'projects', recorded.id, 'project.json');
  const withoutOneLog = {
    ...recorded,
    scenes: recorded.scenes.map((scene, index) => (
      index === 0 ? { ...scene, recordingTiming: null } : scene
    )),
  };

  await writeFile(projectFile, `${JSON.stringify(withoutOneLog, null, 2)}\n`, 'utf8');

  const repairedJob = await service.startRecording(recorded.id);
  const repairedResult = await waitForJob(service, repairedJob.id);

  assert.equal(repairedResult.state, 'succeeded', repairedResult.error ?? '');

  const repaired = await service.readProject(recorded.id);

  assert.ok(repaired.scenes[0].recordingTiming, 'журнал legacy-клипа восстановлен пересъёмкой');
  assert.notEqual(repaired.scenes[0].clip.id, recorded.scenes[0].clip.id);
  assert.equal(repaired.scenes[1].clip.id, recorded.scenes[1].clip.id);
});

test('правка одной сцены отправляет на пересъёмку только её', async (t) => {
  const browserPath = await findBrowser();

  if (!browserPath) {
    t.skip('браузер записи не установлен: это не успешная приёмка, а её отсутствие');

    return;
  }

  const target = await startTarget();

  t.after(() => target.close());

  const { service } = await fixture(t, { browserPath, targetOrigin: target.origin });
  let project = await service.createProject({
    ref: { kind: 'project', id: 'demo-profile' },
    profile: 'demo-profile',
    title: 'Пересъёмка одной сцены',
  });

  for (const title of ['Первая', 'Вторая']) {
    project = await service.addScene(project.id, project.revision, {
      title,
      screenId: 'overview',
      narration: `${title} сцена.`,
      caption: title,
      subtitleText: `${title} сцена.`,
      startState: null,
      readyCondition: null,
      actions: [{ kind: 'wait', ms: 400 }],
    });
  }

  const firstRun = await waitForJob(service, (await service.startRecording(project.id)).id);

  assert.equal(firstRun.state, 'succeeded', firstRun.error ?? '');

  const recorded = await service.readProject(project.id);

  assert.ok(recorded.scenes[0].clip, 'первая запись обязана дать клипы');
  assert.ok(recorded.scenes[1].clip, 'первая запись обязана дать клипы');
  const first = recorded.scenes[0];
  const second = recorded.scenes[1];
  const edited = await service.updateScene(recorded.id, recorded.revision, second.id, {
    actions: [{ kind: 'hover', targetId: 'run' }],
  });

  // Свежесть сцены целиком включает и звук, которого в этой проверке нет вовсе.
  // Здесь важна другая половина: правка действий второй сцены не должна отправить
  // на пересъёмку первую.
  const job = await service.startRecording(edited.id);
  const finished = await waitForJob(service, job.id);

  assert.equal(finished.state, 'succeeded', finished.error ?? '');

  const after = await service.readProject(edited.id);

  assert.equal(
    after.scenes[0].clip.id,
    first.clip.id,
    'клип нетронутой сцены остался прежним файлом',
  );
  assert.equal(
    after.scenes[0].clip.contentHash,
    first.clip.contentHash,
    'и теми же байтами: пересъёмка соседа стоила бы отдельного прогона браузера',
  );
  assert.notEqual(
    after.scenes[1].clip.id,
    second.clip.id,
    'правленая сцена пересnята',
  );
});

/**
 * Стенд с диалогом: итог виден только после клика по кнопке. Ровно так выглядит
 * массовое действие на стенде — и ровно это опытный ролик пять раз открывал заново.
 */
async function startDialogTarget() {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Стенд</title>
<style>body{margin:0;background:#101318;color:#eef;font:16px system-ui}main{padding:40px}
dialog{padding:24px;border:1px solid #445;background:#1a1f2b;color:#eef}</style>
</head><body><main>
<h1 data-testid="ready">Проекты</h1>
<button data-testid="open">Снять частотность</button>
<dialog data-testid="dialog"><p data-testid="total">Итого: 42 лимита</p></dialog>
<script>
document.querySelector('[data-testid="open"]').addEventListener('click', () => {
  document.querySelector('dialog').showModal();
});
</script>
</main></body></html>`);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const DIALOG_SCREENS = {
  version: 1,
  screens: [
    {
      id: 'projects',
      title: 'Проекты',
      path: '/',
      readySelector: '[data-testid="ready"]',
      elements: [
        { id: 'open', selector: '[data-testid="open"]' },
        { id: 'dialog', selector: '[data-testid="dialog"]' },
        { id: 'total', selector: '[data-testid="total"]' },
      ],
    },
  ],
};

// Продолжение застаёт диалог открытым предыдущей сценой: в новом контексте
// подсветка итога сорвалась бы — элемент виден только внутри открытого диалога.
// Цена цепочки тоже проверяется: правка последнего продолжения переснимает всю
// цепочку, но не трогает независимую сцену рядом.
test('цепочка сцен пишется одним состоянием экрана и переснимается целиком', async (t) => {
  const browserPath = await findBrowser();

  if (!browserPath) {
    t.skip('браузер записи не установлен: это не успешная приёмка, а её отсутствие');

    return;
  }

  const target = await startDialogTarget();

  t.after(() => target.close());

  const { service, root } = await fixture(t, {
    browserPath,
    targetOrigin: target.origin,
    screens: DIALOG_SCREENS,
  });
  let project = await service.createProject({
    ref: { kind: 'project', id: 'demo-profile' },
    profile: 'demo-profile',
    title: 'Цепочка сцен',
  });
  const drafts = [
    {
      title: 'Открываем диалог',
      continuesPrevious: false,
      actions: [{ kind: 'click', targetId: 'open' }, { kind: 'waitVisible', targetId: 'dialog' }],
    },
    {
      title: 'Итог в диалоге',
      continuesPrevious: true,
      actions: [{ kind: 'highlight', targetId: 'total' }],
    },
    {
      title: 'Ещё раз про итог',
      continuesPrevious: true,
      actions: [{ kind: 'hover', targetId: 'total' }, { kind: 'wait', ms: 300 }],
    },
    {
      title: 'Отдельная сцена',
      continuesPrevious: false,
      actions: [{ kind: 'hover', targetId: 'open' }],
    },
  ];

  for (const draft of drafts) {
    project = await service.addScene(project.id, project.revision, {
      title: draft.title,
      screenId: 'projects',
      narration: `${draft.title}.`,
      caption: draft.title,
      subtitleText: `${draft.title}.`,
      startState: null,
      readyCondition: null,
      continuesPrevious: draft.continuesPrevious,
      actions: draft.actions,
    });
  }

  const labels = [];
  const first = await waitForJob(service, (await service.startRecording(project.id)).id, 240_000, labels);

  assert.equal(first.state, 'succeeded', first.error ?? '');

  for (const draft of drafts) {
    assert.ok(
      labels.some((label) => label.includes(`пишем сцену «${draft.title}»`)),
      `ход записи сцены «${draft.title}» обязан дойти до задания: ${labels.join(' | ')}`,
    );
  }

  const recorded = await service.readProject(project.id);
  const before = recorded.scenes.map((scene) => scene.clip);

  for (const scene of recorded.scenes) {
    assert.ok(scene.clip, `у сцены «${scene.title}» обязан появиться клип`);
    assert.ok(scene.recordingTiming, `у сцены «${scene.title}» обязан появиться журнал`);
    assert.ok((scene.clip.durationMs ?? 0) > 200, `клип «${scene.title}» короче четверти секунды`);
  }

  const continuation = recorded.scenes[1];
  const continuationTiming = await readRecordingTiming({
    ref: continuation.recordingTiming,
    sceneInputHash: continuation.clip.inputHash,
    clipContentHash: continuation.clip.contentHash,
    actions: continuation.actions,
    targetDir: path.join(
      root,
      'showcase',
      'projects',
      recorded.id,
      'scenes',
      continuation.id,
      'artifacts',
    ),
  });

  assert.ok(continuationTiming, 'журнал продолжения читается относительно своего клипа');
  assert.equal(continuationTiming.status, 'calibrated');
  if (continuationTiming.status !== 'calibrated') {
    assert.fail(continuationTiming.calibration.reason);
  }
  assert.ok(continuationTiming.sceneReadyMs > 0, 'готовность продолжения не прижата к нулю');
  assert.equal(continuationTiming.actions[0].kind, 'highlight');
  assert.equal(
    continuationTiming.highlights[0]?.actionIndex,
    0,
    JSON.stringify(continuationTiming),
  );

  // Клипы свежие: повторная запись не находит работы.
  await assert.rejects(
    () => service.startRecording(recorded.id),
    (error) => error.code === 'nothing_to_record',
  );

  // Новый measured-путь не запекает двухсекундную рамку в исходник. Вместо этого
  // журнал сохраняет проверенную геометрию и интервал состояния для монтажа.
  assert.ok(continuationTiming.highlights.length > 0, 'геометрия подсветки опубликована');

  const edited = await service.updateScene(recorded.id, recorded.revision, recorded.scenes[2].id, {
    actions: [{ kind: 'highlight', targetId: 'total' }],
  });
  const second = await waitForJob(service, (await service.startRecording(edited.id)).id, 240_000);

  assert.equal(second.state, 'succeeded', second.error ?? '');

  const after = await service.readProject(edited.id);

  assert.notEqual(after.scenes[0].clip.id, before[0].id, 'голова цепочки переснята вместе с хвостом');
  assert.notEqual(after.scenes[1].clip.id, before[1].id, 'середина цепочки переснята вместе с хвостом');
  assert.notEqual(after.scenes[2].clip.id, before[2].id, 'правленый хвост переснят');
  assert.equal(after.scenes[3].clip.id, before[3].id, 'независимая сцена рядом не тронута');
  await assert.rejects(
    () => service.startRecording(after.id),
    (error) => error.code === 'nothing_to_record',
    'после пересъёмки цепочки все клипы свежие',
  );
});

/**
 * Стенд за входом: без cookie сессии главная уводит на форму, форма принимает
 * учётку POST-ом и ставит cookie. Так выглядит любой рабочий стенд, и запись
 * без входа сняла бы форму вместо экрана.
 */
async function startGatedTarget() {
  const server = http.createServer((request, response) => {
    const authorized = /session=ok/.test(String(request.headers.cookie ?? ''));

    if (request.method === 'POST' && request.url === '/login') {
      let body = '';

      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => {
        const params = new URLSearchParams(body);
        const accepted = params.get('user') === 'demo' && params.get('pass') === 'secret';

        response.writeHead(302, {
          location: accepted ? '/' : '/login',
          ...(accepted ? { 'set-cookie': 'session=ok; Path=/' } : {}),
        });
        response.end();
      });

      return;
    }

    if (request.url === '/login' || !authorized) {
      response.writeHead(request.url === '/login' ? 200 : 302, {
        'content-type': 'text/html; charset=utf-8',
        ...(request.url === '/login' ? {} : { location: '/login' }),
      });
      response.end(`<!doctype html><html lang="ru"><head><meta charset="utf-8"></head><body>
<form method="post" action="/login"><input id="user" name="user"><input id="pass" name="pass" type="password">
<button type="submit">Войти</button></form></body></html>`);

      return;
    }

    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Стенд</title>
<style>body{margin:0;background:#101318;color:#eef;font:16px system-ui}main{padding:40px}</style>
</head><body><main><a href="/logout">Выйти</a>
<h1 data-testid="ready">Экран за входом</h1><button data-testid="run">Запустить</button>
</main></body></html>`);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('запись входит на стенд тестовой учёткой и снимает экран за входом', async (t) => {
  const browserPath = await findBrowser();

  if (!browserPath) {
    t.skip('браузер записи не установлен: это не успешная приёмка, а её отсутствие');

    return;
  }

  const target = await startGatedTarget();

  t.after(() => target.close());

  const { service, root } = await fixture(t, { browserPath, targetOrigin: target.origin });
  const profileDir = path.join(root, 'profiles', 'demo-profile');

  await writeFile(path.join(profileDir, 'showcase', 'target.json'), JSON.stringify({
    version: 1,
    environment: 'read-only',
    project: { record: target.origin, view: target.origin },
    sandbox: null,
    allowedOrigins: [],
    capabilities: ['record', 'login'],
  }), 'utf8');
  await writeFile(path.join(profileDir, 'showcase', 'login.json'), JSON.stringify({
    version: 1,
    url: '/login',
    userSelector: '#user',
    passwordSelector: '#pass',
    submitSelector: 'button[type="submit"]',
    readySelector: 'a[href="/logout"]',
    credentialsRef: 'lib.sh:STAND_USER:STAND_PASS',
  }), 'utf8');
  await writeFile(path.join(profileDir, 'lib.sh'), 'STAND_USER="demo"\nSTAND_PASS=\'secret\'\n', 'utf8');

  let project = await service.createProject({
    ref: { kind: 'project', id: 'demo-profile' },
    profile: 'demo-profile',
    title: 'Запись за входом',
  });

  assert.ok(project.target.scope.capabilities.includes('login'), 'вход объявлен и подтверждён файлом');

  project = await service.addScene(project.id, project.revision, {
    title: 'За входом',
    screenId: 'overview',
    narration: 'Экран за входом.',
    caption: '',
    subtitleText: '',
    startState: null,
    readyCondition: null,
    actions: [{ kind: 'hover', targetId: 'run' }, { kind: 'wait', ms: 400 }],
  });

  const job = await service.startRecording(project.id);
  const finished = await waitForJob(service, job.id);

  assert.equal(finished.state, 'succeeded', finished.error ?? '');

  const recorded = await service.readProject(project.id);

  assert.ok(recorded.scenes[0].clip, 'экран за входом записался, а не форма входа');
  assert.ok(recorded.scenes[0].clip.byteSize > 10_000);
});

/**
 * Стенд, чей экран читает данные POST-ом с API на ДРУГОМ адресе: так устроены
 * сводки и поиск многих SPA. Запрос идёт с заголовком авторизации, поэтому браузер
 * сначала спрашивает preflight (OPTIONS), и только потом отправляет сам POST.
 * Условие готовности экрана появляется лишь после ответа API — блокировка любого
 * из двух запросов оставила бы сцену без готовности.
 */
async function startPostReadingTarget() {
  const api = http.createServer((request, response) => {
    const cors = {
      'access-control-allow-origin': String(request.headers.origin ?? '*'),
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-allow-methods': 'POST, OPTIONS',
    };

    if (request.method === 'OPTIONS') {
      response.writeHead(204, cors);
      response.end();

      return;
    }

    if (request.method === 'POST' && request.url === '/api/summary') {
      response.writeHead(200, { ...cors, 'content-type': 'application/json' });
      response.end(JSON.stringify({ rows: 3 }));

      return;
    }

    response.writeHead(405, cors);
    response.end();
  });

  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));

  const apiOrigin = `http://127.0.0.1:${api.address().port}`;
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Стенд</title>
<style>body{margin:0;background:#101318;color:#eef;font:16px system-ui}main{padding:40px}</style>
</head><body><main><h1 id="title">Сводка</h1><button data-testid="run">Запустить</button>
<script>
fetch('${apiOrigin}/api/summary', {
  method: 'POST',
  headers: { authorization: 'Bearer demo', 'content-type': 'application/json' },
  body: '{}',
}).then((r) => r.json()).then((data) => {
  const p = document.createElement('p');
  p.dataset.testid = 'ready';
  p.textContent = 'строк: ' + data.rows;
  document.querySelector('main').append(p);
});
</script></main></body></html>`);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    apiOrigin,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await new Promise((resolve) => api.close(resolve));
    },
  };
}

test('экран, читающий данные POST-ом с другого адреса, записывается по объявлению цели', async (t) => {
  const browserPath = await findBrowser();

  if (!browserPath) {
    t.skip('браузер записи не установлен: это не успешная приёмка, а её отсутствие');

    return;
  }

  const target = await startPostReadingTarget();

  t.after(() => target.close());

  const { service, root } = await fixture(t, { browserPath, targetOrigin: target.origin });

  await writeFile(path.join(root, 'profiles', 'demo-profile', 'showcase', 'target.json'), JSON.stringify({
    version: 1,
    environment: 'read-only',
    project: { record: target.origin, view: target.origin },
    sandbox: null,
    allowedOrigins: [target.apiOrigin],
    allowedMethods: ['POST'],
    capabilities: ['record'],
  }), 'utf8');

  let project = await service.createProject({
    ref: { kind: 'project', id: 'demo-profile' },
    profile: 'demo-profile',
    title: 'Сводка POST-ом',
  });

  project = await service.addScene(project.id, project.revision, {
    title: 'Сводка',
    screenId: 'overview',
    narration: 'Сводка загружена.',
    caption: '',
    subtitleText: '',
    startState: null,
    readyCondition: null,
    actions: [{ kind: 'hover', targetId: 'run' }, { kind: 'wait', ms: 400 }],
  });

  const job = await service.startRecording(project.id);
  const finished = await waitForJob(service, job.id);

  assert.equal(finished.state, 'succeeded', finished.error ?? '');

  const recorded = await service.readProject(project.id);

  assert.ok(recorded.scenes[0].clip, 'готовность наступила только после ответа API — значит, POST прошёл');
});
