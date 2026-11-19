import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import path from 'node:path';

import { readDarwinProcessIdentity } from '../../shared/node/processIdentity.ts';
import { awaitAcceptance, type platformFixture } from './platformReleaseAcceptance.mts';

type Installed = Awaited<ReturnType<typeof platformFixture>>;

const port = 9229;
const endpoint = `http://127.0.0.1:${port}/json/list`;

/**
 * Отправляет одну команду только inspector проверяемого fixture worker.
 * Выражение всегда начинается со сверки PID, а сам клиент закрывается после ответа.
 */
async function evaluate(url: string, expression: string) {
  assert.match(url, /^ws:\/\/127\.0\.0\.1:9229\/[a-f0-9-]{36}$/u);

  const socket = new WebSocket(url);
  const signal = AbortSignal.timeout(5000);

  try {
    await once(socket, 'open', { signal });

    const message = once(socket, 'message', { signal });

    socket.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true },
    }));

    const [event] = await message;
    const response = JSON.parse(String(event.data));

    assert.equal(response.id, 1);
    assert.equal(response.error, undefined);
    assert.equal(response.result.exceptionDetails, undefined);

    return response.result.result.value;
  } finally {
    socket.close();
  }
}

/**
 * Открывает штатный Node inspector только у установленного тестового worker на
 * одноразовом раннере. Ставит одноразовый отказ fsync и сразу закрывает порт.
 */
export async function installLaunchFsyncFault(box: Installed, root: string, node: string,
  task: string, witness: string) {
  assert.equal(process.env.GRIGDESK_ACCEPTANCE_DISPOSABLE_MAC, '1');

  const { stdout } = await box.ctl(['server', 'status', '--json']);
  const status = JSON.parse(stdout);
  const http = await box.api('/api/system/runtime-identity');

  assert.equal(status.running, true);
  assert.equal(http.status, 200);
  assert.equal(status.instanceId, http.body.instanceId);
  assert.equal(status.process.pid, http.body.pid);
  assert.equal(status.process.executable, node);

  const reservation = createServer();

  reservation.listen(port, '127.0.0.1');
  await once(reservation, 'listening');

  const closed = once(reservation, 'close');

  reservation.close();
  await closed;

  const current = await readDarwinProcessIdentity(status.process.pid);

  assert.equal(current.state, 'alive');
  assert.equal(current.identity.starttime, status.process.starttime);
  assert.equal(current.identity.executable, node);
  process.kill(current.identity.pid, 'SIGUSR1');

  const url = await awaitAcceptance(async () => {
    const response = await fetch(endpoint, {
      signal: AbortSignal.timeout(1000),
      redirect: 'error',
    });
    const targets = await response.json();

    return Array.isArray(targets) && targets.length === 1 && targets[0]?.type === 'node'
      ? targets[0].webSocketDebuggerUrl as string : null;
  }, 'mac_factory_worker_inspector_missing', 8000);

  const applied = await evaluate(url, `(() => {
    if (process.pid !== ${current.identity.pid} || process.execPath !== ${JSON.stringify(node)}) return false;
    setTimeout(() => process.getBuiltinModule('node:inspector').close(), 300).unref();
    const fs = process.getBuiltinModule('node:fs/promises');
    const path = process.getBuiltinModule('node:path');
    const directory = ${JSON.stringify(path.join(root, 'launch-processes'))};
    const task = ${JSON.stringify(task)};
    const original = fs.open;
    let active = true;
    const restore = () => {
      if (active) fs.open = original;
      active = false;
    };
    fs.open = async (file, ...args) => {
      const handle = await original(file, ...args);
      if (!active || file !== directory) return handle;
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        const records = (await fs.readdir(directory)).filter((name) => name.startsWith('t' + task + '.')
          && name.endsWith('.json'));
        for (const name of records) {
          if (!active) break;
          const row = JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'));
          if (row.phase !== 'registered' || row.owner.pid !== process.pid) continue;
          restore();
          await fs.writeFile(${JSON.stringify(witness)}, JSON.stringify(row), {flag: 'wx', mode: 0o600});
          throw Object.assign(new Error('fixture_directory_fsync'), {code: 'EIO'});
        }
        return sync();
      };
      return handle;
    };
    setTimeout(restore, 75000).unref();
    return true;
  })()`);

  assert.equal(applied, true);
  await awaitAcceptance(async () => {
    try {
      await fetch(endpoint, { signal: AbortSignal.timeout(500), redirect: 'error' });

      return null;
    } catch (error) {
      if ((error as { cause?: { code?: string } }).cause?.code === 'ECONNREFUSED') {
        return true;
      }

      throw error;
    }
  }, 'mac_factory_worker_inspector_still_open', 5000);
}
