// Граница раздела «Презентации» в HTTP: раздел открывает браузер по адресу стенда,
// синтезирует речь у внешнего поставщика и складывает видео, поэтому ручки открыты
// только СЕССИИ человека и только при включённом плагине. CLI-токен агента сюда не
// пускается: у агента остаётся обычный Bash со своими правилами подтверждения.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

import showcaseModule from '../../server/src/modules/showcase/index.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

const PROJECT_ID = '0123456789abcdef';

const OVERVIEW = {
  targets: [{
    ref: { kind: 'project', id: 'demo-profile' },
    profile: 'demo-profile',
    label: 'demo-profile · постоянный стенд',
    viewUrl: 'http://127.0.0.1:5173',
    viewPort: null,
    status: 'ready',
    reason: '',
    screenCount: 0,
  }],
  profiles: [{ id: 'demo-profile', ready: true, reason: '' }],
  projects: [],
  jobs: [],
  limits: {
    maxScenes: 20,
    maxSceneSeconds: 120,
    maxTotalSeconds: 600,
    retentionDays: 30,
  },
};

function serviceStub(overrides = {}) {
  const calls = [];

  return {
    calls,
    overview: async () => OVERVIEW,
    doctor: async (ref, profile) => {
      calls.push(['doctor', ref ?? null, profile ?? null]);

      return { operations: [], checkedAt: new Date().toISOString() };
    },
    createProject: async (input) => {
      calls.push(['create', input]);

      return { id: PROJECT_ID, title: input.title ?? '' };
    },
    readProject: async (id) => {
      calls.push(['read', id]);

      return { id };
    },
    renameProject: async (id, revision, title) => {
      calls.push(['rename', id, revision, title]);

      return { id, revision: revision + 1, title };
    },
    deleteProject: async (id) => {
      calls.push(['delete', id]);
    },
    cancelJob: async (id) => {
      calls.push(['cancel', id]);

      return { id, state: 'cancelling' };
    },
    setVoice: async (id, revision, choice) => {
      calls.push(['set-voice', id, revision, choice]);

      return { id, revision: revision + 1 };
    },
    previewVoice: async (voiceRef) => {
      calls.push(['preview', voiceRef]);

      throw Object.assign(new Error('движок не установлен'), {
        code: 'voice_unavailable',
        status: 503,
      });
    },
    targets: {
      resolveSelected: async (ref) => {
        calls.push(['resolve', ref]);

        return { status: 'blocked', ref, profile: null, reason: 'нет стенда', nextAction: null };
      },
    },
    jobs: {
      read: (id) => {
        calls.push(['job', id]);

        return {
          id,
          projectId: PROJECT_ID,
          kind: 'record',
          state: 'running',
          attempt: 1,
          sequence: 2,
          progress: { index: 1, total: 3, label: 'пишем сцену' },
          error: null,
          startedAt: new Date().toISOString(),
          finishedAt: null,
          idempotencyKey: 'inputs-v1',
          inputHashes: { scenes: 'hash-1' },
          inputRevision: 1,
          deadlineAt: new Date().toISOString(),
          heartbeatAt: null,
          identity: { pid: 4242, starttime: '111', cmdline: 'showcaseWorker' },
        };
      },
    },
    ...overrides,
  };
}

async function fixture(t, { authKind = 'session', enabled = true, service = serviceStub() } = {}) {
  const app = Fastify({ logger: false });

  app.decorate('pluginEnabled', () => enabled);
  app.addHook('onRequest', async (request) => {
    request.authKind = authKind;
  });
  await app.register(showcaseModule, { service });
  t.after(() => app.close());

  return { app, service };
}

const REQUESTS = [
  ['GET', '/api/showcase', undefined],
  ['GET', `/api/showcase/${PROJECT_ID}`, undefined],
  ['GET', '/api/showcase/doctor', undefined],
  ['POST', '/api/showcase', { kind: 'project', id: 'demo-profile' }],
  ['PUT', `/api/showcase/${PROJECT_ID}`, { expectedRevision: 1, title: 'Ролик' }],
  ['DELETE', `/api/showcase/${PROJECT_ID}`, undefined],
  ['POST', '/api/showcase/jobs/0123456789abcdef/cancel', {}],
  // Установка голоса скачивает и запускает код на машине человека: агенту и
  // выключенному плагину она закрыта тем же гардом, что и остальное.
  ['POST', '/api/showcase/voices/install', { voiceId: 'irina' }],
  ['POST', '/api/showcase/voices/install/cancel', {}],
];

test('токен агента в раздел не пускается — это действия человека', async (t) => {
  const { app, service } = await fixture(t, { authKind: 'cli' });

  for (const [method, url, payload] of REQUESTS) {
    const response = await app.inject({ method, url, payload });

    assert.equal(response.statusCode, 403, `${method} ${url}`);
    assert.equal(response.json().error, 'session_required', `${method} ${url}`);
  }

  assert.deepEqual(service.calls, []);
});

test('выключенный плагин закрывает раздел целиком, включая doctor', async (t) => {
  const { app, service } = await fixture(t, { enabled: false });

  for (const [method, url, payload] of REQUESTS) {
    const response = await app.inject({ method, url, payload });

    assert.equal(response.statusCode, 403, `${method} ${url}`);
    assert.equal(response.json().error, 'plugin_disabled', `${method} ${url}`);
  }

  assert.deepEqual(service.calls, []);
});

test('обзор отдаёт профили, ролики, задания и пределы одним ответом', async (t) => {
  const { app } = await fixture(t);
  const response = await app.inject({ method: 'GET', url: '/api/showcase' });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), OVERVIEW);
});

test('цель выбирается без профиля, а чужая форма отклоняется до файлов', async (t) => {
  const { app, service } = await fixture(t);
  const bad = [
    ['/api/showcase/target?kind=неизвестно&id=1', 'bad_target'],
    ['/api/showcase/target?kind=sandbox&id=../../etc', 'bad_target'],
    ['/api/showcase/target?kind=sandbox&id=0', 'bad_target'],
  ];

  for (const [url, error] of bad) {
    const response = await app.inject({ method: 'GET', url });

    assert.equal(response.statusCode, 400, url);
    assert.equal(response.json().error, error, url);
  }

  assert.deepEqual(service.calls, []);
});

test('резолвер сам определяет профиль выбранной цели', async (t) => {
  const { app, service } = await fixture(t);
  const response = await app.inject({
    method: 'GET',
    url: '/api/showcase/target?kind=project&id=demo-profile',
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(service.calls, [['resolve', { kind: 'project', id: 'demo-profile' }]]);
});

test('создание принимает выбранную цель без клиентского профиля', async (t) => {
  const { app, service } = await fixture(t);
  const bad = [
    [{ kind: 'sandbox', id: 'не-число' }, 'bad_target'],
    [{ kind: 'task', id: '990001' }, 'bad_target'],
    [{ title: 'Без цели' }, 'bad_target'],
  ];

  for (const [payload, error] of bad) {
    const response = await app.inject({ method: 'POST', url: '/api/showcase', payload });

    assert.equal(response.statusCode, 400, JSON.stringify(payload));
    assert.equal(response.json().error, error, JSON.stringify(payload));
  }

  assert.deepEqual(service.calls, []);

  const ok = await app.inject({
    method: 'POST',
    url: '/api/showcase',
    payload: {
      kind: 'sandbox',
      id: '990001',
      profile: 'подменённый-профиль',
      title: 'Ролик',
    },
  });

  assert.equal(ok.statusCode, 201);
  assert.deepEqual(service.calls[0], ['create', {
    ref: { kind: 'sandbox', id: '990001' },
    title: 'Ролик',
  }]);
});

test('правка без ожидаемой редакции не принимается', async (t) => {
  const { app, service } = await fixture(t);
  const response = await app.inject({
    method: 'PUT',
    url: `/api/showcase/${PROJECT_ID}`,
    payload: { title: 'Без редакции' },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, 'bad_revision');
  assert.deepEqual(service.calls, []);
});

test('конфликт редакций доходит до клиента как 409 с текстом сервера', async (t) => {
  const conflict = Object.assign(new Error('Ролик изменился в другом месте: сейчас редакция 4.'), {
    code: 'revision_conflict',
    status: 409,
  });
  const { app } = await fixture(t, {
    service: serviceStub({
      renameProject: async () => {
        throw conflict;
      },
    }),
  });
  const response = await app.inject({
    method: 'PUT',
    url: `/api/showcase/${PROJECT_ID}`,
    payload: { expectedRevision: 1, title: 'Моя правка' },
  });

  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error, 'revision_conflict');
  assert.match(response.json().message, /редакция 4/);
});

test('чужое исключение не выносит наружу свой текст', async (t) => {
  const { app } = await fixture(t, {
    service: serviceStub({
      overview: async () => {
        throw new Error('ENOENT: /home/user/.state/showcase/projects');
      },
    }),
  });
  const response = await app.inject({ method: 'GET', url: '/api/showcase' });

  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.json(), { error: 'showcase_error' });
});

test('идентификатор ролика проверяется по форме, а не подставляется в путь', async (t) => {
  const { app, service } = await fixture(t);
  const badShape = ['короткий', 'ABCDEF0123456789', 'ролик-с-дефисом'];

  for (const id of badShape) {
    const response = await app.inject({ method: 'GET', url: `/api/showcase/${id}` });

    assert.equal(response.statusCode, 400, id);
    assert.equal(response.json().error, 'bad_id', id);
  }

  // Проверка общая для всех путей с идентификатором, а не переписанная в каждой
  // ручке: забытая в новой ручке копия и была бы той самой дырой.
  const routes = [
    ['GET', `/api/showcase/${'ролик-с-дефисом'}/seed`],
    ['POST', `/api/showcase/${'ролик-с-дефисом'}/record`],
    ['GET', `/api/showcase/${'ролик-с-дефисом'}/artifacts/abcdef0123456789`],
    ['GET', '/api/showcase/jobs/ЗАДАНИЕ'],
  ];

  for (const [method, url] of routes) {
    const response = await app.inject({ method, url });

    assert.equal(response.statusCode, 400, url);
    assert.equal(response.json().error, 'bad_id', url);
  }

  // Обход каталога до обработчика вообще не доходит: маршрутизатор сам не находит
  // такого пути. Проверяется не код ответа, а то, что служба его не увидела —
  // именно она открывает файлы ролика.
  for (const id of ['..', '%2e%2e%2fetc', '..%2f..%2fetc']) {
    const response = await app.inject({ method: 'GET', url: `/api/showcase/${id}` });

    assert.ok(response.statusCode >= 400, id);
  }

  assert.deepEqual(service.calls, []);
});

test('состояние задания отдаётся сводкой без входов и identity процесса', async (t) => {
  const { app } = await fixture(t);
  const response = await app.inject({ method: 'GET', url: `/api/showcase/jobs/${PROJECT_ID}` });
  const body = response.body;

  assert.equal(response.statusCode, 200);
  assert.ok(!body.includes('inputs-v1'), 'ключ повтора наружу не уходит');
  assert.ok(!body.includes('showcaseWorker'), 'командная строка исполнителя наружу не уходит');
  assert.ok(!body.includes('4242'), 'номер процесса наружу не уходит');
  assert.match(body, /пишем сцену/);
});

test('выбор голоса проверяет редакцию, темп и ссылку до обращения к службе', async (t) => {
  const { app, service } = await fixture(t);
  const url = `/api/showcase/${PROJECT_ID}/voice`;

  const noRevision = await app.inject({ method: 'PUT', url, payload: { voiceRef: 'piper:irina' } });

  assert.equal(noRevision.json().error, 'bad_revision');

  const badPace = await app.inject({
    method: 'PUT',
    url,
    payload: { expectedRevision: 1, voiceRef: 'piper:irina', pace: 'быстро' },
  });

  assert.equal(badPace.json().error, 'bad_pace');

  const badRef = await app.inject({
    method: 'PUT',
    url,
    payload: { expectedRevision: 1, voiceRef: 42 },
  });

  assert.equal(badRef.json().error, 'bad_voice_ref');
  assert.deepEqual(service.calls, [], 'служба не трогается, пока форма запроса неверна');

  const accepted = await app.inject({
    method: 'PUT',
    url,
    payload: { expectedRevision: 1, voiceRef: 'silero:xenia', pace: 'slow' },
  });

  assert.equal(accepted.statusCode, 200);
  assert.deepEqual(service.calls, [
    ['set-voice', PROJECT_ID, 1, { voiceRef: 'silero:xenia', pace: 'slow' }],
  ]);
});

test('образец голоса требует ссылку и отдаёт отказ движка своим кодом', async (t) => {
  const { app } = await fixture(t);
  const empty = await app.inject({ method: 'GET', url: '/api/showcase/voices/preview' });

  assert.equal(empty.statusCode, 400);
  assert.equal(empty.json().error, 'bad_voice_ref');

  const blocked = await app.inject({
    method: 'GET',
    url: '/api/showcase/voices/preview?voiceRef=silero:xenia',
  });

  assert.equal(blocked.statusCode, 503);
  assert.equal(blocked.json().error, 'voice_unavailable');
});
