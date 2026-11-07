import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { readProcessOwner, runtimeOwnerState } from '../../server/src/binary/leases.ts';

import { inspectFactoryRuntimePins, reserveFactoryRuntime } from '../../server/src/lib/factoryRuntimePins.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Настоящий begin движка работает в отдельном control/state без provider и живых данных.
 * Node-обёртка фиксирует фазу до active pointer и вызывает настоящий bind helper.
 */
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-bind-'));

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const cacheDir = path.join(root, 'cache');
  const packageId = 'a'.repeat(64);
  const runtimeRoot = path.join(cacheDir, 'packages', packageId);
  const engineHome = path.join(runtimeRoot, 'engine');
  const engineBin = path.join(engineHome, 'bin/factory');
  const node = path.join(runtimeRoot, 'runtime/node/bin/node');
  const controlRoot = path.join(root, 'control');
  const stateRoot = path.join(root, 'state');
  const profileRoot = path.join(root, 'profiles');

  for (const dir of [path.dirname(engineBin), path.dirname(node), controlRoot, stateRoot, profileRoot]) {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  }

  await fs.writeFile(node, `#!/bin/sh\nexec '${process.execPath}' "$@"\n`, { mode: 0o555 });
  await fs.writeFile(engineBin, '#!/bin/sh\nexit 0\n', { mode: 0o555 });

  const reservation = await reserveFactoryRuntime({
    cacheDir,
    packageId,
    runtimeRoot,
    engineHome,
    engineBin,
    node,
    controlRoot,
    stateRoot,
    profileRoot,
    task: '42',
  });

  return {
    root,
    cacheDir,
    packageId,
    controlRoot,
    stateRoot,
    profileRoot,
    node,
    ...reservation,
  };
}

/**
 * Env передаётся явным списком и FACTORY_FORBID_LIVE не может потеряться при запуске.
 * Shell создаёт только synthetic route bundle и immutable begin без вызова модели.
 */
async function begin(input, hostEnv, observe) {
  return new Promise((resolve) => {
    const child = execFile('bash', [path.join(ROOT, 'tests/engine/unit/runtime-pin-bind.sh')], {
      env: {
        PATH: process.env.PATH,
        HOME: input.root,
        TEST_ROOT: input.root,
        FACTORY_HOME: path.join(ROOT, 'engine'),
        FACTORY_TESTS_HOME: path.join(ROOT, 'tests/engine'),
        FACTORY_TESTING: '1',
        FACTORY_FORBID_LIVE: '1',
        FACTORY_CONTROL_ROOT: input.controlRoot,
        FACTORY_STATE: input.stateRoot,
        STATE_DIR: input.stateRoot,
        FACTORY_PROFILES_DIR: input.profileRoot,
        NODE_BIN: process.execPath,
        ...hostEnv,
      },
      timeout: 30000,
    }, (error, stdout, stderr) => resolve({
      code: error?.code ?? 0,
      stdout,
      stderr,
    }));

    observe?.(child);
  });
}

test('SB17b engine begin связывает runtime до active pointer, без второго attempt writer', async (t) => {
  const input = await fixture(t);
  const result = await begin(input, {
    GRIGDESK_SERVER_RUNTIME_RESERVATION: input.reservation,
    GRIGDESK_SERVER_RUNTIME_NODE: input.node,
    GRIGDESK_SERVER_RUNTIME_PIN_HELPER: path.join(ROOT, 'server/scripts/factoryRuntimePin.mts'),
  });

  assert.equal(result.code, 0, result.stderr);

  const attempt = result.stdout.trim();
  const file = path.join(input.controlRoot, 'server-runtimes', input.scope, `${attempt}.json`);
  const active = path.join(input.controlRoot, 'protocol-v2/tasks/t42/active-attempt.json');

  assert.equal(await fs.access(file).then(() => true, () => false), true,
    'active есть только после durable runtime pin');
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).attempt, attempt);
  assert.equal(JSON.parse(await fs.readFile(active, 'utf8')).attemptId, attempt);
});

for (const missing of ['RESERVATION', 'NODE', 'PIN_HELPER']) {
  test(`SB17b partial-env без ${missing} даёт 78 до active/provider`, async (t) => {
    const input = await fixture(t);
    const env = {
      GRIGDESK_SERVER_RUNTIME_RESERVATION: input.reservation,
      GRIGDESK_SERVER_RUNTIME_NODE: input.node,
      GRIGDESK_SERVER_RUNTIME_PIN_HELPER: path.join(ROOT, 'server/scripts/factoryRuntimePin.mts'),
    };

    delete env[`GRIGDESK_SERVER_RUNTIME_${missing}`];

    const result = await begin(input, env);

    assert.equal(result.code, 78, result.stderr);
    assert.equal(await fs.access(path.join(input.controlRoot, 'protocol-v2/tasks/t42/active-attempt.json'))
      .then(() => true, () => false), false, 'active pointer отсутствует');
  });
}

test('SB17b all-absent сохраняет legacy begin', async (t) => {
  const input = await fixture(t);
  const result = await begin(input, {});

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout.trim(), /^a_[a-f0-9]{32}$/u);
});


test('SB17c отказ bind сохраняет orphan attempt и reservation до provider boundary', async (t) => {
  const input = await fixture(t);
  const reservation = JSON.parse(await fs.readFile(input.reservation, 'utf8'));

  reservation.task = '43';
  await fs.writeFile(input.reservation, JSON.stringify(reservation));

  const result = await begin(input, {
    GRIGDESK_SERVER_RUNTIME_RESERVATION: input.reservation,
    GRIGDESK_SERVER_RUNTIME_NODE: input.node,
    GRIGDESK_SERVER_RUNTIME_PIN_HELPER: path.join(ROOT, 'server/scripts/factoryRuntimePin.mts'),
  });

  assert.equal(result.code, 78, result.stderr);
  assert.match(result.stderr, /FACTORY_ERROR=factory_runtime_pin_conflict/u);

  const providerStarted = await fs.access(path.join(input.root, 'provider.marker'))
    .then(() => true, () => false);

  assert.equal(providerStarted, false);
  assert.equal((await fs.readdir(path.join(input.controlRoot, 'protocol-v2/tasks/t42/attempts'))).length, 1);
  assert.equal(await fs.access(input.reservation).then(() => true, () => false), true);
});

test('SB17 регресс: настоящий контракт attempt-state остаётся зелёным', async (t) => {
  const input = await fixture(t);
  const lock = path.join(input.root, 'offline.lock');

  await fs.writeFile(lock, '');

  const result = await new Promise((resolve) => {
    execFile('bash', [path.join(ROOT, 'tests/engine/run-offline.sh'), '--one',
      path.join(ROOT, 'tests/engine/unit/attempt-state.sh')], {
      env: {
        PATH: process.env.PATH,
        HOME: input.root,
        OFFLINE_OUT_LOCK: lock,
      },
      timeout: 120000,
      maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout, stderr) => resolve({
      code: error?.code ?? 0,
      output: `${stdout}${stderr}`,
    }));
  });

  assert.equal(result.code, 0, result.output);
  assert.doesNotMatch(result.output, /^not ok/mu);
  assert.match(result.output, /^1\.\.[1-9][0-9]*$/mu);
});

test('SB17c SIGKILL после final directory сохраняет reservation без active/provider', async (t) => {
  const input = await fixture(t);
  const helper = path.join(input.root, 'barrier-helper.mts');
  const barrier = path.join(input.root, 'final-barrier.json');
  const leasesUrl = new URL('../../server/src/binary/leases.ts', import.meta.url).href;

  await fs.writeFile(helper, `
import fs from 'node:fs/promises';
import {readProcessOwner} from ${JSON.stringify(leasesUrl)};
const owners = [await readProcessOwner(process.pid), await readProcessOwner(process.ppid)];
await fs.writeFile(${JSON.stringify(barrier + '.tmp')}, JSON.stringify(owners));
await fs.rename(${JSON.stringify(barrier + '.tmp')}, ${JSON.stringify(barrier)});
setInterval(() => {}, 1000);
`, { mode: 0o600 });

  const abort = new AbortController();
  const watcher = fs.watch(input.root, { signal: abort.signal });
  const deadline = setTimeout(() => abort.abort(), 10000);
  const reached = (async () => {
    for await (const event of watcher) {
      if (event.filename === 'final-barrier.json') {
        return JSON.parse(await fs.readFile(barrier, 'utf8'));
      }
    }

    throw new Error('Не достигнут final directory barrier');
  })();
  const running = begin(input, {
    GRIGDESK_SERVER_RUNTIME_RESERVATION: input.reservation,
    GRIGDESK_SERVER_RUNTIME_NODE: input.node,
    GRIGDESK_SERVER_RUNTIME_PIN_HELPER: helper,
  });
  const owners = await reached;

  clearTimeout(deadline);
  abort.abort();
  t.after(async () => {
    for (const owner of owners) {
      if (await runtimeOwnerState(owner) === 'alive') {
        process.kill(owner.pid, 'SIGKILL');
      }
    }

    await running;
  });

  const taskRoot = path.join(input.controlRoot, 'protocol-v2/tasks/t42');
  const entries = await fs.readdir(path.join(taskRoot, 'attempts'));

  assert.equal(entries.length, 1, 'engine успел опубликовать final directory');
  assert.equal(await fs.access(path.join(taskRoot, 'active-attempt.json'))
    .then(() => true, () => false), false);
  process.kill(owners[0].pid, 'SIGKILL');
  await running;
  assert.equal((await inspectFactoryRuntimePins(input)).state, 'protected');
  assert.equal(await fs.access(input.reservation).then(() => true, () => false), true);
  assert.equal(await fs.access(path.join(input.root, 'provider.marker'))
    .then(() => true, () => false), false);
});
