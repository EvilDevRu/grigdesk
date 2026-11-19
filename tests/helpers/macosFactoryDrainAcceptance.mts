import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { ArbiterConversationStore } from '../../server/src/lib/arbiterConversationStore.ts';
import { inspectDarwinSession } from '../../server/src/lib/factoryDarwinSessions.ts';
import { decodeCompleteFactoryOwnership } from '../../shared/runtime/factoryOwnership.ts';
import { updateProcessAlive } from '../../shared/node/installedServer.ts';
import { readDarwinProcessIdentity, signalDarwinBuildMember } from '../../shared/node/processIdentity.ts';
import { awaitAcceptance, execute } from './platformReleaseAcceptance.mts';
import { withRuntimePinFault } from './macosRuntimePinFixture.mts';
import type { platformFixture } from './platformReleaseAcceptance.mts';
import type { macosRuntimePinFixture, seedRuntimePinGate } from './macosRuntimePinFixture.mts';

type Installed = Awaited<ReturnType<typeof platformFixture>>;
type Fixture = Awaited<ReturnType<typeof macosRuntimePinFixture>>;
type Gate = Awaited<ReturnType<typeof seedRuntimePinGate>>;

const drainPath = '/api/system/factory-drain-admission';

/**
 * Прокси слушает только loopback и передаёт запросы единственному серверу фикстуры.
 * Он удерживает запрос до acquire или ответ после фактического ACK confirm.
 */
async function observeAdmission(box: Installed, boundary: 'acquire' | 'confirm', check: () => Promise<void>) {
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let seen = false;
  let observed: { status: number; body: unknown } | undefined;

  /**
   * Порт worker меняется только в приватной .env. Проверяющие запросы идут
   * напрямую в настоящий сервер и видят его живой закрытый допуск.
   */
  async function forward(request: IncomingMessage, response: ServerResponse) {
    const route = request.url ?? '';
    const headers = new Headers();
    const parts: Uint8Array[] = [];
    let size = 0;

    assert.ok(route.startsWith('/api/') && !route.includes('://'));

    for (const key of ['x-grigdesk-token', 'content-type']) {
      const value = request.headers[key];

      if (typeof value === 'string') {
        headers.set(key, value);
      }
    }

    for await (const chunk of request) {
      size += chunk.byteLength;
      assert.ok(size <= 1024 * 1024);
      parts.push(chunk);
    }

    const body = Buffer.concat(parts, size);
    const action = route === drainPath && request.method === 'POST'
      ? JSON.parse(body.toString('utf8')).action : null;

    if (boundary === 'acquire' && action === boundary) {
      assert.equal(seen, false);
      seen = true;
      reached.resolve();
      await release.promise;
    }

    const upstream = await fetch(box.origin + route, {
      method: request.method,
      headers,
      body: request.method === 'POST' ? body : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(4500),
    });
    const bytes = Buffer.from(await upstream.arrayBuffer());

    if (action === boundary) {
      observed = { status: upstream.status, body: JSON.parse(bytes.toString('utf8')) };
    }

    if (boundary === 'confirm' && action === boundary && upstream.ok) {
      assert.equal(seen, false);
      assert.deepEqual(observed?.body, { ok: true });
      seen = true;
      reached.resolve();
      await release.promise;
    }

    const mime = upstream.headers.get('content-type') ?? 'application/octet-stream';

    response.writeHead(upstream.status, { 'Content-Type': mime });
    response.end(bytes);
  }

  const proxy = createServer((request, response) => {
    void forward(request, response).catch((error: unknown) => {
      reached.reject(error);

      if (!response.headersSent) {
        response.writeHead(502);
      }

      response.end();
    });
  });
  const envFile = path.join(box.dataHome, '.env');
  const saved = await fs.readFile(envFile, 'utf8');

  assert.match(saved, /^GRIGDESK_PORT=\d+$/mu);
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');

  const address = proxy.address();

  assert.ok(address && typeof address !== 'string');

  let worker: Promise<{ ok: boolean; error?: unknown }> | undefined;
  const deadline = new AbortController();

  try {
    await fs.writeFile(envFile, saved.replace(/^GRIGDESK_PORT=\d+$/mu, `GRIGDESK_PORT=${address.port}`));
    worker = box.ctl(['server', 'resume-update', '--restart', '--json'])
      .then(() => ({ ok: true }), (error: unknown) => ({ ok: false, error }));

    await Promise.race([
      reached.promise,
      worker.then((result) => {
        throw result.error ?? new Error('mac_factory_admission_missing');
      }),
      pause(60_000, undefined, { signal: deadline.signal }).then(() => {
        throw new Error('mac_factory_admission_timeout');
      }),
    ]);
    await check();
  } finally {
    deadline.abort();

    try {
      await fs.writeFile(envFile, saved);
    } finally {
      release.resolve();

      try {
        await worker;
      } finally {
        const closed = once(proxy, 'close');

        proxy.close();
        proxy.closeAllConnections();
        await closed;
      }
    }
  }

  return { command: await worker, response: observed };
}

/**
 * Сверяет отказ на штатных POST после confirm. Снимок берётся под настоящим
 * допуском, до Stop и переключения указателя A на B.
 */
export async function verifyFactoryConfirmAdmission(box: Installed, fixture: Fixture, gate: Gate) {
  const { task, profile, attempt, controlRoot, stateRoot } = fixture.identity;
  const beforePointer = await box.state('current.json');
  const original = (await box.api('/api/system/runtime-identity')).body;
  const originalOwnership = await box.api('/api/tasks?updateOwnership=1');

  assert.equal(originalOwnership.status, 200);

  const row = decodeCompleteFactoryOwnership(originalOwnership.body).find((item) => item.task === task);

  assert.deepEqual(row, {
    task,
    orchestrator: 'dead',
    runner: 'dead',
    finalization: 'done',
  });

  /**
   * Сравнивает журнал, проекцию и имена запуска. Закрытый допуск не вправе
   * публиковать даже временный handoff задачи или менять рабочее дерево.
   */
  async function stateWitness() {
    const resultFiles = (await fs.readdir(gate.stage)).sort();

    return {
      pipeline: await fs.readFile(gate.pipeline),
      worktree: (await fs.readdir(fixture.workspace)).sort(),
      state: (await fs.readdir(stateRoot, { recursive: true })).sort(),
      control: (await fs.readdir(controlRoot, { recursive: true })).sort(),
      resultFiles,
      results: await Promise.all(resultFiles.map((file) => fs.readFile(path.join(gate.stage, file)))),
    };
  }

  const update = await observeAdmission(box, 'confirm', async () => {
    const before = await stateWitness();
    const context = {
      profile,
      attempt,
      expectedMobile: gate.expectedMobile,
    };
    const prefix = `/api/tasks/${task}`;
    const calls = [
      [prefix + '/resume', context],
      [prefix + '/gate/GATE_PLAN/approve', context],
      [prefix + '/stage/INSTRUMENT/running', context],
      [prefix + '/runtime-rebind', context],
      [prefix + '/sandbox/retry', context],
      [prefix + '/sandbox/down', context],
      [prefix + '/close', context],
      [prefix + '/runner/settings', context],
      [prefix + '/runner/switch', context],
      [prefix + '/arbitrate', context],
      [`/api/tasks/${Number(task) + 1}/launch`, { profile }],
    ] as const;
    const results = await Promise.all(calls.map(async ([route, body]) => ({
      route,
      result: await box.api(route, body, 3500),
    })));

    for (const { route, result } of results) {
      assert.equal(result.status, 409, route);
      assert.deepEqual(result.body, { error: 'release_drain_busy' }, route);
    }

    assert.deepEqual(await stateWitness(), before);
    assert.deepEqual(await box.state('current.json'), beforePointer);
    assert.equal((await box.api('/api/system/runtime-identity')).body.instanceId, original.instanceId);
  });

  assert.equal(update.command?.ok, true, String(update.command?.error ?? ''));
  assert.equal((await box.state('update/job.json')).stage, 'completed');
  assert.notDeepEqual(await box.state('current.json'), beforePointer);
}

/**
 * Удерживает принятый HTTP job перед штатным Goto. Обновляющий worker должен
 * дождаться terminal записи, а повтор исходного запроса получить сохранённый ACK.
 */
export async function verifyArbiterDrainAdmission(box: Installed, fixture: Fixture) {
  const { task } = fixture.identity;
  const prefix = `/api/tasks/${task}/arbiter-conversations`;
  const current = await box.api(`${prefix}/current`);

  assert.equal(current.status, 200);
  assert.equal(current.body.identity.stop, 'human');
  assert.equal(current.body.capabilities.status, 'supported');
  assert.ok(current.body.capabilities.targets.some(({ node }: { node: string }) => node === 'instrument'));

  const store = new ArbiterConversationStore(path.join(box.dataHome, 'state/arbiter-conversations'));
  const doc = await store.create(current.body.identity, current.body.capabilities);
  const route = `${prefix}/${doc.id}/apply`;
  const request = {
    requestId: randomUUID(),
    expectedStop: doc.identity,
    decisionRevision: doc.decisionRevision,
    customAction: {
      kind: 'return_to_node',
      targetNode: 'instrument',
      instruction: 'Повторить подготовку проверки.',
    },
  };
  const pointer = await box.state('current.json');
  const owner = (await box.api('/api/system/runtime-identity')).body;
  const audit = path.join(path.dirname(fixture.workspace), 'arbiter-callback');
  const release = `${audit}.release`;
  const hook = 'set -uo pipefail\n';

  assert.match(audit, /^\/[\w./-]+$/u);

  // Временный барьер сохраняет настоящий Goto. Перед Resume создаём обычный
  // отказ проверки, чтобы фикстура гарантированно не запустила внешнюю модель.
  const barrier = [
    `if [[ "\${1:-}" == '${task}' ]]; then`,
    '  case "${2:-}" in',
    `    goto) printf 'goto\\n' >> '${audit}' || exit 78`,
    `          while [[ ! -e '${release}' ]] && (( SECONDS < 90 )); do /bin/sleep 0.1; done`,
    `          [[ -e '${release}' ]] || exit 78 ;;`,
    `    check) printf 'check\\n' >> '${audit}'; exit 78 ;;`,
    '  esac',
    'fi',
    '',
  ].join('\n');
  let operationId = '';

  const completed = await withRuntimePinFault(fixture.runtime.engineBin, (source) => {
    assert.ok(source.includes(hook));

    return source.replace(hook, () => hook + barrier);
  }, async () => {
    try {
      const refused = await observeAdmission(box, 'acquire', async () => {
        const accepted = await box.api(route, request, 3500);

        assert.equal(accepted.status, 202);
        assert.equal(accepted.body.conversationId, doc.id);
        assert.ok(accepted.body.operationId);
        operationId = accepted.body.operationId;
      });

      assert.equal(refused.command?.ok, false);
      assert.deepEqual(refused.response, { status: 409, body: { error: 'release_activity_unknown' } });
      await awaitAcceptance(async () => await fs.readFile(audit, 'utf8').catch((error) => {
        if (error.code === 'ENOENT') {
          return null;
        }

        throw error;
      }), 'mac_arbiter_goto_barrier_missing', 15_000);
      assert.equal(await fs.readFile(audit, 'utf8'), 'goto\n');
      assert.equal((await box.state('update/job.json')).stage, 'ready');
      assert.deepEqual(await box.state('current.json'), pointer);
      assert.equal((await box.api('/api/system/runtime-identity')).body.instanceId, owner.instanceId);
    } finally {
      await fs.writeFile(release, '', { flag: 'wx', mode: 0o600 });
    }

    const durable = await awaitAcceptance(async () => {
      const saved = await store.read(task, doc.id);
      const operation = saved?.operations.find(({ id }) => id === operationId);

      return operation?.outcome === 'resume_failed' && operation.receipt ? saved : null;
    }, 'mac_arbiter_completion_missing', 30_000);

    assert.equal(await fs.readFile(audit, 'utf8'), 'goto\ncheck\n');
    assert.equal(durable.operations.length, 1);
    assert.equal(durable.operations[0].receipt?.stage.sequence, doc.identity.stageSequence + 1);
    assert.equal(durable.operations[0].receipt?.targetNode, 'instrument');

    return durable;
  });

  const applied = await observeAdmission(box, 'confirm', async () => {
    const changed = { ...request, customAction: { ...request.customAction, instruction: 'Другое решение.' } };
    const [repeat, conflict, fresh] = await Promise.all([
      box.api(route, request, 3500),
      box.api(route, changed, 3500),
      box.api(route, { ...request, requestId: randomUUID() }, 3500),
    ]);

    assert.equal(repeat.status, 202);
    assert.equal(repeat.body.operationId, operationId);
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error, 'request_conflict');
    assert.equal(fresh.status, 409);
    assert.equal(fresh.body.error, 'release_drain_busy');
    assert.deepEqual(await store.read(task, doc.id), completed);
    assert.equal(await fs.readFile(audit, 'utf8'), 'goto\ncheck\n');
  });

  assert.equal(applied.command?.ok, true, String(applied.command?.error ?? ''));
  assert.equal((await box.state('update/job.json')).stage, 'completed');
  assert.notDeepEqual(await box.state('current.json'), pointer);
}

/**
 * Имитирует потерю сервера только внутри установленной тестовой копии. Сохранённый
 * launcher и PID API сверяются со штатным ctl и текущим приватным поколением.
 */
async function loseFixtureServer(box: Installed) {
  const { stdout } = await box.ctl(['server', 'status', '--json']);
  const status = JSON.parse(stdout);
  const identity = (await box.api('/api/system/runtime-identity')).body;

  assert.equal(status.running, true);
  assert.equal(status.instanceId, identity.instanceId);
  assert.equal(status.process.pid, identity.pid);
  assert.ok(status.launcher.executable.startsWith(path.join(box.root, 'generations') + path.sep)
    || status.launcher.executable === path.join(box.root, 'update/maintenance'));

  const current = await readDarwinProcessIdentity(status.process.pid);

  assert.equal(current.state, 'alive');
  assert.equal(current.identity.starttime, status.process.starttime);
  assert.equal(current.identity.executable, status.process.executable);
  await signalDarwinBuildMember(current.identity, 'KILL', AbortSignal.timeout(5000));

  await awaitAcceptance(async () => !await updateProcessAlive(status.process)
    && !await updateProcessAlive(status.launcher) || null, 'mac_factory_server_exit_unconfirmed', 30_000);

  return status.instanceId;
}

/**
 * Проверяет точку fsync на готовом payload и тот же живой bootstrap в API
 * после потери процесса сервера. Engine остаётся в зарегистрированной SID.
 */
export async function verifyFactoryLaunchRecovery(box: Installed, fixture: Fixture, binary: string) {
  const { controlRoot, stateRoot, profile } = fixture.identity;
  const task = '74';
  const script = fileURLToPath(new URL('./macosFactoryLaunchProbe.cjs', import.meta.url));
  const physical = fixture.runtime.engineBin;
  const input = await fs.readFile(physical, 'utf8');
  const hook = 'set -uo pipefail\n';
  const directory = path.dirname(controlRoot);
  const sentinel = path.join(directory, 'started-engine');
  const release = path.join(directory, 'release-engine');
  const projection = path.join(stateRoot, `t${task}.pipeline`);
  const original = await box.api('/api/system/runtime-identity');

  assert.equal(original.status, 200);
  assert.ok(input.includes(hook));

  for (const file of [sentinel, release]) {
    assert.match(file, /^\/[\w./-]+$/u);
  }

  const holdInitialEngine = [
    `if [[ "\${1:-}" == '${task}' && "\${2:-}" == start ]]; then`,
    `  printf '%s' "$$" > '${sentinel}' || exit 78`,
    `  while [[ ! -e '${release}' ]] && (( SECONDS < 90 )); do /bin/sleep 0.1; done`,
    '  exit 0',
    'fi',
    '',
  ].join('\n');

  const blocked = () => input.replace(hook, () => hook + holdInitialEngine);
  const { stdout } = await withRuntimePinFault(physical, blocked,
    () => execute(fixture.runtime.node, [script, JSON.stringify({
      binary,
      payload: path.join(fixture.runtime.runtimeRoot, 'server/payload.cjs'),
      sentinel,
      input: {
        task,
        attempt: null,
        dispatch: null,
        controlRoot,
        command: fixture.env.FACTORY_DARWIN_BASH,
        args: [physical, task, 'start', '--profile', profile],
        env: fixture.env,
        logFile: path.join(directory, 'launch.log'),
      },
    })], { env: fixture.env, timeout: 30_000 }));
  const live = JSON.parse(stdout);

  assert.match(live.launchId, /^[a-f0-9-]{36}$/u);

  const record = path.join(controlRoot, 'launch-processes', `t${task}.${live.launchId}.json`);
  const recordBefore = await fs.readFile(record);

  assert.equal((await box.api('/api/system/runtime-identity')).body.instanceId, original.body.instanceId);

  try {
    await assert.rejects(fs.lstat(projection), { code: 'ENOENT' });
    assert.equal((await inspectDarwinSession(live.process, undefined, [], true)).state, 'alive');

    const restarted = await loseFixtureServer(box);

    await box.ctl(['server', 'start', '--wait']);
    assert.notEqual((await box.api('/api/system/runtime-identity')).body.instanceId, restarted);
    assert.deepEqual(await fs.readFile(record), recordBefore);

    const inventory = await box.api('/api/tasks?updateOwnership=1');

    assert.equal(inventory.status, 200);
    assert.equal(inventory.body.daemonOwnershipVersion, 1);
    assert.equal(inventory.body.complete, false);
    assert.deepEqual(inventory.body.ownership.filter((row: { task: string }) => row.task === task), [{
      task,
      orchestrator: 'alive',
      runner: 'unknown',
      finalization: 'unknown',
    }]);

    const duplicate = await box.api(`/api/tasks/${task}/launch`, { profile, route: 'debug' });

    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error, 'release_activity_unknown');
    assert.deepEqual(await fs.readFile(record), recordBefore);
    await assert.rejects(fs.lstat(projection), { code: 'ENOENT' });
  } finally {
    await fs.writeFile(release, '', { flag: 'wx', mode: 0o600 });
    await awaitAcceptance(async () => {
      const proof = await inspectDarwinSession(live.process, undefined, [], true);

      return proof.state === 'dead' || null;
    }, 'mac_factory_bootstrap_exit_unconfirmed', 15_000);
    assert.deepEqual(await fs.readFile(record), recordBefore);
    await fs.unlink(record);

    // Процесс помнит увиденную неполную запись. Убираем только свою инстанцию
    // после выхода SID, чтобы штатная финальная уборка не затронула соседа.
    await loseFixtureServer(box);
  }
}
