import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  EventEmitter
} from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PassThrough
} from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createAcpClient
} from '../../server/src/lib/acp/client.ts';

test('fake ACP пишет startup только явно и проверяет секретное окружение без его имён', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fake-acp-startup-'));
  const scenario = path.join(root, 'scenario.json');
  const log = path.join(root, 'requests.jsonl');
  const fake = fileURLToPath(new URL('../fixtures/deepseek-harness/fakeAcp.mts', import.meta.url));

  t.after(() => fs.rm(root, {
    recursive: true,
    force: true,
  }));

  for (const captureStartup of [false, true]) {
    await fs.writeFile(scenario, JSON.stringify({ captureStartup }));
    execFileSync(process.execPath, [fake, '--scenario', scenario, '--log', log], {
      input: '',
      timeout: 5000,
      env: { DEEPSEEK_API_KEY: 'synthetic-startup-secret' },
    });

    const raw = await fs.readFile(log, 'utf8').catch(() => '');

    assert.equal(raw.includes('DEEPSEEK_API_KEY'), false);
    assert.equal(raw.includes('synthetic-startup-secret'), false);

    if (captureStartup) {
      assert.equal(JSON.parse(raw).sensitiveEnvPresent, true);
    } else {
      assert.equal(raw, '');
    }
  }
});

/**
 * Pipes моделируют только байтовую границу внешнего процесса.
 * Реальный общий ACP decoder обязан восстановить UTF-8 и последний кадр до EOF.
 */
function pipes() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
  });
}

test('строгий ACP восстанавливает разрезанный UTF-8 и последний response без newline', async () => {
  const child = pipes();
  const updates = [];
  const client = createAcpClient(child, {
    strict: true,
    onNotification: (method, params) => updates.push(params),
  });
  const pending = client.request('session/prompt', {});
  const bytes = Buffer.from([
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        text: 'Привет'
      }
    }),
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: {
        stopReason: 'end_turn'
      }
    }),
  ].join('\n'));

  for (const byte of bytes) {
    child.stdout.write(Buffer.from([byte]));
  }

  child.stdout.end();

  assert.equal((await pending).stopReason, 'end_turn');
  assert.deepEqual(updates, [{
    text: 'Привет'
  }]);
  client.close();
});

test('последний frame принимается при exit, даже если дочерний tool удерживает stdout', async () => {
  const child = pipes();
  const client = createAcpClient(child, { strict: true });
  const pending = client.request('session/prompt', {});

  child.stdout.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result: { stopReason: 'end_turn' },
  }));
  child.emit('exit', 0, null);

  assert.equal((await pending).stopReason, 'end_turn');
  client.close();
});

for (const input of ['noise\n', '{broken}\n', 'x'.repeat(1000)]) {
  test(`повреждённый или чрезмерный frame отклоняет pending: ${input.length}`, async () => {
    const child = pipes();
    const client = createAcpClient(child, {
      strict: true,
      maxLineBytes: 100
    });
    const pending = client.request('initialize');

    child.stdout.write(input);

    await assert.rejects(pending, /ACP/u);
    client.close();
  });
}

test('ошибка stdin завершает запрос и не становится unhandled error', async () => {
  const child = pipes();
  const client = createAcpClient(child, {
    strict: true
  });
  const pending = client.request('initialize');

  child.stdin.emit('error', Object.assign(new Error('pipe closed'), {
    code: 'EPIPE'
  }));

  await assert.rejects(pending, {
    code: 'EPIPE'
  });
  client.close();
});
