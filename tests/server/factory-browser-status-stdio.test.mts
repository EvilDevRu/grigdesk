import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { buildHelper } from '../../server/scripts/sea/helpers.mts';
import { browserMailboxOnce, writeBrowserReady } from '../../server/src/lib/browser/browserMailbox.ts';
import type { MailboxContext } from '../../server/src/lib/browser/browserMailbox.ts';

const SOURCE = path.resolve(import.meta.dirname, '../..');
const NONCE = 'ac'.repeat(32);

/**
 * Fixture собирает собственный status helper и запускает изолированный stdio child.
 * Таймауты RPC и cleanup ограничивают ожидания без доступа к рабочему runtime.
 */
async function fixture(t: TestContext, policy: 'allow' | 'forbid') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'factory-browser-stdio-'));
  const stateDir = path.join(root, 'state');
  const requestDir = path.join(stateDir, 'logs/runs/t77/CHECK/run-fixture.1/control-requests');
  const directory = path.join(requestDir, 'browser');
  const context: MailboxContext = {
    stateDir,
    task: '77',
    stage: 'CHECK',
    runId: 'run-fixture.1',
    epoch: '2',
    nonce: NONCE,
  };
  const built = await buildHelper({
    root: SOURCE,
    manifestPath: path.join(SOURCE, 'server/build/helpers.json'),
    id: 'factory-status-mcp',
    outDir: path.join(root, 'server/runtime/helpers'),
    workDir: path.join(root, 'build'),
  });

  await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir(path.join(root, 'home'), { mode: 0o700 });

  if (policy === 'allow') {
    await writeBrowserReady(context, 'grigdesk');
  }

  const child = spawn(process.execPath, [built.file], {
    cwd: root,
    env: {
      PATH: process.env.PATH || '/usr/bin:/bin',
      HOME: path.join(root, 'home'),
      FACTORY_STATE: stateDir,
      STATE_DIR: stateDir,
      FACTORY_RUN_TASK: context.task,
      FACTORY_RUN_STAGE: context.stage,
      FACTORY_RUN_ID: context.runId,
      FACTORY_RUN_EPOCH: context.epoch,
      FACTORY_STATUS_MODE: 'request',
      FACTORY_STATUS_REQUEST_DIR: requestDir,
      FACTORY_BROWSER_ENABLED: '1',
      FACTORY_ROUTE_BROWSER_POLICY: policy,
      FACTORY_BROWSER_NONCE: NONCE,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  let stderr = '';
  let nextId = 0;
  const pending = new Map<number, {
    resolve(value: any): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  const lines = createInterface({ input: child.stdout });
  const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));

  function rejectPending(error: Error) {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }

    pending.clear();
  }

  child.on('error', (error) => rejectPending(error));
  child.on('close', () => rejectPending(new Error('fixture MCP closed')));
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + String(chunk)).slice(-8192);
  });
  lines.on('line', (line) => {
    output = (output + line + '\n').slice(-65536);

    let value: any;

    try {
      value = JSON.parse(line);
    } catch {
      rejectPending(new Error('fixture invalid JSON-RPC'));

      return;
    }

    const entry = pending.get(value.id);

    if (entry) {
      clearTimeout(entry.timer);
      pending.delete(value.id);
      entry.resolve(value);
    }
  });
  t.after(async () => {
    lines.close();
    rejectPending(new Error('fixture cleanup'));

    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }

    await exited;
    await rm(root, { recursive: true, force: true });
  });

  return {
    context,
    directory,
    logs: () => output + stderr,
    rpc(method: string, params: Record<string, unknown> = {}): Promise<any> {
      const id = ++nextId;

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('fixture MCP timeout'));
        }, 5000);

        pending.set(id, {
          resolve,
          reject,
          timer
        });
        child.stdin.write(JSON.stringify({
          jsonrpc: '2.0',
          id,
          method,
          params
        }) + '\n', (error) => {
          if (error) {
            clearTimeout(timer);
            pending.delete(id);
            reject(error);
          }
        });
      });
    },
  };
}

/**
 * Публикация одного encrypted request служит наблюдаемым барьером теста.
 * Опрос ограничен сроком и не считает фиксированную задержку доказательством успеха.
 */
async function waitRequest(directory: string) {
  for (let index = 0; index < 500; index += 1) {
    const files = (await readdir(directory)).filter((file) => file.endsWith('.browser'));

    if (files.length === 1) {
      return path.join(directory, files[0]!);
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error('fixture request was not published');
}

test('BR-S01: compiled descriptor + encrypted mailbox + MCP screenshot image',
  { timeout: 20000 }, async (t) => {
    const f = await fixture(t, 'allow');
    const listed = await f.rpc('tools/list');

    assert.deepEqual(listed.result.tools.map((tool: any) => tool.name),
      ['stage_progress', 'stage_result', 'grigdesk_browser']);

    const response = f.rpc('tools/call', {
      name: 'grigdesk_browser', arguments: { action: 'screenshot', tabId: 'tab-one' },
    });
    // Обработчик отказа ставится сразу: ошибка публикации не создаёт unhandled promise.
    void response.catch(() => undefined);

    const request = await waitRequest(f.directory);
    const ciphertext = await readFile(request, 'utf8');

    assert.equal(ciphertext.includes('tab-one'), false);
    assert.equal(ciphertext.includes(NONCE), false);

    let calls = 0;

    await browserMailboxOnce({
      context: f.context,
      seen: new Set(),
      invoke: async (input) => {
        calls += 1;
        assert.deepEqual(input, { action: 'screenshot', tabId: 'tab-one' });

        return { format: 'grigdesk-work-content-v1', content: [
          {
            type: 'image',
            mimeType: 'image/jpeg',
            data: 'AQ=='
          },
        ] };
      },
    });

    const reply = await response;

    assert.equal(calls, 1);
    assert.equal(reply.error, undefined);
    assert.deepEqual(reply.result.content, [{
      type: 'image',
      mimeType: 'image/jpeg',
      data: 'AQ=='
    }]);
    assert.deepEqual(reply.result.structuredContent, { ok: true, untrusted: true });
    assert.equal(JSON.stringify(reply).includes('imagePath'), false);
    assert.equal(f.logs().includes(NONCE), false);
  });

test('BR-S02: forbid не публикует descriptor и отвергает raw tools/call до mailbox',
  { timeout: 20000 }, async (t) => {
    const f = await fixture(t, 'forbid');
    const listed = await f.rpc('tools/list');

    assert.deepEqual(listed.result.tools.map((tool: any) => tool.name), ['stage_progress', 'stage_result']);

    const reply = await f.rpc('tools/call', {
      name: 'grigdesk_browser', arguments: { action: 'list' },
    });

    assert.equal(reply.result.isError, true);
    assert.deepEqual(reply.result.structuredContent, { ok: false, error: 'browser_unavailable' });
    assert.deepEqual(await readdir(f.directory), []);
    assert.equal(f.logs().includes(NONCE), false);
  });
