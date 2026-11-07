import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import {
  BROWSER_READY_LEASE_MS, browserMailboxRequest, readBrowserReady,
} from '../../server/src/lib/browser/browserMailbox.ts';
import { startBrowserSocket } from '../../server/src/lib/browser/browserSocket.ts';

test('relay обновляет lease во время долгой команды; после SIGKILL readiness истекает',
  { timeout: 15000 }, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'browser-relay-'));
    const stateDir = path.join(root, 'state');
    const directory = path.join(stateDir, 'logs/runs/t77/CHECK/run-a/control-requests/browser');
    const context = {
      stateDir,
      task: '77',
      stage: 'CHECK',
      runId: 'run-a',
      epoch: '1',
      nonce: 'a'.repeat(64),
    };
    let enter = () => {};
    let release = () => {};
    let calls = 0;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });

    await mkdir(directory, { recursive: true, mode: 0o700 });

    const server = await startBrowserSocket({
      file: path.join(root, 'broker.sock'),
      owner: async () => 'task:fixture',
      probe: () => ({ mode: 'grigdesk', available: true }),
      invoke: async () => {
        calls += 1;
        enter();
        await waiting;

        return { tabs: [] };
      },
    });
    const token = await open(path.join(root, 'token'), 'wx+', 0o600);

    await token.writeFile('synthetic-relay-token\n');

    const module = new URL('../../server/src/lib/browser/factoryBrowserCli.ts', import.meta.url).href;
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      const {main} = await import(process.argv[1]);
      await main(process.argv.slice(2));
    `, module, 'relay',
    '--control-root', path.join(root, 'control'), '--state-dir', stateDir,
    '--profiles-dir', path.join(root, 'profiles'), '--routes-dir', path.join(root, 'routes'),
    '--task', '77', '--stage', 'CHECK', '--run-id', 'run-a', '--epoch', '1',
    '--attempt-id', `a_${'a'.repeat(32)}`, '--socket', server.file,
    '--parent-pid', String(process.pid)], {
      env: {
        ...process.env,
        FACTORY_STATE: stateDir,
        FACTORY_RUN_TASK: context.task,
        FACTORY_RUN_STAGE: context.stage,
        FACTORY_RUN_ID: context.runId,
        FACTORY_RUN_EPOCH: context.epoch,
        FACTORY_BROWSER_NONCE: context.nonce,
        NODE_OPTIONS: '',
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore',
        'ignore', token.fd],
    });
    let stderr = '';
    const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));

    child.stderr!.on('data', (chunk) => {
      stderr += chunk;
    });
    t.after(async () => {
      release();
      child.kill('SIGKILL');
      await exited;
      await token.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    });

    let ready = false;

    for (let poll = 0; poll < 100 && !ready; poll += 1) {
      ready = await readBrowserReady(context).then(() => true, () => false);

      if (!ready) {
        await delay(20);
      }
    }

    assert.equal(ready, true, stderr);
    assert.equal((await readFile(path.join(directory, 'host.ready'), 'utf8')).includes('validUntil'), false);

    const pending = browserMailboxRequest({ context, input: { action: 'list' } });

    pending.catch(() => undefined);
    await entered;
    await delay(BROWSER_READY_LEASE_MS + 250);
    assert.equal(await readBrowserReady(context), 'grigdesk');
    release();
    assert.deepEqual(await pending, { tabs: [] });
    assert.equal(calls, 1);
    child.kill('SIGKILL');
    await exited;
    await delay(BROWSER_READY_LEASE_MS + 25);
    await assert.rejects(() => readBrowserReady(context), /browser_transport_dead/u);
  });
