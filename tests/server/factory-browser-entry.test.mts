import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import {
  parseBrowserCli, browserMailboxContext,
} from '../../server/src/lib/browser/factoryBrowserCli.ts';
import { BROWSER_READY_LEASE_MS, writeBrowserReady } from '../../server/src/lib/browser/browserMailbox.ts';

test('CLI01: закрытые modes/flags и scoped context без secret argv', () => {
  assert.equal(parseBrowserCli(['request', '--input-json', '{"action":"list"}']).mode, 'request');

  for (const argv of [
    ['unknown'], ['key', '--token', 'secret'], ['request', '--token', 'secret'],
    ['request', '--input-json', '{}', '--input-json', '{}'], ['request', '--input-json'],
  ]) {
    assert.throws(() => parseBrowserCli(argv), /browser_cli_invalid/u);
  }

  const env = {
    STATE_DIR: '/synthetic/state',
    FACTORY_RUN_TASK: '7',
    FACTORY_RUN_STAGE: 'CHECK',
    FACTORY_RUN_ID: 'run-a',
    FACTORY_RUN_EPOCH: '1',
    FACTORY_BROWSER_NONCE: 'a'.repeat(64),
  };

  assert.equal(browserMailboxContext(env).nonce, 'a'.repeat(64));
  assert.throws(() => browserMailboxContext({ ...env, FACTORY_RUN_ID: '..' }), /browser_run_invalid/u);
  assert.throws(() => browserMailboxContext({ ...env, FACTORY_BROWSER_NONCE: '' }), /browser_run_invalid/u);
});

test('CLI02: regular FD9 pread сохраняет offset унаследованного status FD7', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'browser-entry-'));
  const file = path.join(root, 'token');

  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(file, 'synthetic-fd-secret\n', { mode: 0o600 });

  const descriptor = await open(file, 'r');

  t.after(() => descriptor.close());
  await unlink(file);

  const module = new URL('../../server/src/lib/browser/factoryBrowserCli.ts', import.meta.url).href;
  const source = `
    import fs from 'node:fs';
    const {readBrowserPublisherToken} = await import(process.argv[1]);
    const token = await readBrowserPublisherToken();
    process.stdout.write(JSON.stringify({token, status:fs.readFileSync(7,'utf8')}));
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, module], {
    stdio: ['ignore', 'pipe', 'pipe', 'ignore', 'ignore', 'ignore', 'ignore', descriptor.fd,
      'ignore', descriptor.fd],
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  let output = '';
  let stderr = '';

  child.stdout!.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr!.on('data', (chunk) => {
    stderr += chunk;
  });

  const timer = setTimeout(() => child.kill('SIGTERM'), 10000);

  try {
    const exit = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });

    assert.equal(exit, 0, stderr);
    assert.deepEqual(JSON.parse(output), {
      token: 'synthetic-fd-secret', status: 'synthetic-fd-secret\n',
    });
  } finally {
    clearTimeout(timer);
  }
});

test('CLI03: отсутствие host.ready и смерть relay имеют отдельный код без утечки логов', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'browser-entry-dead-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  const env = {
    ...process.env,
    FACTORY_STATE: root,
    FACTORY_RUN_TASK: '7',
    FACTORY_RUN_STAGE: 'CHECK',
    FACTORY_RUN_ID: 'run-a',
    FACTORY_RUN_EPOCH: '1',
    FACTORY_BROWSER_NONCE: 'a'.repeat(64),
    NODE_OPTIONS: '',
  };
  const directory = path.join(root, 'logs/runs/t7/CHECK/run-a/control-requests/browser');
  const module = new URL('../../server/src/lib/browser/factoryBrowserCli.ts', import.meta.url).href;
  const mailbox = new URL('../../server/src/lib/browser/browserMailbox.ts', import.meta.url).href;
  const context = browserMailboxContext(env);

  for (const scenario of ['missing-directory', 'missing', 'dead', 'legacy', 'live'] as const) {
    const unavailable = ['missing-directory', 'missing', 'dead'].includes(scenario);

    if (scenario === 'missing') {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(path.join(directory, 'relay.log'), 'PRIVATE_TOKEN_CANARY\n', { mode: 0o600 });
    }

    if (scenario === 'dead') {
      const producer = spawn(process.execPath, ['--input-type=module', '-e', `
        const {writeBrowserReady} = await import(process.argv[1]);
        await writeBrowserReady(JSON.parse(process.argv[2]), 'grigdesk');
      `, mailbox, JSON.stringify(context)], { env, stdio: 'ignore' });

      await new Promise((resolve) => producer.once('close', resolve));
      await delay(BROWSER_READY_LEASE_MS + 25);
    } else if (scenario === 'legacy' || scenario === 'live') {
      await writeBrowserReady(context, scenario === 'legacy' ? 'legacy' : 'grigdesk');
    }

    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      const {main} = await import(process.argv[1]);
      await main(${unavailable
        ? "['request', '--input-json', '{\"action\":\"list\"}']" : "['mode']"});
    `, module], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    const exit = await new Promise((resolve) => child.once('close', resolve));

    if (unavailable) {
      assert.equal(exit, 1, scenario);
      assert.equal(stderr, 'browser_transport_dead\n', scenario);
      assert.equal(stdout, '', scenario);
    } else {
      assert.equal(exit, 0, stderr);
      assert.equal(stdout, `${scenario === 'legacy' ? 'legacy' : 'grigdesk'}\n`);
    }
  }
});
