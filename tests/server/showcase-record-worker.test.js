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
  if (process.env.COCKPIT_SHOWCASE_BROWSER) {
    return process.env.COCKPIT_SHOWCASE_BROWSER;
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

async function fixture(t, { browserPath, targetOrigin }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'showcase-worker-'));

  t.after(() => rm(root, { recursive: true, force: true }));

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
  await writeFile(path.join(contractDir, 'screens.json'), JSON.stringify(SCREENS_CONTRACT), 'utf8');

  const service = createShowcaseService({
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
async function waitForJob(service, jobId, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await service.pollWorkers();

    const job = service.jobs.read(jobId);

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

  const { service } = await fixture(t, { browserPath, targetOrigin: target.origin });
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

  assert.deepEqual(project.scenes.map((scene) => scene.stale), [true, true]);

  const job = await service.startRecording(project.id);
  const finished = await waitForJob(service, job.id);

  assert.equal(finished.state, 'succeeded', finished.error ?? '');

  const recorded = await service.readProject(project.id);

  for (const scene of recorded.scenes) {
    assert.ok(scene.clip, `у сцены «${scene.title}» обязан появиться клип`);
    assert.ok(scene.clip.byteSize > 10_000, 'клип не должен быть пустышкой');
    assert.ok((scene.clip.durationMs ?? 0) > 200, 'клип короче четверти секунды записью не считается');
  }

  // Повторный запуск не переснимает свежие сцены: ровно ради этого свежесть и
  // считается хешами входов.
  await assert.rejects(
    () => service.startRecording(project.id),
    (error) => error.code === 'nothing_to_record',
  );
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
