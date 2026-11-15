import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const worker = fileURLToPath(new URL('../fixtures/codex-app-server/host-native-worker.mjs', import.meta.url));
const binary = process.env.CODEX_BIN || 'codex';
const directory = process.env.GRIGDESK_CODEX_NATIVE_ARTIFACTS || process.env.GRIGDESK_ARTIFACTS_DIR;

/**
 * Недоступный CLI, user bus и tmp-only каталог — препятствие native-проверке, а не RED продукта.
 * Пропуск обязательно отражается в отчёте TESTS и останавливает допуск Host у человека.
 */
async function nativeEnvironment() {
  if (!directory || path.resolve(directory).startsWith(`${os.tmpdir()}/`)) {
    return { reason: 'environment: нужен synthetic native каталог вне неявно writable /tmp' };
  }

  try {
    const version = await execute(binary, ['--version'], { timeout: 10_000 });
    const selected = path.isAbsolute(binary) ? binary
      : (await execute('which', [binary], { timeout: 3000 })).stdout.trim();

    await execute('/usr/bin/systemctl', ['--user', 'show-environment'], { timeout: 3000 });

    return {
      binary: selected,
      version: version.stdout.trim(),
    };
  } catch (error) {
    return { reason: `environment: native CLI/user manager недоступен: ${error.stderr || error.message}` };
  }
}

/**
 * Читается только сохранённая собственная cgroup из ready-файла synthetic владельца.
 * Ошибка доступа не превращается в подтверждение завершения процесса.
 */
async function groupEmpty(group) {
  const events = await readFile(path.join('/sys/fs/cgroup', group, 'cgroup.events'), 'utf8')
    .catch((error) => {
      if (error.code === 'ENOENT') {
        return 'populated 0';
      }

      throw error;
    });

  return /^populated 0$/mu.test(events);
}

/**
 * Родитель запускает и останавливает только UUID service, созданный данным тестом.
 * BindsTo проверяется graceful stop и аварией этого владельца; factory service не затрагивается.
 */
async function nativeOwner(t, selected, scenario) {
  await mkdir(directory, { recursive: true });

  const root = await mkdtemp(path.join(directory, 'codex-host-'));
  const unit = `grigdesk-codex-host-test-${randomUUID()}.service`;
  const runtime = scenario === 'missing-bus' ? path.join(root, 'missing-runtime')
    : process.env.XDG_RUNTIME_DIR;
  const bus = scenario === 'missing-bus' ? `unix:path=${root}/missing-bus`
    : process.env.DBUS_SESSION_BUS_ADDRESS;
  const environment = {
    PATH: process.env.PATH,
    HOME: path.join(root, 'home'),
    CODEX_HOME: path.join(root, 'home'),
    XDG_RUNTIME_DIR: runtime,
    DBUS_SESSION_BUS_ADDRESS: bus,
    GRIGDESK_HOME: path.join(root, 'data'),
    GRIGDESK_ARTIFACTS_DIR: path.join(root, 'artifacts'),
  };
  const envArgs = Object.entries(environment).filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`);

  await mkdir(environment.HOME, { recursive: true });

  const schema = path.join(root, 'schema');

  await execute(selected.binary, ['app-server', 'generate-ts', '--experimental', '--out', schema], {
    env: environment,
    timeout: 20_000,
  });

  const hash = createHash('sha256');

  for (const name of [
    'ThreadStartParams', 'ThreadResumeParams', 'TurnStartParams', 'ThreadStartResponse',
    'ConfigRequirementsReadResponse', 'ConfigRequirements', 'AskForApproval', 'SandboxPolicy',
    'ApprovalsReviewer',
  ]) {
    hash.update(name).update(await readFile(path.join(schema, 'v2', `${name}.ts`)));
  }

  const identity = await stat(selected.binary);

  await writeFile(path.join(root, 'identity.json'), JSON.stringify({
    selected: await realpath(selected.binary),
    version: selected.version,
    size: identity.size,
    mtimeMs: identity.mtimeMs,
    schemaFingerprint: hash.digest('hex'),
  }));

  const child = spawn('/usr/bin/systemd-run', [
    '--user', '--wait', '--collect', '--quiet', `--unit=${unit}`,
    '--property=RuntimeMaxSec=90s', '--property=TimeoutStopSec=3s',
    '--property=KillMode=control-group', '--property=MemoryMax=1G',
    '--', '/usr/bin/env', '-i', ...envArgs, process.execPath, worker, root, selected.binary, scenario,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';

  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code));
  });

  t.after(async () => {
    await execute('/usr/bin/systemctl', ['--user', 'stop', unit], { timeout: 10_000 }).catch(() => { });
    await done;
    await rm(root, {
      recursive: true,
      force: true,
    });
  });

  return {
    root,
    unit,
    done,
    error: async () => (await readFile(path.join(root, 'failure.txt'), 'utf8').catch(() => stderr)),
  };
}

/**
 * Ограниченное ожидание ready учитывает ранний отказ worker и показывает его исходную причину.
 * Пустой файл или истёкший срок не выдаются за готовый native scope.
 */
async function waitReady(owner) {
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    const ready = await readFile(path.join(owner.root, 'ready.json'), 'utf8').catch(() => '');
    const failure = await readFile(path.join(owner.root, 'failure.txt'), 'utf8').catch(() => '');

    assert.equal(failure, '', failure);

    if (ready) {
      return JSON.parse(ready);
    }

    await pause(20);
  }

  assert.fail(`Native owner не сообщил ready: ${await owner.error()}`);
}

test('Native Host: sibling/detached/send/resume/оба перехода и lifecycle API', {
  timeout: 110_000,
}, async (t) => {
  const selected = await nativeEnvironment();

  if (selected.reason) {
    return t.skip(selected.reason);
  }

  const foreign = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);

  t.after(() => foreign.kill('SIGKILL'));

  const owner = await nativeOwner(t, selected, 'sequence');
  const code = await owner.done;

  assert.equal(code, 0, await owner.error());

  const result = JSON.parse(await readFile(path.join(owner.root, 'result.json'), 'utf8'));

  assert.equal(result.sibling, 'host');
  assert.equal(result.profile.sandbox, 'danger-full-access');
  assert.equal(result.off.sandbox, 'workspace-write');
  assert.ok(result.requests >= 10);
  assert.doesNotThrow(() => process.kill(foreign.pid, 0));

  for (const owner of result.owners) {
    assert.equal(await groupEmpty(owner.group), true);
  }
});

for (const scenario of ['graceful', 'crash']) {
  test(`Native Host: ${scenario} synthetic app owner закрывает detached, foreign жив`, {
    timeout: 90_000,
  }, async (t) => {
    const selected = await nativeEnvironment();

    if (selected.reason) {
      return t.skip(selected.reason);
    }

    const foreign = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);

    t.after(() => foreign.kill('SIGKILL'));

    const owner = await nativeOwner(t, selected, scenario);
    const ready = await waitReady(owner);
    const args = scenario === 'crash'
      ? ['--user', 'kill', '--kill-whom=main', '--signal=KILL', owner.unit]
      : ['--user', 'stop', owner.unit];

    await execute('/usr/bin/systemctl', args, { timeout: 10_000 });
    await owner.done;

    const deadline = Date.now() + 10_000;

    while (!await groupEmpty(ready.detached.owner.group) && Date.now() < deadline) {
      await pause(20);
    }

    assert.equal(await groupEmpty(ready.detached.owner.group), true);

    for (const pid of ready.detached.pids) {
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    }

    await writeFile(path.join(ready.detached.directory, 'release'), '1');
    await pause(100);

    for (const name of ['normal', 'setsid', 'double']) {
      await assert.rejects(readFile(path.join(ready.detached.directory, `${name}.late`)), { code: 'ENOENT' });
    }

    assert.doesNotThrow(() => process.kill(foreign.pid, 0));
    assert.equal(await readFile(ready.sibling, 'utf8'), 'host');
  });
}

test('Native Host: недоступный bus отказывает до рабочего turn', { timeout: 30_000 }, async (t) => {
  const selected = await nativeEnvironment();

  if (selected.reason) {
    return t.skip(selected.reason);
  }

  const owner = await nativeOwner(t, selected, 'missing-bus');

  assert.equal(await owner.done, 0, await owner.error());
  assert.deepEqual(JSON.parse(await readFile(path.join(owner.root, 'result.json'), 'utf8')),
    { unavailableBus: true });
});
