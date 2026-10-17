import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, writeFile, rm, copyFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';

import { PhoneEmulator, startEmulator } from './emulator.mts';
import { decodeContract } from '../../mobile/src/api/contract.ts';
import type { Chat, QuestionWaiting, Waiting } from '../../mobile/src/api/contract.ts';
import { parseQr } from '../../mobile/src/link/qr.ts';
import { artifactsPath } from '../../shared/runtime/dataHome.ts';
import { browserFlow } from './browserFlow.mts';
import { dockerCheck } from './dockerCheck.mts';

const execute = promisify(execFile);
const output = path.join(artifactsPath({ env: process.env, home: homedir() }), 'mobile-remote/e2e');
const checks: Array<{
  id: string;
  state: string;
  detail: string;
}> = [];
const cleanup: Array<() => Promise<void> | void> = [];
let fixtureRoot = '';
let relay: ReturnType<typeof spawn> | null = null;
let worker: ReturnType<typeof spawn> | null = null;
let metadata: {
  root: string;
  httpPort: number;
  cliToken: string;
};
let relayId: string;
let relayFile: string;
let relayPort: number;
let serial = 0;
let command: (action: string, extra?: Record<string, unknown>) => Promise<any>;

/**
 * Ожидание ограничено deadline и относится только к собственному изолированному стенду.
 * Внешние аккаунты, рабочий Cockpit, VPN и системные службы не меняются.
 */
async function until(test: () => Promise<boolean>, milliseconds = 35000) {
  const deadline = performance.now() + milliseconds;

  while (!(await test())) {
    if (performance.now() >= deadline) {
      throw new Error('Не дождались восстановления изолированного стенда');
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Child Cockpit получает прежние каталоги только из metadata своего предыдущего запуска.
 * IPC и stderr принадлежат этому прогону, секреты не выводятся в отчёт.
 */
async function startWorker(rootDirectory?: string) {
  const metadataFile = path.join(output, 'server-private.json');
  const child = spawn(
    process.execPath,
    [
      '--max-old-space-size=768',
      'tools/mobile-phone/service-worker.mts',
      metadataFile,
      ...(rootDirectory ? [rootDirectory] : []),
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );

  worker = child;

  let errors = '';

  child.stderr!.on('data', (bytes) => {
    errors = (errors + bytes.toString()).slice(-8192);
  });

  const lines = createInterface({ input: child.stdout! });
  const pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
    }
  >();
  let ready: () => void;
  const startup = new Promise<void>((resolve) => {
    ready = resolve;
  });

  lines.on('line', (line) => {
    if (line === 'ready') {
      ready();

      return;
    }

    const result = JSON.parse(line);
    const item = pending.get(result.id);

    pending.delete(result.id);

    if (result.ok) {
      item?.resolve(result.result);
    } else {
      item?.reject(new Error(`Команда стенда ${result.action}: ${result.reason}`));
    }
  });
  child.once('exit', () => {
    for (const item of pending.values()) {
      item.reject(new Error('Изолированный Cockpit завершился'));
    }
  });
  await Promise.race([
    startup,
    new Promise<void>((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Изолированный Cockpit не запустился')),
        30000,
      );

      timer.unref();
    }),
  ]);
  metadata = JSON.parse(await readFile(metadataFile, 'utf8'));
  fixtureRoot = metadata.root;
  worker = child;
  command = (action, extra = {}) =>
    new Promise((resolve, reject) => {
      const id = ++serial;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('Истекло ожидание синтетической зависимости: ' + action));
      }, 40000);

      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      child.stdin!.write(
        JSON.stringify({
          id,
          action,
          ...extra,
        }) + '\n',
      );
    });
}

async function admin(method: string, route: string, body?: unknown) {
  const response = await fetch(`http://127.0.0.1:${metadata.httpPort}` + route, {
    method,
    headers: {
      'X-Cockpit-Token': metadata.cliToken,
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  return response;
}

async function online() {
  const response = await admin('GET', '/api/mobile/status');
  const status = await response.json();

  return status.relays.some(
    (item: { id: string; link: { state: string } }) =>
      item.id === relayId && item.link.state === 'online',
  );
}

/**
 * Supervisor читает только скачанный временный relay.env; parent следит за своими PID.
 * Заморозка child проверяет настоящий watchdog, вне Docker повторный запуск делает этот скрипт.
 */
async function startRelay() {
  relay = spawn(process.execPath, ['--env-file=' + relayFile, 'relay/src/supervisor.ts'], {
    env: {
      ...process.env,
      RELAY_PORT: String(relayPort),
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  await until(online);
}

/**
 * Останавливается только child, созданный этим прогоном; чужие процессы не затрагиваются.
 * Таймер принудительного завершения снимается после выхода, не переживая уборку стенда.
 */
async function stop(child: ReturnType<typeof spawn> | null) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  const finished = new Promise<void>((resolve) => child.once('exit', () => resolve()));

  child.kill('SIGTERM');

  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);

  try {
    await finished;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Все DTO декодируются независимым телефонным контрактом после двух реальных pinned TLS.
 * POST создаёт один key/time, а повтор не формирует новое намерение.
 */
async function json(
  phone: PhoneEmulator,
  route: string,
  kind: string,
  body?: unknown,
  key?: string,
  createdAt = Date.now(),
) {
  const response = await phone.request({
    method: body === undefined ? 'GET' : 'POST',
    path: '/api/mobile/v1' + route,
    ...(body === undefined
      ? {}
      : {
          body: JSON.stringify(body),
          idempotencyKey: key,
          createdAt,
        }),
  });
  const value = JSON.parse(response.body);

  if (response.status >= 200 && response.status < 300) {
    try {
      decodeContract(
        response.status === 202 && kind !== 'accepted' ? 'operation-pending' : kind,
        value,
      );
    } catch (error) {
      throw new Error(route + ': ' + (error instanceof Error ? error.message : 'Неверный DTO'));
    }
  }

  return {
    status: response.status,
    value,
  };
}

/**
 * Сценарий проверяет HTTP/SSE/media/команды и восстановление без браузерного владельца истории.
 * SIGKILL направлен только дочернему тестовому Cockpit; операции и fingerprint читаются после нового boot.
 */
async function main() {
  await mkdir(output, { recursive: true });

  const temporary = await mkdtemp(path.join(tmpdir(), 'cockpit-e2e-'));

  cleanup.push(() =>
    rm(temporary, {
      recursive: true,
      force: true,
    }),
  );
  cleanup.push(async () => {
    await stop(relay);
    await stop(worker);
    await rm(path.join(output, 'server-private.json'), { force: true });

    if (fixtureRoot) {
      await rm(fixtureRoot, {
        recursive: true,
        force: true,
      });
    }
  });
  await startWorker();

  const reservation = net.createServer();

  await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  relayPort = (reservation.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));

  const added = await admin('POST', '/api/mobile/relays', {
    name: 'Тестовый локальный посредник',
    host: '127.0.0.1',
    port: relayPort,
  });

  assert.equal(added.status, 200);
  relayId = (await added.json()).relay.id;
  relayFile = path.join(temporary, 'relay.env');

  const env = await admin('GET', `/api/mobile/relays/${relayId}/env`);

  await writeFile(relayFile, await env.text(), { mode: 0o600 });
  await startRelay();

  const qrResponse = await admin('POST', `/api/mobile/relays/${relayId}/qr`, { pair: true });
  const qr = (await qrResponse.json()).text;
  const phoneDirectory = path.join(temporary, 'phone');
  let phone = new PhoneEmulator(phoneDirectory);

  cleanup.unshift(() => phone.lock());
  await phone.addFromText(qr);

  const deviceId = phone.getState().deviceId;

  assert.ok(deviceId);

  for (const [route, kind] of [
    ['/hello', 'hello'],
    ['/chats', 'chats'],
    ['/chats/integration-chat', 'chat'],
    ['/waiting', 'waiting'],
    ['/tasks', 'tasks'],
    ['/tasks/7', 'task'],
    ['/tasks/7/plan', 'plan'],
    ['/b24/tasks', 'b24-tasks'],
    ['/b24/tasks/7', 'b24-task'],
    ['/b24/tasks/7/launch-options', 'launch-options'],
  ]) {
    assert.equal((await json(phone, route!, kind!)).status, 200, route);
  }

  const events: string[] = [];

  phone.subscribe((name, value: any) => {
    if (name === 'linkEvent') {
      events.push(value.name);
    }
  });
  phone.startEvents();
  await until(async () => events.includes('ready'), 5000);

  const createdAt = Date.now();
  const body = {
    clientId: 'e2e-mobile-message-001',
    text: 'Общий ход без браузера',
  };
  const accepted = await json(
    phone,
    '/chats/integration-chat/messages',
    'accepted',
    body,
    'e2e-mobile-operation-001',
    createdAt,
  );

  assert.equal(accepted.status, 202);

  const repeated = await json(
    phone,
    '/chats/integration-chat/messages',
    'accepted',
    body,
    'e2e-mobile-operation-001',
    createdAt,
  );

  assert.deepEqual(repeated, accepted);
  await command('ask');

  let question: QuestionWaiting | undefined;

  await until(async () => {
    const waiting = await json(phone, '/waiting', 'waiting');

    question = (waiting.value as Waiting).items.find(
      (item): item is QuestionWaiting =>
        item.kind === 'question' && item.chatId === 'integration-chat',
    );

    return Boolean(question);
  }, 5000);
  assert.ok(question);
  assert.equal(question.kind, 'question');

  const answered = await json(
    phone,
    '/waiting/' + question.pid,
    'waiting-result',
    {
      action: 'accept',
      actionToken: question.actionToken,
      answers: [
        {
          questionId: question.questions[0]!.id,
          optionIds: [question.questions[0]!.options.find((item) => item.label === 'Да')!.id],
        },
      ],
    },
    'e2e-question-operation-001',
  );

  assert.equal(
    answered.status,
    200,
    'Ответ на вопрос: ' + (answered.value.error?.code || answered.status),
  );
  await command('answer');
  await command('release');
  await until(async () => events.includes('chat'), 5000);

  const chat = await json(phone, '/chats/integration-chat', 'chat');
  const image = (chat.value as Chat).messages
    .flatMap((message) => message.parts)
    .find((part) => part.type === 'image');

  assert.ok(image, 'Сохранённая картинка отсутствует в общем чате');

  const firstMedia = await phone.fetchMedia('integration-chat', image.ref);
  const secondMedia = await phone.fetchMedia('integration-chat', image.ref);

  assert.equal(Boolean(firstMedia.file), true);
  assert.deepEqual(secondMedia, firstMedia);

  const stepMedia = (chat.value as Chat).messages
    .flatMap((message) => message.media)
    .find((item) => item.from === 'step');

  assert.ok(stepMedia, 'Картинка шага Read отсутствует в media ответа');
  assert.equal(Boolean((await phone.fetchMedia('integration-chat', stepMedia.ref)).file), true);

  const operation = await json(phone, '/operations/e2e-mobile-operation-001', 'operations');

  assert.equal(operation.value.state, 'done');
  assert.equal((await command('runs')).count, 1);

  const task = await json(phone, '/tasks/7', 'task');
  const resumed = await json(
    phone,
    '/tasks/7/resume',
    'resume',
    {
      actionToken: task.value.task.actions.resume,
    },
    'e2e-resume-operation-001',
  );

  assert.ok([200, 202, 409].includes(resumed.status));

  const noApk = await json(phone, '/app', 'app');

  assert.equal(noApk.status, 404);
  checks.push({
    id: 'MV-08',
    state: 'PASS',
    detail: 'v1, pair, shared history, question, SSE, media/ETag, retry, operation',
  });

  const children = (await readFile(`/proc/${relay!.pid}/task/${relay!.pid}/children`, 'utf8'))
    .trim()
    .split(/\s+/)
    .map(Number);
  const frozen = children[0];

  assert.ok(frozen !== undefined && frozen > 0);

  const failed = new Promise<number | null>((resolve) => relay!.once('exit', resolve));
  const started = performance.now();

  process.kill(frozen, 'SIGSTOP');
  assert.equal(await failed, 1);
  await startRelay();
  assert.equal((await json(phone, '/hello', 'hello')).status, 200);
  checks.push({
    id: 'MV-09',
    state: 'PASS',
    detail: `Watchdog и reconnect: ${Math.round(performance.now() - started)} мс`,
  });

  const oldWorker = worker!;
  const killed = new Promise<void>((resolve) => oldWorker.once('exit', () => resolve()));

  oldWorker.kill('SIGKILL');
  await killed;
  await startWorker(fixtureRoot);
  await until(online);

  const restored = await json(phone, '/operations/e2e-mobile-operation-001', 'operations');

  assert.deepEqual(restored.value, operation.value);
  assert.equal((await json(phone, '/hello', 'hello')).value.device.id, deviceId);
  assert.equal((await command('runs')).count, 0);
  phone.lock();
  phone = new PhoneEmulator(phoneDirectory);
  await phone.load();
  phone.unlock();
  assert.equal((await json(phone, '/hello', 'hello')).value.device.id, deviceId);
  assert.ok(
    phone.getOutbox().items.some((item) => item.idempotencyKey === 'e2e-mobile-operation-001'),
  );
  checks.push({
    id: 'MV-10',
    state: 'PASS',
    detail: 'SIGKILL Cockpit, тот же fingerprint/outbox и durable result; эффект не повторяется',
  });

  const docker = process.argv.includes('--without-docker')
    ? {
        state: 'NOT RUN',
        detail: 'Контейнер пропущен в отладочном прогоне --without-docker',
      }
    : await dockerCheck({
        directory: temporary,
        relayFile,
        relayPort,
        stopRelay: () => stop(relay),
        startRelay,
        check: async () => {
          await until(online);
          assert.equal((await json(phone, '/hello', 'hello')).status, 200);
          assert.equal((await json(phone, '/chats', 'chats')).status, 200);
        },
      });

  checks.push({
    id: 'MV-11',
    ...docker,
  });

  if (process.argv.includes('--browser')) {
    for (const [name, width, height] of [
      ['phone-m', 360, 800],
      ['phone-xl', 412, 915],
      ['tablet-port', 800, 1280],
    ] as const) {
      for (const fontScale of [1, 1.3]) {
        const browserPhone = new PhoneEmulator(path.join(temporary, `${name}-${fontScale}`));

        browserPhone.state.fontScale = fontScale;
        browserPhone.subscribe((event, data: any) => {
          if (event === 'linkState') {
            console.log('V4: transport', data.state || (data.unlocked ? 'unlocked' : 'locked'));
          } else if (event === 'linkEvent' && data.name === 'ready') {
            console.log('V4: transport ready');
          }
        });

        const request = browserPhone.request.bind(browserPhone);

        browserPhone.request = async (input) => {
          const response = await request(input);

          if (input.method === 'POST') {
            const error = JSON.parse(response.body)?.error;

            console.log('V4: POST', response.status, /^[a-z_]+$/.test(error || '') ? error : '');
          }

          return response;
        };

        const api = await startEmulator(browserPhone);

        try {
          const freshQr = await admin('POST', `/api/mobile/relays/${relayId}/qr`, { pair: true });

          await browserFlow({
            api,
            phone: browserPhone,
            qr: (await freshQr.json()).text,
            command,
            stopRelay: () => stop(relay),
            startRelay,
            output: path.join(output, `${name}-${fontScale}`),
            viewport: {
              width,
              height,
            },
            revoke: async () => {
              const response = await admin(
                'POST',
                '/api/mobile/devices/' + browserPhone.getState().deviceId + '/revoke',
                {},
              );

              assert.equal(response.status, 200);
            },
          });
          console.log('V4: пройден', name, fontScale);
        } finally {
          browserPhone.lock();
          await api.close();
        }
      }
    }

    checks.push({
      id: 'MV-12',
      state: 'PASS',
      detail: '6 путей DevLink: UI, SSE, очередь, lock, media, revoke; 3 размера × 100/130%',
    });
  }

  const revoked = await admin('POST', '/api/mobile/devices/' + deviceId + '/revoke', {});

  assert.equal(revoked.status, 200);

  const denied = await json(phone, '/chats', 'chats');

  assert.equal(denied.status, 403);

  const payload = parseQr(qr);
  const badQr =
    'cockpitlink:1:' +
    Buffer.from(
      JSON.stringify({
        ...payload,
        relay: {
          ...payload.relay,
          fp: '0'.repeat(64),
        },
      }),
    ).toString('base64url');
  const badPhone = new PhoneEmulator(path.join(temporary, 'bad-phone'));

  cleanup.unshift(() => badPhone.lock());
  await assert.rejects(badPhone.addFromText(badQr), /pin/i);
  checks.push({
    id: 'MV-10-auth',
    state: 'PASS',
    detail: 'Отзыв 403; неверный relay pin отвергнут до hello',
  });
}

try {
  await main();
} catch (error) {
  const safe =
    error instanceof Error
      ? error.message
          .replace(/cockpitlink:1:[A-Za-z0-9_-]+/g, '[QR скрыт]')
          .replace(/[A-Za-z0-9_-]{32,}/g, '[скрыто]')
      : 'Стенд отказал';

  checks.push({
    id: 'unfinished',
    state: 'FAIL',
    detail: safe,
  });
  process.exitCode = 1;
} finally {
  for (const close of cleanup) {
    await close();
  }

  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'report.json'), JSON.stringify(checks, null, 2) + '\n');
  await writeFile(
    path.join(output, 'report.md'),
    '# Сквозная проверка\n\n' +
      '| Проверка | Статус | Результат |\n| --- | --- | --- |\n' +
      checks
        .map((item) => `| ${item.id} | ${item.state} | ${item.detail.replaceAll('\n', ' ')} |`)
        .join('\n') +
      '\n',
  );

  for (const check of checks) {
    console.log(check.id, check.state, check.detail);
  }
}
