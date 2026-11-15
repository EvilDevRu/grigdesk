import { makeDraft } from '../fixtures/routes-editor.mjs';
import { applyDraftOperations, validateDraftShape }
  from '../../server/src/modules/routes/draftModel.ts';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'routes-cli-home-'));
const CLI_ENV = {
  ...process.env,
  HOME: home,
  GRIGDESK_HOME: path.join(home, 'data'),
};

after(() => fs.rm(home, { recursive: true, force: true }));

const BINARY = process.env.GRIGDESK_ROUTES_TEST_BINARY;
const EXECUTABLE = BINARY || process.execPath;
const PREFIX = BINARY ? [] : [fileURLToPath(new URL('../../routes/src/main.ts', import.meta.url))];

interface Captured {
  url: string;
  method: string;
  token: string | undefined;
  body: Record<string, any> | null;
}

/**
 * Создаёт изолированный HTTP-сервер с захватом точных DTO.
 * Все соединения закрываются после сценария, включая молчащий ответ.
 */
async function stubServer(
  t: test.TestContext,
  handler: (captured: Captured) => unknown,
  { silent = false }: { silent?: boolean } = {},
): Promise<number> {
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];

    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      // Молчащий сервер для проверки таймаута: соединение принято, ответа нет.
      if (silent) {
        return;
      }

      const captured: Captured = {
        url: request.url ?? '',
        method: request.method ?? '',
        token: request.headers['x-grigdesk-token'] as string | undefined,
        body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null,
      };
      const body = handler(captured);

      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(body ?? { ok: true }));
    });
  });
  const sockets = new Set<import('node:net').Socket>();

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  // Открытый слушающий сервер держит event loop: закрываем вместе с сокетами,
  // иначе файл теста не завершится (сторож времени не ограничивает).
  t.after(() => new Promise<void>((resolve) => {
    for (const socket of sockets) {
      socket.destroy();
    }


    server.close(() => resolve());
  }));

  return (server.address() as { port: number }).port;
}

test('RE-C1-01: list печатает JSON и несёт CLI-токен', async (t) => {
  const captured: Captured[] = [];
  const port = await stubServer(t, (request) => {
    captured.push(request);

    return { drafts: [] };
  });
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'routes-cli-'));
  const tokenFile = path.join(temporary, 'cli-token');

  t.after(() => fs.rm(temporary, { recursive: true, force: true }));

  await fs.writeFile(tokenFile, `secret-${port}\n`, { mode: 0o600 });

  const { stdout } = await exec(EXECUTABLE, [...PREFIX, 'list', 'demo'], {
    env: {
      ...CLI_ENV,
      GRIGDESK_BASE_URL: '',
      GRIGDESK_PORT: String(port),
      GRIGDESK_CLI_TOKEN_PATH: tokenFile,
      GRIGDESK_CLI_TOKEN: '',
    },
  });
  const parsed = JSON.parse(stdout);

  assert.equal(parsed.drafts.length, 0);
  assert.equal(captured[0]!.url, '/api/routes/demo/drafts');
  assert.equal(captured[0]!.token, `secret-${port}`);
});

test('RE-C1-02: недоступный сервер даёт код 3 и сообщение', async () => {
  await assert.rejects(
    exec(EXECUTABLE, [...PREFIX, 'list', 'demo'], {
      env: {
        ...CLI_ENV,
        GRIGDESK_BASE_URL: '',
        GRIGDESK_PORT: '1',
        GRIGDESK_CLI_TOKEN: 'x'
      },
    }),
    (error: { code: number; stderr: string }) => error.code === 3
      && /недоступен/.test(error.stderr),
  );
});

test('RE-C1-03: молчащий сервер прерывается по таймауту с кодом 3', async (t) => {
  const port = await stubServer(t, () => ({ ok: true }), { silent: true });

  await assert.rejects(
    exec(EXECUTABLE, [...PREFIX, 'list', 'demo', '--timeout', '500'], {
      env: {
        ...CLI_ENV,
        GRIGDESK_BASE_URL: '',
        GRIGDESK_PORT: String(port),
        GRIGDESK_CLI_TOKEN: 'x'
      },
    }),
    (error: { code: number; stderr: string }) => error.code === 3
      && /таймаут|недоступен/.test(error.stderr),
  );
});

test('RE-C1-04: 404 от сервера даёт код 2', async (t) => {
  const server = http.createServer((_request, response) => {
    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'routes_draft_not_found' }));
  });
  const sockets = new Set<import('node:net').Socket>();

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });


  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
  });


  t.after(() => new Promise<void>((resolve) => {
    for (const socket of sockets) {
      socket.destroy();
    }


    server.close(() => resolve());
  }));

  await assert.rejects(
    exec(EXECUTABLE, [...PREFIX, 'list', 'demo'], {
      env: {
        ...CLI_ENV,
        GRIGDESK_BASE_URL: '',
        GRIGDESK_PORT: String(port),
        GRIGDESK_CLI_TOKEN: 'x'
      },
    }),
    (error: { code: number }) => error.code === 2,
  );
});

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const CLI_DRAFT_ID = '11111111-1111-4111-8111-111111111111';
const CLI_COPY_ID = '22222222-2222-4222-8222-222222222222';

/**
 * Перепривязывает весь независимый fixture, сохраняя UUID и парный profile-контракт.
 * Ошибка подготовки выявляется до CLI: она не может служить поведенческим RED.
 */
function cliDraft(id = CLI_DRAFT_ID, revision = 7) {
  const draft = makeDraft();


  draft.id = id;
  draft.profile = 'demo';
  draft.revision = revision;
  draft.bootstrap.profile = 'demo';

  for (const bundle of Object.values(draft.routes)) {
    bundle.route.profile = 'demo';
  }

  return validateDraftShape(draft);
}

/**
 * Строгий HTTP-double проверяет парный контракт, CAS и последовательность эффектов.
 * Изменение контента выполняет настоящий draftModel, а не permissive ok-ответ.
 */
async function authoringServer(t: test.TestContext, options: {
  mode?: 'editor' | 'profile-script';
  dropPublish?: boolean;
} = {}) {
  const state = {
    draft: cliDraft(),
    mode: options.mode ?? 'editor',
    sourceRevision: 3,
    currentHash: HASH_A as string | null,
    requests: [] as Captured[],
    receipts: new Map<string, Record<string, unknown>>(),
    publishes: 0,
    creates: 0,
  };
  const errors: unknown[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];

    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const reply = (status: number, value: unknown) => {
        response.statusCode = status;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(value));
      };

      try {
        const item: Captured = {
          url: request.url ?? '',
          method: request.method ?? '',
          token: request.headers['x-grigdesk-token'] as string | undefined,
          body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null,
        };

        state.requests.push(item);
        assert.equal(item.token, 'fixture-token');

        if (item.method === 'GET' && item.url === '/api/routes/demo/editor') {
          reply(200, {
            profile: 'demo',
            source: {
            mode: state.mode, revision: state.sourceRevision,
          },
            currentCatalogHash: state.currentHash
          });

          return;
        }

        if (item.method === 'PUT' && item.url === '/api/routes/demo/editor/source') {
          assert.deepEqual(Object.keys(item.body!).sort(),
            ['expectedCatalogHash', 'expectedSourceRevision', 'mode']);

          if (item.body!.expectedSourceRevision !== state.sourceRevision
            || item.body!.expectedCatalogHash !== state.currentHash) {
            reply(409, { error: 'routes_source_conflict' });

            return;
          }

          assert.ok(['editor', 'profile-script'].includes(item.body!.mode));
          state.mode = item.body!.mode;
          state.sourceRevision += 1;
          reply(200, { source: { mode: state.mode, revision: state.sourceRevision } });

          return;
        }

        if (item.method === 'POST' && item.url === '/api/routes/demo/drafts') {
          assert.ok(['empty', 'catalog'].includes(item.body!.kind));
          assert.deepEqual(Object.keys(item.body!).sort(), item.body!.kind === 'empty'
            ? ['kind', 'title'] : ['catalogHash', 'kind', 'title']);
          state.creates += 1;
          state.draft = cliDraft(CLI_COPY_ID, 1);
          reply(200, state.draft);

          return;
        }

        const base = `/api/routes/demo/drafts/${state.draft.id}`;

        if (item.method === 'GET' && item.url === base) {
          reply(200, state.draft);

          return;
        }

        if (item.method === 'PATCH' && item.url === base) {
          assert.deepEqual(Object.keys(item.body!).sort(), ['expectedRevision', 'operations']);

          if (item.body!.expectedRevision !== state.draft.revision) {
            reply(409, { error: 'routes_revision_conflict' });

            return;
          }

          state.draft = { ...applyDraftOperations(state.draft, item.body!.operations),
            revision: state.draft.revision + 1 };
          reply(200, state.draft);

          return;
        }

        if (item.method === 'POST' && item.url === `${base}/publish`) {
          const body = item.body!;

          assert.deepEqual(Object.keys(body).sort(), [
            'expectedCatalogHash', 'expectedRevision', 'expectedSourceRevision', 'operationId',
          ]);
          assert.match(body.operationId, /^[0-9a-f-]{36}$/);

          if (state.mode !== 'editor' || body.expectedRevision !== state.draft.revision
            || body.expectedSourceRevision !== state.sourceRevision
            || body.expectedCatalogHash !== state.currentHash) {
            reply(409, { error: 'routes_source_conflict' });

            return;
          }

          state.publishes += 1;


          const receipt = {
            operationId: body.operationId,
            requestHash: 'c'.repeat(64),
            draftId: state.draft.id,
            draftRevision: body.expectedRevision,
            fromCatalogHash: body.expectedCatalogHash,
            toCatalogHash: HASH_B,
            sourceRevision: body.expectedSourceRevision,
            state: 'committed',
            currentChanged: true,
            createdAt: '2026-11-14T00:00:00.000Z',
          };

          state.receipts.set(body.operationId, receipt);

          if (options.dropPublish) {
            response.destroy();
          } else {
            reply(200, receipt);
          }

          return;
        }

        const prefix = '/api/routes/demo/publications/';

        if (item.method === 'GET' && item.url.startsWith(prefix)) {
          const receipt = state.receipts.get(item.url.slice(prefix.length));

          reply(receipt ? 200 : 404, receipt ?? { error: 'not_found' });

          return;
        }

        throw new Error(`Неожиданный запрос ${item.method} ${item.url}`);
      } catch (error) {
        errors.push(error);
        reply(500, { error: 'fixture_contract_failed' });
      }
    });
  });
  const sockets = new Set<import('node:net').Socket>();

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }

    await new Promise<void>((resolve) => server.close(() => resolve()));
    assert.deepEqual(errors, []);
  });

  const port = (server.address() as { port: number }).port;
  const env = {
    ...CLI_ENV,
    GRIGDESK_BASE_URL: '',
    GRIGDESK_PORT: String(port),
    GRIGDESK_CLI_TOKEN: 'fixture-token'
  };

  return { state, run: (args: string[]) => exec(EXECUTABLE, [...PREFIX, ...args], { env }) };
}

/**
 * Сохраняет редактируемый снимок в независимый временный файл.
 * Cleanup регистрируется до записи и работает при неуспехе сценария.
 */
async function contentFile(t: test.TestContext, content: unknown) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'routes-content-'));
  const file = path.join(directory, 'document.json');

  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(file, JSON.stringify(content));

  return file;
}

function publicationFlags(sourceRevision = 3) {
  return ['--expected-revision', '7', '--expected-source-revision', String(sourceRevision),
    '--expected-catalog-hash', HASH_A];
}

test('RE-C2-01: apply заменяет контент, удаляет маршрут и сохраняет исходную ревизию', async (t) => {
  const { state, run } = await authoringServer(t);


  state.draft.routes.other = structuredClone(state.draft.routes.quick!);
  state.draft.routes.other!.route.id = 'other';


  const content = JSON.parse((await run(['show', 'demo', '--draft', CLI_DRAFT_ID])).stdout);

  delete content.routes.other;
  content.routes.quick.route.nodes[0].label = 'Новая подпись';


  const file = await contentFile(t, content);

  await run(['apply', 'demo', '--draft', CLI_DRAFT_ID, '--file', file, '--expected-revision', '7']);


  const after = JSON.parse((await run(['show', 'demo', '--draft', CLI_DRAFT_ID])).stdout);

  assert.deepEqual(Object.keys(after.routes), ['quick']);
  assert.equal(after.routes.quick.route.nodes[0].label, 'Новая подпись');
  assert.deepEqual(after.presentation, content.presentation);
  assert.equal(after.revision, 8);
  assert.equal(state.requests.find((item) => item.method === 'PATCH')!.body!.expectedRevision, 7);
});

test('RE-C2-02: publish без yes не вызывает сервер, подтверждённый передаёт snapshot', async (t) => {
  const { state, run } = await authoringServer(t);

  await assert.rejects(run(['publish', 'demo', '--draft', CLI_DRAFT_ID, ...publicationFlags()]),
    (error: any) => error.code === 1 && /--yes/.test(error.stderr));
  assert.equal(state.requests.length, 0);

  const { stdout, stderr } = await run([
    'publish', 'demo', '--draft', CLI_DRAFT_ID, ...publicationFlags(), '--yes',
  ]);
  const hint = JSON.parse(stderr.trim());
  const receipt = JSON.parse(stdout);

  assert.equal(receipt.operationId, hint.operationId);
  assert.equal(hint.draftId, CLI_DRAFT_ID);
  assert.equal(state.publishes, 1);
});

test('RE-C2-03: read7, чужой save8, apply7 дают конфликт без записи', async (t) => {
  const { state, run } = await authoringServer(t);
  const old = JSON.parse((await run(['show', 'demo', '--draft', CLI_DRAFT_ID])).stdout);
  const file = await contentFile(t, old);

  state.draft.revision = 8;
  state.draft.routes.quick!.route.nodes[0]!.label = 'Правка человека';


  const before = structuredClone(state.draft);

  await assert.rejects(run([
    'apply', 'demo', '--draft', CLI_DRAFT_ID, '--file', file, '--expected-revision', '7',
  ]), (error: any) => error.code === 4);
  assert.deepEqual(state.draft, before);
  assert.equal(state.requests.filter((item) => item.method === 'PATCH').length, 0);
});

test('RE-C2-04: rollback создаёт копию ревизии и публикует с исходным current/source', async (t) => {
  const { state, run } = await authoringServer(t);

  await run(['rollback', 'demo', '--hash', HASH_B, '--yes',
    '--expected-source-revision', '3', '--expected-catalog-hash', HASH_A]);
  assert.deepEqual(state.requests.find((item) => item.url.endsWith('/drafts'))!.body, {
    kind: 'catalog',
    title: 'rollback-bbbbbbbb',
    catalogHash: HASH_B,
  });


  const published = state.requests.find((item) => item.url.endsWith('/publish'))!.body!;

  assert.equal(published.expectedRevision, 1);
  assert.equal(published.expectedCatalogHash, HASH_A);
  assert.equal(published.expectedSourceRevision, 3);
});

test('RE-C2-05: new передаёт точные тела empty и catalog', async (t) => {
  const { state, run } = await authoringServer(t);

  await run(['new', 'demo', '--title', 'копия']);
  await run(['new', 'demo', '--from', 'empty', '--title', 'пустой']);
  assert.deepEqual(state.requests.filter((item) => item.method === 'POST')
    .map((item) => item.body), [
    {
      kind: 'catalog',
      title: 'копия',
      catalogHash: HASH_A
    },
    { kind: 'empty', title: 'пустой' },
  ]);
});

test('RE-C2-06: publish и rollback после обрыва дают ID для чтения прежнего receipt', async (t) => {
  for (const command of ['publish', 'rollback']) {
    await t.test(command, async (t) => {
      const { state, run } = await authoringServer(t, { dropPublish: true });
      const args = command === 'publish'
        ? ['publish', 'demo', '--draft', CLI_DRAFT_ID, ...publicationFlags(), '--yes']
        : ['rollback', 'demo', '--hash', HASH_B, '--yes',
          '--expected-source-revision', '3', '--expected-catalog-hash', HASH_A];
      let hint: any;

      await assert.rejects(run(args), (error: any) => {
        try {
          hint = JSON.parse(error.stderr.split('\n')[0]);
        } catch {
          hint = {};
        }

        return error.code === 3 && typeof hint.operationId === 'string';
      });


      const recovered = JSON.parse((await run(hint.recovery)).stdout);

      assert.equal(recovered.operationId, hint.operationId);
      assert.equal(recovered.state, 'committed');
      assert.equal(state.publishes, 1);
      assert.equal(state.creates, command === 'rollback' ? 1 : 0);
    });
  }
});

test('RE-C2-07: profile-script требует явного source; старый source snapshot получает 409', async (t) => {
  const { state, run } = await authoringServer(t, { mode: 'profile-script' });
  const change = ['source', 'demo', '--mode', 'editor',
    '--expected-source-revision', '3', '--expected-catalog-hash', HASH_A];

  await assert.rejects(run(change), (error: any) => error.code === 1);
  assert.equal(state.requests.length, 0);
  await assert.rejects(run(['publish', 'demo', '--draft', CLI_DRAFT_ID,
    ...publicationFlags(), '--yes']), (error: any) => error.code === 4);
  assert.equal(state.mode, 'profile-script');
  assert.equal(state.publishes, 0);

  await run([...change, '--yes']);
  assert.equal(state.mode, 'editor');
  assert.equal(state.sourceRevision, 4);
  await assert.rejects(run([...change, '--yes']), (error: any) => error.code === 4);
  await run(['publish', 'demo', '--draft', CLI_DRAFT_ID, ...publicationFlags(4), '--yes']);
  assert.equal(state.publishes, 1);
});

test('RE-C2-08: apply без основания и с неполным JSON не имеет побочных эффектов', async (t) => {
  const { state, run } = await authoringServer(t);
  const file = await contentFile(t, { routes: {} });

  await assert.rejects(run(['apply', 'demo', '--draft', CLI_DRAFT_ID, '--file', file]),
    (error: any) => error.code === 1);
  await assert.rejects(run(['apply', 'demo', '--draft', CLI_DRAFT_ID, '--file', file,
    '--expected-revision', '7']), (error: any) => error.code === 1);
  assert.equal(state.requests.length, 0);
});

/**
 * Создаёт два маленьких, но предельных по количеству каталога с непересекающимися ID.
 * Bootstrap ссылается на свой каталог; обе стороны проходят реальный shape-контракт.
 */
function fullCliDraft(prefix: string) {
  const draft = cliDraft();
  const template = draft.routes.quick!;
  const ids = Array.from({ length: 64 }, (_, index) => `${prefix}_${index}`);

  draft.routes = Object.fromEntries(ids.map((id) => {
    const bundle = structuredClone(template);


    bundle.route.id = id;

    return [id, bundle];
  }));
  draft.bootstrap.nodes[0]!.on!.done = { escalate: { routes: [ids[0]!] } };
  draft.bootstrap.escalation = [{
    from: 'scout',
    allowedRoutes: [ids[0]!],
    requiresHumanWhenPinned: true
  }];
  draft.presentation = { [`r:${ids[0]}:build`]: { x: 250, y: 80 } };
  draft.provenance = { fixture: prefix };

  return validateDraftShape(draft);
}

test('RE-C2-10: полная замена 64 непересекающихся маршрутов проходит одним CAS PATCH', async (t) => {
  const { state, run } = await authoringServer(t);


  state.draft = fullCliDraft('old');


  const previous = JSON.parse((await run(['show', 'demo', '--draft', CLI_DRAFT_ID])).stdout);
  const next = fullCliDraft('new');
  const file = await contentFile(t, next);
  const result = JSON.parse((await run(['apply', 'demo', '--draft', CLI_DRAFT_ID,
    '--file', file, '--expected-revision', String(previous.revision)])).stdout);

  assert.equal(result.revision, 8);


  for (const field of ['routes', 'bootstrap', 'bootstrapPrompts', 'presentation', 'provenance'] as const) {
    assert.deepEqual(result[field], next[field]);
  }

  const patches = state.requests.filter((request) => request.method === 'PATCH');


  assert.equal(patches.length, 1);
  assert.equal(patches[0]!.body!.expectedRevision, 7);
  assert.equal(patches[0]!.body!.operations.length, 131);
  assert.equal(patches[0]!.body!.operations.filter((op: any) => op.kind === 'removeRoute').length, 64);
  assert.equal(patches[0]!.body!.operations.filter((op: any) => op.kind === 'putRoute').length, 64);
});

test('RE-C2-09: validate, export и import используют точные DTO и возвращают ответ', async (t) => {
  const requests: Captured[] = [];
  const bundle = { schema: 1, fixture: 'transfer' };
  const port = await stubServer(t, (request) => {
    requests.push(request);

    return { fixtureResponse: requests.length };
  });
  const env = {
    ...CLI_ENV,
    GRIGDESK_BASE_URL: '',
    GRIGDESK_PORT: String(port),
    GRIGDESK_CLI_TOKEN: 'fixture-token'
  };
  const file = await contentFile(t, bundle);
  const commands = [
    ['validate', 'demo', '--draft', CLI_DRAFT_ID, '--expected-revision', '7'],
    ['export', 'demo', '--draft', CLI_DRAFT_ID],
    ['import', 'demo', '--file', file, '--title', 'копия'],
  ];

  for (const [index, args] of commands.entries()) {
    const result = await exec(EXECUTABLE, [...PREFIX, ...args], { env });

    assert.deepEqual(JSON.parse(result.stdout), { fixtureResponse: index + 1 });
  }

  assert.deepEqual(requests.map(({ method, url, body }) => ({
    method,
    url,
    body
  })), [
    {
      method: 'POST',
      url: `/api/routes/demo/drafts/${CLI_DRAFT_ID}/validate`,
      body: { expectedRevision: 7 }
    },
    {
      method: 'GET',
      url: `/api/routes/demo/drafts/${CLI_DRAFT_ID}/transfer`,
      body: null
    },
    {
      method: 'POST',
      url: '/api/routes/demo/editor/import',
      body: { title: 'копия', bundle }
    },
  ]);
});

test('RE-C3-01: profile-config set применяет изменения с фактическими from', async (t) => {
  const requests: Array<{ url: string; body: unknown }> = [];
  const port = await stubServer(t, (captured) => {
    if (captured.method === 'PATCH') {
      requests.push({ url: captured.url, body: captured.body });
    }

    return captured.method === 'GET'
      ? {
        profile: 'demo',
        variables: { profileSh: [
        {
          name: 'PROFILE_LOOP_MAX_ROUNDS',
          value: '20',
          literal: true,
          editable: true,
          present: true,
          reason: null
        },
      ], dashboard: [] },
        runners: {},
        capabilities: []
      }
      : {
        profile: 'demo',
        file: 'profile.sh',
        variables: []
      };
  });

  const { stdout } = await exec(EXECUTABLE,
    [...PREFIX, 'profile-config', 'set', 'demo', '--file', 'profile.sh',
      '--set', 'PROFILE_LOOP_MAX_ROUNDS=40'], {
      env: {
        ...CLI_ENV,
        GRIGDESK_BASE_URL: '',
        GRIGDESK_PORT: String(port),
        GRIGDESK_CLI_TOKEN: 'x'
      },
    });

  assert.equal(JSON.parse(stdout).profile, 'demo');
  assert.equal(requests[0]!.url, '/api/profiles/demo/variables');
  assert.deepEqual(requests[0]!.body, {
    file: 'profile.sh',
    changes: [{
      name: 'PROFILE_LOOP_MAX_ROUNDS',
      from: '20',
      to: '40'
    }],
  });
});

test('RE-C3-02: readonly не трактуется как отсутствие, missing editable создаётся', async (t) => {
  const patches: unknown[] = [];
  const port = await stubServer(t, (request) => {
    if (request.method === 'PATCH') {
      patches.push(request.body);


      return { variables: [] };
    }

    return {
      profile: 'demo',
      variables: { profileSh: [
      {
        name: 'PROFILE_CTX',
        value: null,
        literal: false,
        editable: false,
        present: true,
        reason: 'not_literal_metadata'
      },
      {
        name: 'PROFILE_LOOP_MAX_ROUNDS',
        value: null,
        literal: false,
        editable: true,
        present: false,
        reason: 'not_declared'
      },
    ], dashboard: [] },
      runners: {},
      capabilities: []
    };
  });
  const env = {
    ...CLI_ENV,
    GRIGDESK_BASE_URL: '',
    GRIGDESK_PORT: String(port),
    GRIGDESK_CLI_TOKEN: 'fixture-token'
  };
  const run = (assignment: string) => exec(EXECUTABLE,
    [...PREFIX, 'profile-config', 'set', 'demo', '--set', assignment], { env });

  await assert.rejects(run('PROFILE_CTX=replacement'), (error: any) => error.code === 1);
  assert.deepEqual(patches, []);
  await run('PROFILE_LOOP_MAX_ROUNDS=40');
  assert.deepEqual(patches, [{ file: 'profile.sh', changes: [
    {
      name: 'PROFILE_LOOP_MAX_ROUNDS',
      from: null,
      to: '40'
    },
  ] }]);
});
