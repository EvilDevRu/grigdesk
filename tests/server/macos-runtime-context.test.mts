import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Writable as WritableStream } from 'node:stream';

import { legacyRuntimeContext } from '../../server/src/lib/factoryLegacyRuntimeContext.ts';
import { readExistingFactoryRuntimePin } from '../../server/src/lib/factoryRuntimePins.ts';

const checkout = path.resolve(import.meta.dirname, '../..');

test('Darwin runtime writer verifies the exact FD context before publishing a pin', async (t) => {
  assert.equal(process.platform, 'darwin');

  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'gd-context-'));
  const task = '7';
  const attempt = 'a_' + 'c'.repeat(32);
  const profile = 'demo';
  const input = {
    task,
    attempt,
    profile,
    cacheDir: path.join(root, 'cache'),
    stateRoot: path.join(root, 'state'),
    controlRoot: path.join(root, 'control'),
    profileRoot: path.join(root, 'profiles'),
  };
  const taskRoot = path.join(input.controlRoot, 'protocol-v2/tasks/t7');
  const attemptRoot = path.join(taskRoot, 'attempts', attempt);
  const bytes = JSON.stringify({
    schema: 1,
    protocolVersion: 2,
    taskId: task,
    attemptId: attempt,
    profile,
    routesDir: path.join(root, 'routes'),
    catalogHash: 'b'.repeat(64),
  });
  const selected = {
    packageId: null,
    runtimeRoot: await fs.realpath(checkout),
    engineHome: await fs.realpath(path.join(checkout, 'engine')),
    engineBin: await fs.realpath(path.join(checkout, 'engine/bin/factory')),
    node: await fs.realpath(process.execPath),
  };

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  for (const directory of [attemptRoot, input.stateRoot, input.profileRoot]) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  }

  await fs.writeFile(path.join(taskRoot, 'protocol.json'),
    '{"schema":1,"protocolVersion":2}', { mode: 0o400 });
  await fs.writeFile(path.join(attemptRoot, 'attempt.json'), bytes, { mode: 0o400 });
  await fs.writeFile(path.join(attemptRoot, 'attempt.sha256'),
    createHash('sha256').update(bytes).digest('hex'), { mode: 0o400 });

  const context = await legacyRuntimeContext(input, selected);

  /**
   * Calls the production writer with the ordinary stdio/FD3 child interface.
   * Each fault is bound to a separate descriptor state.
   */
  async function call(content: string | undefined) {
    const child = spawn(process.execPath, [
      path.join(checkout, 'server/scripts/factoryRuntimePin.mts'), 'commit-legacy',
      task, attempt, profile, input.controlRoot,
    ], {
      cwd: checkout,
      env: process.env,
      stdio: content === undefined ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe', 'pipe'],
      signal: AbortSignal.timeout(45_000),
    });
    const out: Buffer[] = [];
    const errors: Buffer[] = [];

    child.stdout!.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr!.on('data', (chunk: Buffer) => errors.push(chunk));

    if (content !== undefined) {
      const pipe = child.stdio[3] as WritableStream;

      pipe.on('error', () => pipe.destroy());
      pipe.end(content);
    }

    const [code] = await once(child, 'close');

    return {
      code,
      stdout: Buffer.concat(out).toString(),
      stderr: Buffer.concat(errors).toString(),
    };
  }

  for (const [payload, error] of [
    [undefined, 'missing'],
    ['', 'eof'],
    [context.replace('"task":"7"', '"task":"8"'), 'invalid'],
  ] as const) {
    const outcome = await call(payload);

    assert.equal(outcome.code, 78, outcome.stderr);
    assert.match(outcome.stderr, new RegExp('^FACTORY_ERROR=factory_runtime_context_' + error + '$', 'm'));
    await assert.rejects(fs.lstat(input.cacheDir), { code: 'ENOENT' });
    assert.equal(await readExistingFactoryRuntimePin(input), null);
  }

  const result = await call(context);

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), await readExistingFactoryRuntimePin(input));
  assert.equal(JSON.parse(result.stdout).node, selected.node);
  assert.equal(await fs.readFile(path.join(attemptRoot, 'attempt.json'), 'utf8'), bytes);

  const intent = path.join(input.controlRoot, 'runtime-migration-intents/t7', attempt + '.json');

  await assert.rejects(fs.lstat(intent), { code: 'ENOENT' });
});
