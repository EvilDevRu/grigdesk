import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ensureBrainIdentity } from '../../../server/src/lib/mobile/identity.ts';
import { MobileService } from '../../../server/src/lib/mobile/service.ts';
import { createSshTransport } from '../../../server/src/lib/ssh/transport.ts';
import { createHostKeyStore } from '../../../server/src/lib/ssh/hostKeys.ts';
import mobileModule from '../../../server/src/modules/mobile/index.ts';
import authPlugin from '../../../server/src/plugins/auth.ts';

const Fastify = createRequire(new URL('../../../server/package.json', import.meta.url))('fastify');

/**
 * Мастер монтируется через существующий MobileService и настоящий общий auth guard.
 * Будущие зависимости relayDeployment доступны только конструктору, никогда HTTP-запросу.
 */
export async function deploymentFixture(t, options = {}) {
  const directory = options.directory ?? await mkdtemp(path.join(tmpdir(), 'grigdesk-relay-deployment-'));
  const identity = await ensureBrainIdentity(directory);
  const events = [];
  const logs = [];
  const calls = [];
  const transport = options.transport ?? {
    probe: async (input) => {
      calls.push(['probe', input]);

      return {
        ...input,
        algorithm: 'ssh-ed25519',
        fingerprint: 'SHA256:fixture'
      };
    },
    connect: async () => {
      calls.push(['connect']);

      throw new Error('fixture_connect_denied');
    },
  };
  const hostKeys = await createHostKeyStore({ file: path.join(directory, 'known-hosts.json') });
  const mobile = new (options.Service ?? MobileService)({
    directory,
    port: 0,
    vpnGate: async () => true,
    makeHub: () => ({
      sync() { },
      close() { },
      status: () => []
    }),
    makeServer: async () => ({
      port: 8144,
      close: async () => { },
      disconnectDevice() { }
    }),
    changed: (event) => events.push(event),
    log: (event) => logs.push(event),
    relayDeployment: {
      transport,
      hostKeys,
      ...options.deployment
    },
    ...options.mobile,
  });
  const app = Fastify({ logger: false });

  await app.register(authPlugin, {
    cliToken: 'fixture-cli',
    internalToken: 'fixture-internal',
    authStore: {
      isConfigured: () => true,
      isValidSession: (id) => ['first', 'second'].includes(id),
    },
  });
  await app.register(mobileModule, { service: mobile });
  await mobile.start();
  t.after(async () => {
    await mobile.close();
    await app.close();
    // Durable job может дописать состояние при закрытии MobileService.
    // Его временный каталог удаляется последним, после владельца и HTTP.
    if (options.directory == null) {
      // Уже принятые fs-операции завершаются в thread pool после закрытия владельца.
      // Ограниченный retry относится только к уборке, проверки job остаются прежними.
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 20,
      });
    }
  });

  return {
    app,
    mobile,
    directory,
    identity,
    events,
    logs,
    calls,
    transport,
    hostKeys
  };
}

/**
 * Ожидаемый owner берётся из brain-cert того же каталога, что читает MobileService.start.
 * Адреса являются локальными или зарезервированными данными, сеть не вызывается при draft.
 */
export function setupInput(f, extra = {}) {
  return {
    requestId: 'setup-request-0001',
    expectedServerFp: f.identity.fp,
    mode: 'setup',
    name: 'Доступ лаборатории',
    ssh: {
      host: '127.0.0.1',
      port: 2222,
      user: 'root'
    },
    public: { host: 'relay.example.invalid', port: 443 },
    ...extra,
  };
}

/**
 * Запрос идёт в тот же Fastify instance; и пароль, и отрицательная авторизация явны.
 * Секретный binary body не становится полем JSON настройки или аргументом процесса.
 */
export function deploymentRequest(f, method, suffix = '', payload, headers = {}) {
  return f.app.inject({
    method,
    url: `/api/mobile/deployments${suffix}`,
    headers: { cookie: f.cookie ?? 'grigdesk_sid=first', ...headers },
    ...(payload === undefined ? {} : { payload }),
  });
}

/**
 * Допустимы оба обычных успешных статуса создания; схема обёртки не является целью теста.
 * На исходной базе здесь падает assertion 404, а не импорт отсутствующего product-файла.
 */
export async function createDeployment(f, input = setupInput(f)) {
  const response = await deploymentRequest(f, 'POST', '', input);

  assert.ok([200, 201, 202].includes(response.statusCode),
    `Мастер должен принять draft, получен ${response.statusCode}: ${response.body}`);
  assert.equal(response.headers['cache-control'], 'no-store');

  const body = response.json();
  const job = body.job ?? body.deployment ?? body;

  assert.equal(typeof job.id, 'string');
  assert.ok(Number.isSafeInteger(job.revision));

  return job;
}

/**
 * Снимок восстанавливается GET, как после переподключения общей SSE-шины.
 * Ожидание ограничено и сообщает последнее фактическое состояние задания.
 */
export async function readDeployment(f, id) {
  const response = await deploymentRequest(f, 'GET', `/${id}`);

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers['cache-control'], 'no-store');

  const body = response.json();

  return body.job ?? body.deployment ?? body;
}

/**
 * Фоновый worker опрашивается до наблюдаемого состояния, без произвольного длинного sleep.
 * Неуспех показывает последний DTO, чтобы отличить дефект поведения от таймаута стенда.
 */
export async function waitDeployment(f, id, states, timeout = 5000) {
  const deadline = Date.now() + timeout;
  let job;

  do {
    job = await readDeployment(f, id);

    if (states.includes(job.state)) {
      return job;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);

  assert.fail(`Ожидались ${states.join(', ')}, получено ${JSON.stringify(job)}`);
}

/**
 * Явное доверие и ввод секрета идут разными запросами с текущей revision.
 * Проверка стадии не позволяет принять отказ до preflight за результат проверки платформы.
 */
export async function prepareDeployment(f, input, credentials) {
  const created = await createDeployment(f, input);
  const probe = await deploymentRequest(f, 'POST', `/${created.id}/probe`, {
    revision: created.revision,
  });

  assert.ok([200, 202].includes(probe.statusCode), probe.body);

  const challenged = await waitDeployment(f, created.id, ['awaiting_host_key', 'awaiting_credentials']);

  if (challenged.state === 'awaiting_host_key') {
    const hostKey = challenged.hostKey ?? challenged.challenge;

    assert.equal(typeof hostKey.challengeId, 'string');

    const trusted = await deploymentRequest(f, 'POST', `/${created.id}/host-key`, {
      revision: challenged.revision,
      challengeId: hostKey.challengeId,
      decision: hostKey.decision === 'replace_required' ? 'replace' : 'trust',
    });

    assert.ok([200, 202].includes(trusted.statusCode), trusted.body);
  }

  const awaiting = await waitDeployment(f, created.id, ['awaiting_credentials']);
  const supplied = await deploymentRequest(f, 'POST', `/${created.id}/credentials`,
    Buffer.from(JSON.stringify({
      revision: awaiting.revision,
      attemptId: `credentials-${created.id}`,
      ...credentials,
    })), { 'content-type': 'application/octet-stream' });

  assert.ok([200, 202].includes(supplied.statusCode), supplied.body);

  return waitDeployment(f, created.id, ['awaiting_confirmation', 'failed']);
}

/**
 * Start закрепляет digest именно показанного preview и не принимает новый произвольный артефакт.
 * Последующее ожидание выбирает тест: клиент может закрыться сразу после принятого запроса.
 */
export async function startDeployment(f, job, requestId = `start-${job.id}`) {
  const response = await deploymentRequest(f, 'POST', `/${job.id}/start`, {
    requestId,
    revision: job.revision,
    previewDigest: job.preview.digest,
  });

  assert.equal(response.statusCode, 202, response.body);

  return response;
}

/**
 * Рекурсивный снимок содержит только собственный временный каталог фикстуры.
 * Байты сравниваются целиком: новый pin, токен или скрытая ротация будут обнаружены.
 */
export async function fileSnapshot(directory) {
  const result = {};

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      const nested = await fileSnapshot(full);

      for (const [name, bytes] of Object.entries(nested)) {
        result[`${entry.name}/${name}`] = bytes;
      }
    } else if (entry.isFile()) {
      result[entry.name] = (await readFile(full)).toString('base64');
    }
  }

  return result;
}

export { createSshTransport };
