import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  applyCredentialValues,
  credentialViews,
  declaredCredentials,
  envFileNames,
} from '../../server/src/lib/executorCredentials.ts';
import providersModule from '../../server/src/modules/providers/index.ts';
import authPlugin from '../../server/src/plugins/auth.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

const SECRET = 'sk-test-0123456789abcdef';

const DECLARATIONS = [
  {
    env: 'TEST_API_KEY',
    kind: 'secret',
    label: 'Ключ API',
    hint: 'Из кабинета.',
  },
  {
    env: 'TEST_MODE',
    kind: 'choice',
    label: 'Режим',
    options: [
      { value: 'api', label: 'API' },
      { value: 'plan', label: 'План' },
    ],
  },
];

function secretDeclaration(env, label) {
  return {
    env,
    kind: 'secret',
    label,
  };
}

// Состояние ключа одной строкой: имя, задан ли, лежит ли в файле, хвост и значение выбора.
function stateOf(view) {
  return [view.env, view.set, view.inFile, view.preview, view.value];
}

function adapterWith(credentials) {
  return {
    id: 'keyed-provider',
    name: 'Keyed Provider',
    vendor: 'Test',
    color: '#123456',
    bin: () => '/bin/true',
    probe: async () => ({ ok: true, version: '1.0' }),
    auth: async () => ({
      mode: 'env',
      label: 'ok',
      available: true,
    }),
    seedModels: () => [],
    credentials,
  };
}

/**
 * Временный .env с правами только для владельца; каталог удаляется после теста.
 * Возвращает и корень, чтобы маршрут положил рядом свои служебные файлы.
 */
async function tempEnv(t, content) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'executor-credentials-'));
  const file = path.join(root, '.env');

  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(file, content, { mode: 0o600 });

  return { root, file };
}

/**
 * Модуль providers с одним синтетическим исполнителем, временным .env и своим
 * объектом окружения: process.env теста не меняется.
 */
async function routeFixture(t, {
  content = '# шапка\n',
  adapters = [adapterWith(DECLARATIONS)],
  auth = false,
} = {}) {
  const { root, file } = await tempEnv(t, content);
  const env = {};
  const broadcasts = [];
  const app = Fastify({ logger: false });

  app.decorate('sse', { broadcast: (name, payload) => broadcasts.push({ name, payload }) });

  if (auth) {
    await app.register(authPlugin, {
      authStore: {
        isConfigured: () => true,
        isValidSession: () => false,
      },
    });
  }

  await app.register(providersModule, {
    config: {
      modelsPath: path.join(root, 'models.json'),
      providerUsageSeenPath: path.join(root, 'usage-seen.json'),
      envPath: file,
    },
    getProviderAdapters: async () => new Map(adapters.map((item) => [item.id, item])),
    getModelsRegistry: async () => ({}),
    env,
  });
  t.after(() => app.close());

  return {
    app,
    env,
    file,
    broadcasts,
  };
}

test('декларация отбрасывает сломанные записи и повтор имени', async () => {
  const declared = await declaredCredentials(adapterWith([
    ...DECLARATIONS,
    secretDeclaration('TEST_API_KEY', 'Повтор'),
    secretDeclaration('lower_case', 'Строчные'),
    secretDeclaration('NO_LABEL', ''),
    { ...secretDeclaration('ODD_KIND', 'Тумблер'), kind: 'toggle' },
    {
      ...secretDeclaration('EMPTY_CHOICE', 'Без вариантов'),
      kind: 'choice',
      options: [],
    },
    null,
  ]), {});

  assert.deepEqual(declared.map((item) => item.env), ['TEST_API_KEY', 'TEST_MODE']);
  assert.deepEqual(await declaredCredentials(adapterWith(async () => DECLARATIONS), {}), declared);
  assert.deepEqual(await declaredCredentials(adapterWith(() => {
    throw new Error('сбой');
  }), {}), []);
  assert.deepEqual(await declaredCredentials(adapterWith(undefined), {}), []);
});

test('условие when и подсказки вариантов: верные сохраняются, ссылка не на выбор отбрасывается', async () => {
  const declared = await declaredCredentials(adapterWith([
    {
      env: 'TEST_MODE',
      kind: 'choice',
      label: 'Режим',
      options: [
        {
          value: 'api',
          label: 'API',
          hint: 'Оплата по расходу.',
        },
        { value: 'plan', label: 'План' },
      ],
    },
    {
      ...secretDeclaration('TEST_API_KEY', 'Ключ API'),
      when: { env: 'TEST_MODE', value: 'api' },
    },
    {
      ...secretDeclaration('TEST_PLAN_KEY', 'Ключ плана'),
      when: { env: 'TEST_MODE', value: 'plan' },
    },
    {
      ...secretDeclaration('TEST_ODD_VALUE', 'Неизвестный вариант'),
      when: { env: 'TEST_MODE', value: 'other' },
    },
    {
      ...secretDeclaration('TEST_ODD_TARGET', 'Ссылка на секрет'),
      when: { env: 'TEST_API_KEY', value: 'api' },
    },
  ]), {});
  const byEnv = Object.fromEntries(declared.map((item) => [item.env, item]));

  assert.deepEqual(byEnv.TEST_MODE.options, [
    {
      value: 'api',
      label: 'API',
      hint: 'Оплата по расходу.',
    },
    { value: 'plan', label: 'План' },
  ]);
  assert.deepEqual(byEnv.TEST_API_KEY.when, { env: 'TEST_MODE', value: 'api' });
  assert.deepEqual(byEnv.TEST_PLAN_KEY.when, { env: 'TEST_MODE', value: 'plan' });
  // Сломанное условие не прячет поле навсегда: запись остаётся, но без условия.
  assert.equal(Object.hasOwn(byEnv.TEST_ODD_VALUE, 'when'), false);
  assert.equal(Object.hasOwn(byEnv.TEST_ODD_TARGET, 'when'), false);
});

test('проекция не содержит значения секрета и честно говорит об источнике', () => {
  const env = {
    TEST_API_KEY: SECRET,
    TEST_MODE: 'plan',
  };
  const views = credentialViews(DECLARATIONS, env, new Set(['TEST_MODE']));

  assert.ok(!JSON.stringify(views).includes(SECRET.slice(0, -4)));
  assert.deepEqual(views.map(stateOf), [
    ['TEST_API_KEY', true, false, '…cdef', null],
    ['TEST_MODE', true, true, null, 'plan'],
  ]);

  const short = credentialViews(DECLARATIONS, { TEST_API_KEY: 'short-key' }, null);

  assert.equal(short[0].preview, null);
  assert.equal(short[0].inFile, null);
  assert.equal(short[1].set, false);
});

test('запись принимает только объявленное и переносит ключ в окружение', async (t) => {
  const { file } = await tempEnv(t, 'OTHER=keep\n');
  const env = { OTHER: 'keep' };
  const apply = (input) => applyCredentialValues({
    declarations: DECLARATIONS,
    input,
    envPath: file,
    env,
  });

  assert.equal((await apply({ FOREIGN_KEY: 'x' })).error, 'credential_unknown');
  assert.equal((await apply({ TEST_API_KEY: '   ' })).error, 'credential_empty');
  assert.equal((await apply({ TEST_MODE: 'other' })).error, 'credential_option_unknown');
  assert.equal((await apply({})).error, 'credentials_invalid');
  assert.equal((await apply({ TEST_API_KEY: 'with space' })).error, 'env_value_invalid');
  assert.equal(await fs.readFile(file, 'utf8'), 'OTHER=keep\n');

  const saved = await apply({ TEST_API_KEY: `  ${SECRET} `, TEST_MODE: 'api' });

  assert.deepEqual(saved, { ok: true, changed: ['TEST_API_KEY', 'TEST_MODE'] });
  assert.equal(await fs.readFile(file, 'utf8'), `OTHER=keep\nTEST_API_KEY=${SECRET}\nTEST_MODE=api\n`);
  assert.deepEqual(Object.entries(env), [
    ['OTHER', 'keep'],
    ['TEST_API_KEY', SECRET],
    ['TEST_MODE', 'api'],
  ]);

  await apply({ TEST_API_KEY: null });
  assert.equal(await fs.readFile(file, 'utf8'), 'OTHER=keep\nTEST_MODE=api\n');
  assert.equal(env.TEST_API_KEY, undefined);
  assert.deepEqual([...await envFileNames(file)], ['OTHER', 'TEST_MODE']);
});

test('удаление не снимает ключ, заданный вне файла, а сбой файла не трогает окружение', async (t) => {
  const { file } = await tempEnv(t, 'A=1\n');
  const env = { TEST_API_KEY: SECRET };

  const removed = await applyCredentialValues({
    declarations: DECLARATIONS,
    input: { TEST_API_KEY: null },
    envPath: file,
    env,
  });

  assert.deepEqual(removed, { ok: true, changed: [] });
  assert.equal(env.TEST_API_KEY, SECRET);

  await fs.writeFile(file, 'MULTI="first\nsecond"\n');

  const broken = await applyCredentialValues({
    declarations: DECLARATIONS,
    input: { TEST_MODE: 'api' },
    envPath: file,
    env,
  });

  assert.equal(broken.status, 409);
  assert.equal(broken.error, 'env_file_unsupported');
  assert.equal(env.TEST_MODE, undefined);
});

test('маршрут пишет ключ в .env, а карточка видит только признак и хвост', async (t) => {
  const fixture = await routeFixture(t);

  const response = await fixture.app.inject({
    method: 'POST',
    url: '/api/providers/keyed-provider/credentials',
    payload: { values: { TEST_API_KEY: SECRET } },
  });

  assert.equal(response.statusCode, 200);
  assert.ok(!response.body.includes(SECRET));
  assert.deepEqual(response.json().changed, ['TEST_API_KEY']);
  assert.equal(await fs.readFile(fixture.file, 'utf8'), `# шапка\nTEST_API_KEY=${SECRET}\n`);
  assert.equal(fixture.env.TEST_API_KEY, SECRET);
  // Invalidation уходит сразу; итог фонового каталога даёт обычное обновление реестра.
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  assert.deepEqual(fixture.broadcasts.map((item) => item.name), ['providers-update', 'providers-update']);

  const list = await fixture.app.inject({ method: 'GET', url: '/api/providers' });
  const card = list.json().providers.find((provider) => provider.id === 'keyed-provider');

  assert.ok(!list.body.includes(SECRET));
  assert.deepEqual(card.credentials.map(stateOf), [
    ['TEST_API_KEY', true, true, '…cdef', null],
    ['TEST_MODE', false, false, null, null],
  ]);
});

test('маршрут отклоняет чужие имена, неизвестного и безключевого исполнителя', async (t) => {
  const plain = { ...adapterWith(undefined), id: 'plain-provider' };
  const fixture = await routeFixture(t, { adapters: [adapterWith(DECLARATIONS), plain] });
  const post = (id, values) => fixture.app.inject({
    method: 'POST',
    url: `/api/providers/${id}/credentials`,
    payload: { values },
  });

  assert.equal((await post('keyed-provider', { PATH: '/tmp' })).statusCode, 400);
  assert.equal((await post('plain-provider', { TEST_API_KEY: SECRET })).json().error, 'no_credentials');
  assert.equal((await post('missing', { TEST_API_KEY: SECRET })).statusCode, 404);
  assert.equal(await fs.readFile(fixture.file, 'utf8'), '# шапка\n');
  assert.deepEqual(fixture.env, {});
});

test('без входа маршрут ключей закрыт общим auth guard', async (t) => {
  const fixture = await routeFixture(t, { auth: true });

  const response = await fixture.app.inject({
    method: 'POST',
    url: '/api/providers/keyed-provider/credentials',
    payload: { values: { TEST_API_KEY: SECRET } },
  });

  assert.equal(response.statusCode, 401);
  assert.equal(await fs.readFile(fixture.file, 'utf8'), '# шапка\n');
});
