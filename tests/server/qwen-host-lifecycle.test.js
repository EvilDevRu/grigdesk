import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { inspectCliLeases } from '../../server/src/lib/providerInstall/leases.ts';
import rawQwen from '../../server/src/lib/executors/qwen.ts';
import { qwenNativeFixture } from '../helpers/qwenNativeFixture.mjs';
import { qwenFixture, runInput, until } from '../helpers/qwenFixture.mjs';

const RUN_SOURCE = `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const stateDir = path.join(path.dirname(process.argv[1]), '..', 'state');
const at = process.argv.indexOf('--');
const unitArg = process.argv.find((value) => value.startsWith('--unit='));
const cwdArg = process.argv.find((value) => value.startsWith('--working-directory='));
const unit = unitArg ? unitArg.slice('--unit='.length) : 'unknown.scope';
const [command, ...commandArgs] = process.argv.slice(at + 1);
const child = spawn(command, commandArgs, {
  cwd: cwdArg ? cwdArg.slice('--working-directory='.length) : undefined,
  stdio: ['inherit', 'inherit', 'inherit', 3],
});

fs.writeFileSync(path.join(stateDir, unit + '.json'),
  JSON.stringify({ pid: child.pid, group: path.join(stateDir, 'cgroup', unit) }));
fs.appendFileSync(path.join(stateDir, 'journal.log'),
  JSON.stringify({ op: 'run', unit, argv: process.argv.slice(2) }) + '\\n');

child.on('exit', () => {
  try {
    fs.unlinkSync(path.join(stateDir, unit + '.json'));
  } catch {}

  process.exit(0);
});
process.on('SIGTERM', () => child.kill('SIGTERM'));
`;

const CTL_SOURCE = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const stateDir = path.join(path.dirname(process.argv[1]), '..', 'state');
const verb = args[1];
const unit = verb === 'kill' ? args[args.length - 1] : args[2];
const file = path.join(stateDir, unit + '.json');
const failStop = fs.existsSync(path.join(stateDir, 'fail-stop'));
const collectOnStop = fs.existsSync(path.join(stateDir, 'collect-on-stop'));
const collectOnKill = fs.existsSync(path.join(stateDir, 'collect-on-kill'));
const read = () => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

fs.appendFileSync(path.join(stateDir, 'journal.log'), JSON.stringify({ op: verb, unit }) + '\\n');

if (verb === 'show') {
  const state = read();

  process.stdout.write(state
    ? 'LoadState=loaded\\nActiveState=active\\nControlGroup=' + state.group + '\\n'
    : 'LoadState=not-found\\nActiveState=inactive\\nControlGroup=\\n');
  process.exit(0);
}

if (!failStop && (collectOnStop || collectOnKill)) {
  const state = read();

  if (!state) {
    process.stderr.write('Unit not loaded\\n');
    process.exit(1);
  }

  if (verb === 'stop' && collectOnKill) {
    process.stderr.write('synthetic stop failed\\n');
    process.exit(1);
  }

  if ((verb === 'stop' && collectOnStop) || (verb === 'kill' && collectOnKill)) {
    // Двойник не владеет cgroup: SIGTERM helper передаёт дочернему fake CLI.
    // Здесь проверяется сборка unit после ошибки команды, реальный SIGKILL проверяется отдельно.
    process.kill(state.pid, 'SIGTERM');

    const deadline = Date.now() + 8000;
    const poll = setInterval(() => {
      if (!read()) {
        clearInterval(poll);
        process.stderr.write('Unit not loaded\\n');
        process.exit(1);
      }

      if (Date.now() > deadline) {
        clearInterval(poll);
        process.exit(2);
      }
    }, 20);

    return;
  }
}

if (verb === 'stop') {
  const state = read();

  if (failStop) {
    process.stderr.write('synthetic manager unavailable\\n');
    process.exit(1);
  }

  if (!state) {
    process.exit(0);
  }

  process.kill(state.pid, 'SIGTERM');

  const deadline = Date.now() + 8000;

  const poll = setInterval(() => {
    if (!fs.existsSync(file)) {
      clearInterval(poll);
      process.exit(0);
    }

    if (Date.now() > deadline) {
      clearInterval(poll);
      process.exit(1);
    }
  }, 20);

  return;
}

if (verb === 'kill') {
  const state = read();

  if (failStop) {
    process.stderr.write('synthetic manager unavailable\\n');
    process.exit(1);
  }

  if (state) {
    try {
      process.kill(state.pid, 'SIGKILL');
    } catch {}
  }

  process.exit(0);
}

process.exit(0);
`;

/**
 * Двойники systemd-run/systemctl живут в своём каталоге фикстуры и не трогают
 * настоящий user manager. Состояние и журнал — файлы внутри fixture.root.
 */
async function managerFixture(t, root) {
  const manager = path.join(root, 'manager');
  const bin = path.join(manager, 'bin');
  const state = path.join(manager, 'state');

  await mkdir(bin, { recursive: true });
  await mkdir(state, { recursive: true });
  await writeFile(path.join(bin, 'systemd-run'), RUN_SOURCE, { mode: 0o755 });
  await writeFile(path.join(bin, 'systemctl'), CTL_SOURCE, { mode: 0o755 });

  const previousRun = process.env.GRIGDESK_QWEN_SYSTEMD_RUN_BIN;
  const previousCtl = process.env.GRIGDESK_QWEN_SYSTEMCTL_BIN;

  process.env.GRIGDESK_QWEN_SYSTEMD_RUN_BIN = path.join(bin, 'systemd-run');
  process.env.GRIGDESK_QWEN_SYSTEMCTL_BIN = path.join(bin, 'systemctl');
  t.after(() => {
    if (previousRun === undefined) {
      delete process.env.GRIGDESK_QWEN_SYSTEMD_RUN_BIN;
    } else {
      process.env.GRIGDESK_QWEN_SYSTEMD_RUN_BIN = previousRun;
    }

    if (previousCtl === undefined) {
      delete process.env.GRIGDESK_QWEN_SYSTEMCTL_BIN;
    } else {
      process.env.GRIGDESK_QWEN_SYSTEMCTL_BIN = previousCtl;
    }
  });

  const journal = async (op) => (await readFile(path.join(state, 'journal.log'), 'utf8'))
    .split('\n').filter(Boolean).map((line) => JSON.parse(line))
    .filter((entry) => entry.op === op);

  return {
    state,
    journal,
    failStop: () => writeFile(path.join(state, 'fail-stop'), '1'),
    heal: () => unlink(path.join(state, 'fail-stop')).catch(() => {}),
    collectOn: (verb) => writeFile(path.join(state, 'collect-on-' + verb), '1'),
  };
}

/**
 * Живой handle открывается с закреплённым ELF и штатным ACP.
 * Путь приложения и режим доступа берутся из выданного тестового профиля.
 */
async function openLive(fixture, options = {}) {
  const spec = runInput(fixture, 'shared-model(openai)', {
    providerSettings: { allowHostAccess: true },
    ...options.input,
  });

  return rawQwen.session.open(spec);
}

/**
 * Двойник launcher имитирует нарушение handshake после проверки настоящего ELF.
 * Он остаётся жив до команды собственного scope и фиксирует входящие методы.
 */
async function breakHandshake(fixture, releaseFile) {
  const launcher = path.join(fixture.root, 'broken-bwrap');
  const journal = path.join(fixture.root, 'acp.jsonl');

  await writeFile(launcher, `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const journal = ${JSON.stringify(journal)};
const releaseFile = ${JSON.stringify(releaseFile || '')};
setInterval(() => {}, 500);
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const frame = JSON.parse(line);
  fs.appendFileSync(journal, JSON.stringify(frame) + '\\n');
  if (frame.method !== 'initialize') return;
  const send = () => process.stdout.write(JSON.stringify({
    jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1, agentInfo: { version: 'wrong' } },
  }) + '\\n');
  if (!releaseFile) { send(); return; }
  const timer = setInterval(() => {
    if (!fs.existsSync(releaseFile)) return;
    clearInterval(timer);
    send();
  }, 20);
});
`, { mode: 0o755 });
  process.env.GRIGDESK_QWEN_BWRAP_BIN = launcher;

  return async () => {
    const lines = await readFile(journal, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') {
        return '';
      }

      throw error;
    });

    return lines.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  };
}

test('Qwen Host lifecycle: отказ handshake держит один scope до подтверждённого close', {
  timeout: 30000,
}, async (t) => {
  const fixture = await qwenFixture(t, { native: true });
  const manager = await managerFixture(t, fixture.root);

  await breakHandshake(fixture);

  const handle = await openLive(fixture);

  fixture.onCleanup(async () => {
    await manager.heal();
    await handle.close();
  });

  await assert.rejects(handle.send({ message: 'Не запускать.', signal: AbortSignal.timeout(15000) }),
    /несовместимый протокол ACP Preview.2/);
  await assert.rejects(handle.send({ message: 'Повтор до закрытия.', signal: AbortSignal.timeout(5000) }),
    /живая сессия недоступна/);

  await manager.failStop();
  await assert.rejects(handle.close());
  assert.equal((await manager.journal('run')).length, 1, 'Новой копии CLI после отказа не создаётся');

  await manager.heal();
  await handle.close();

  const runs = await manager.journal('run');
  const stops = await manager.journal('stop');

  assert.equal(runs.length, 1, 'Повтор close не поднимает второй scope');
  assert.equal(stops.length, 2, 'Повтор close подтверждает тот же unit');
  assert.equal(JSON.stringify(runs[0].argv).includes('sudo'), false, 'R4: запуск без elevation');
  assert.deepEqual(await inspectCliLeases({
    directory: path.join(fixture.dataHome, 'provider-cli-leases'),
    providerId: 'qwen',
  }), [], 'lease закрыт после подтверждённого close');
  assert.equal((await readdir(manager.state)).includes('fail-stop'), false);
});

test('Qwen Host lifecycle: force-close во время initialize без позднего prompt', {
  timeout: 30000,
}, async (t) => {
  const fixture = await qwenFixture(t, { native: true });
  const manager = await managerFixture(t, fixture.root);
  const release = path.join(fixture.root, 'initialize.release');

  const records = await breakHandshake(fixture, release);

  const handle = await openLive(fixture);

  fixture.onCleanup(() => handle.close());

  const send = handle.send({ message: 'Не успеть.', signal: AbortSignal.timeout(20000) });
  const rejected = assert.rejects(send, (error) => error.stopped === true);

  await until(async () => (await records()).some((entry) => entry.method === 'initialize'),
    'initialize ушёл в барьер');

  const closing = handle.close();

  await closing;
  await rejected;

  const runs = await manager.journal('run');

  assert.equal(runs.length, 1, 'Один scope на всё открытие');
  assert.equal((await readdir(manager.state)).filter((file) => file.endsWith('.json')).length, 0,
    'unit погашен подтверждённым close');
  assert.equal((await records()).some((entry) => entry.method === 'session/prompt'), false,
    'Позднего prompt нет');
  assert.deepEqual(await inspectCliLeases({
    directory: path.join(fixture.dataHome, 'provider-cli-leases'),
    providerId: 'qwen',
  }), [], 'lease не утёк');
});

for (const verb of ['stop', 'kill']) {
  test(`Qwen Host lifecycle: исчезнувший scope после ${verb} подтверждает закрытие`, {
    timeout: 30000,
  }, async (t) => {
    const fixture = await qwenNativeFixture(t);
    const manager = await managerFixture(t, fixture.root);
    const handle = await openLive(fixture);

    fixture.onCleanup(() => handle.close());
    await handle.send({ message: 'Закрыть после ответа.', signal: AbortSignal.timeout(12000) });
    await manager.collectOn(verb);

    const result = await handle.close().then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error }),
    );

    assert.equal(result.ok, true, `Завершённый scope должен быть подтверждён: ${result.error || ''}`);
    assert.equal((await manager.journal('run')).length, 1, 'Закрытие не создаёт новый scope');
    assert.equal((await readdir(manager.state)).some((file) => file.endsWith('.json')), false);
    assert.deepEqual(await inspectCliLeases({
      directory: path.join(fixture.dataHome, 'provider-cli-leases'),
      providerId: 'qwen',
    }), [], 'Reader освобождён после подтверждённого завершения');
  });
}
