import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { reserveFactoryRuntime, bindFactoryRuntime } from '../../server/src/lib/factoryRuntimePins.ts';
import {
  routeGateArgs, routeResumeArgs, runRouteEngine, spawnRouteEngine,
} from '../../server/src/lib/factoryRouteCli.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Два runtime имеют разные engine markers, собственные Node/ресурсы и общий control.
 * Immutable identity имитирует уже остановленную попытку, не выдавая provider writer.
 */
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'attempt-resume-'));

  const savedHome = process.env.HOME;
  const savedPath = process.env.PATH;

  process.env.HOME = root;
  t.after(async () => {
    process.env.HOME = savedHome;
    process.env.PATH = savedPath;
    await fs.rm(root, { recursive: true, force: true });
  });

  const dataHome = path.join(root, 'data');
  const cacheDir = path.join(dataHome, 'runtimes/server');
  const controlRoot = path.join(root, 'control');
  const stateRoot = path.join(root, 'state');
  const profileRoot = path.join(root, 'profiles');
  const attempt = `a_${'1'.repeat(32)}`;
  const task = '42';
  const attemptDir = path.join(controlRoot, 'protocol-v2/tasks/t42/attempts', attempt);

  for (const dir of [controlRoot, stateRoot, profileRoot, attemptDir]) {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  }

  const variants = {};

  for (const label of ['A', 'B']) {
    const packageId = label.toLowerCase().repeat(64);
    const runtimeRoot = path.join(cacheDir, 'packages', packageId);
    const engineHome = path.join(runtimeRoot, 'engine');
    const engineBin = path.join(engineHome, 'bin/factory');
    const node = path.join(runtimeRoot, 'runtime/node/bin/node');
    const helpers = path.join(runtimeRoot, 'server/runtime/helpers');

    for (const dir of [path.dirname(engineBin), path.dirname(node), helpers]) {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    }

    await fs.writeFile(node, `#!/bin/sh\nexec '${process.execPath}' "$@"\n`, { mode: 0o555 });
    await fs.writeFile(path.join(helpers, 'factory-runtime-pin.mjs'),
      `import { main } from ${JSON.stringify(new URL('../../server/scripts/factoryRuntimePin.mts',
        import.meta.url).href)}; process.exitCode = await main();\n`, { mode: 0o444 });
    await fs.writeFile(path.join(helpers, 'helpers.json'), JSON.stringify({
      schema: 1,
      helpers: [{ id: 'factory-runtime-pin', entry: 'server/scripts/factoryRuntimePin.mts' }],
    }), { mode: 0o444 });
    await fs.writeFile(engineBin, `#!/bin/bash\n` +
      `printf '%s\\n' '${label}' >> '${path.join(root, 'markers')}'\n` +
      `printf '%s\\n' "$FACTORY_HOME|$NODE_BIN|$GRIGDESK_DEEPSEEK_NODE_BIN"\n`, { mode: 0o555 });

    variants[label] = {
      packageId,
      runtimeRoot,
      engineHome,
      engineBin,
      node,
      cacheDir,
    };
  }

  await fs.writeFile(path.join(controlRoot, 'protocol-v2/tasks/t42/protocol.json'),
    JSON.stringify({ schema: 1, protocolVersion: 2 }), { mode: 0o400 });

  const metadata = JSON.stringify({
    schema: 2,
    protocolVersion: 2,
    taskId: task,
    attemptId: attempt,
    profile: 'sample',
    routesDir: profileRoot,
    catalogHash: 'c'.repeat(64),
  });

  await fs.writeFile(path.join(attemptDir, 'attempt.json'), metadata, { mode: 0o400 });
  await fs.writeFile(path.join(attemptDir, 'attempt.sha256'),
    createHash('sha256').update(metadata).digest('hex') + '\n', { mode: 0o400 });

  const configFor = (label) => ({
    rootDir: variants[label].runtimeRoot,
    factoryHome: variants[label].engineHome,
    factoryBin: variants[label].engineBin,
    dataHome,
    factoryControlDir: controlRoot,
    profilesDir: profileRoot,
    stateDir: stateRoot,
    factoryConfigRoot: path.join(root, 'config'),
    routesDir: profileRoot,
    installationBin: path.join(root, 'bin'),
    runtime: variants[label],
  });

  return {
    root,
    task,
    attempt,
    attemptDir,
    controlRoot,
    stateRoot,
    profileRoot,
    variants,
    configFor,
  };
}

/**
 * Pin A создан тем же host bind, который вызывает engine begin.
 * Во время действий сервера B доверенные bytes попытки остаются неизменными.
 */
async function pinA(input) {
  const reservation = await reserveFactoryRuntime({ ...input, ...input.variants.A });

  return bindFactoryRuntime({ ...input, reservation: reservation.reservation });
}

test('SB18 serverB gate/resume используют engine и helper Node A; rollback тоже', async (t) => {
  const input = await fixture(t);

  await pinA(input);

  const configB = input.configFor('B');
  const identity = {
    task: input.task,
    attempt: input.attempt,
    profile: 'sample',
  };
  const gate = await runRouteEngine(configB, routeGateArgs(configB, {
    ...identity,
    node: 'gate_accept',
    decision: 'approved',
  }));

  assert.equal(gate.ok, true, gate.stderr);
  assert.match(gate.stdout, new RegExp(input.variants.A.engineHome), 'FACTORY_HOME закреплён на A');
  assert.match(gate.stdout, new RegExp(input.variants.A.node), 'helper Node тоже A');

  const resumed = await runRouteEngine(configB, routeResumeArgs(configB, identity));

  assert.equal(resumed.ok, true, resumed.stderr);
  assert.equal(await fs.readFile(path.join(input.root, 'markers'), 'utf8'), 'A\nA\n');

  const rollback = {
    ...input.configFor('A'),
    rootDir: ROOT,
    factoryHome: path.join(ROOT, 'engine'),
    factoryBin: path.join(ROOT, 'engine/bin/factory'),
  };

  delete rollback.runtime;

  const rolledBack = await runRouteEngine(rollback, routeResumeArgs(rollback, identity));

  assert.equal(rolledBack.ok, true, rolledBack.stderr);
  assert.equal(await fs.readFile(path.join(input.root, 'markers'), 'utf8'), 'A\nA\nA\n');
});

test('SB18 missing authority и incompatible pin дают typed failure до gate mutation', async (t) => {
  const input = await fixture(t);
  const pin = await pinA(input);
  const authority = path.join(input.controlRoot, 'server-runtimes', pin.scope, `${input.attempt}.json`);
  const config = input.configFor('B');
  const args = routeResumeArgs(config, {
    task: input.task,
    attempt: input.attempt,
    profile: 'sample',
  });

  await fs.unlink(authority);

  const missing = await runRouteEngine(config, args);

  assert.equal(missing.ok, false, 'нет pin — нет мутации gate');
  assert.equal(missing.failure?.error, 'factory_runtime_pin_missing');
  await fs.writeFile(authority, JSON.stringify({ ...pin, protocol: 'route-v1' }), { mode: 0o600 });

  const incompatible = await runRouteEngine(config, args);

  assert.equal(incompatible.ok, false);
  assert.equal(incompatible.failure?.error, 'factory_runtime_pin_invalid');
  assert.equal(await fs.access(path.join(input.root, 'markers')).then(() => true, () => false), false);
});

/**
 * Реальный immutable route содержит human gate и terminal approved переход.
 * Engine libraries копируются в A/B; entry fixture только направляет команды к их trusted API.
 */
async function realGateFixture(t) {
  const input = await fixture(t);
  const { RoutesStore } = await import('../../server/src/modules/routes/store.ts');
  const { makeCatalogInput } = await import('../fixtures/routes-editor.mjs');
  const content = makeCatalogInput();
  const route = content.routes.quick.route;
  const gate = route.nodes.find((node) => node.id === 'gate_accept');

  gate.on = { approved: { stop: 'done' }, rejected: { stop: 'human' } };
  route.nodes = [gate];
  route.sequence = { main: ['gate_accept'], tail: [] };
  route.entry = 'gate_accept';
  route.bootstrap = 'skip';

  const store = new RoutesStore({ baseDir: input.profileRoot });
  const published = await store.publishRoute('sample', 'quick', { route, prompts: {} });

  await store.publishCatalog('sample', {
    catalog: {
      schema: 2,
      profile: 'sample',
      routes: { quick: published.routeHash },
      bootstrap: { file: 'bootstrap/scout.json' },
    },
    bootstrap: content.bootstrap,
    prompts: content.bootstrapPrompts,
  }, { expectedCatalogHash: null });

  for (const label of ['A', 'B']) {
    const runtime = input.variants[label];

    await fs.cp(path.join(ROOT, 'engine'), runtime.engineHome, { recursive: true, force: true });
    await fs.cp(path.join(ROOT, 'schemas'), path.join(runtime.runtimeRoot, 'schemas'), { recursive: true });
    await fs.chmod(runtime.engineBin, 0o755);
    await fs.writeFile(runtime.engineBin, `#!/bin/bash
set -uo pipefail
printf '%s\\n' '${label}' >> '${path.join(input.root, 'markers')}'
task=$1
action=$2
shift 2
attempt=''
while (( $# )); do
  case "$1" in
    --attempt) attempt=$2; shift 2 ;;
    --routes-dir) routes_dir=$2; shift 2 ;;
    --state-dir) export STATE_DIR=$2 FACTORY_STATE=$2 FACTORY_ROUTE_STATE_DIR=$2; shift 2 ;;
    --control-dir) export FACTORY_CONTROL_ROOT=$2; shift 2 ;;
    --profile|--node|--decision) shift 2 ;;
    *) shift ;;
  esac
done
source "$FACTORY_HOME/lib/attempt-stage-state.sh"
case "$action" in
  start)
    attempt=$(attempt_state_begin_v2 "$task" sample "$routes_dir") || exit $?
    attempt_state_select_route_v2 "$task" "$attempt" quick >/dev/null || exit $?
    attempt_stage_state_init_v2 "$task" "$attempt" quick >/dev/null || exit $?
    attempt_stage_state_pause_v2 "$task" "$attempt" gate_accept 'human gate' >/dev/null || exit $?
    printf '%s\\n' "$attempt"
    ;;
  gate) attempt_stage_state_commit_v2 "$task" "$attempt" gate_accept approved >/dev/null ;;
  resume)
    attempt_state_resume_v2 "$task" "$attempt" >/dev/null || exit $?
    attempt_stage_state_read_v2 "$task" "$attempt"
    ;;
esac
`, { mode: 0o555 });
    await fs.chmod(runtime.engineBin, 0o555);
  }

  return input;
}

test('SB18 настоящий gate: B сохраняет attempt/catalog/route и один approved result A', async (t) => {
  const input = await realGateFixture(t);
  const configA = input.configFor('A');
  const serverA = await hostProcess(t, configA);
  const start = await serverA.call( ['42', 'start', '--profile', 'sample',
    '--routes-dir', input.profileRoot, '--state-dir', input.stateRoot,
    '--control-dir', input.controlRoot]);

  assert.equal(start.ok, true, JSON.stringify(start));

  const attempt = start.stdout.trim();
  const directory = path.join(input.controlRoot, 'protocol-v2/tasks/t42/attempts', attempt);
  const before = await fs.readFile(path.join(directory, 'attempt.json'), 'utf8');
  const pinBefore = await fs.readFile(path.join(directory, 'pins.json'), 'utf8');
  const routeFile = (await fs.readdir(directory)).find((name) => name.startsWith('route-pin.'));
  const routeBefore = await fs.readFile(path.join(directory, routeFile), 'utf8');

  await serverA.stop();

  const configB = input.configFor('B');
  const serverB = await hostProcess(t, configB);
  const identity = {
    task: '42',
    attempt,
    profile: 'sample',
  };
  const accepted = await serverB.call(routeGateArgs(configB, {
    ...identity,
    node: 'gate_accept',
    decision: 'approved',
  }));

  assert.equal(accepted.ok, true, accepted.stderr);

  const resumed = await serverB.call(routeResumeArgs(configB, identity));

  assert.equal(resumed.ok, true, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).state, 'stopped');
  assert.equal(await fs.readFile(path.join(directory, 'attempt.json'), 'utf8'), before);
  assert.equal(await fs.readFile(path.join(directory, 'pins.json'), 'utf8'), pinBefore);
  assert.equal(await fs.readFile(path.join(directory, routeFile), 'utf8'), routeBefore);
  assert.equal(await fs.readFile(path.join(input.root, 'markers'), 'utf8'), 'A\nA\nA\n');

  const eventsDir = path.join(directory, 'stage-results');
  const events = await Promise.all((await fs.readdir(eventsDir)).filter((name) => name.startsWith('event.'))
    .map(async (name) => JSON.parse(await fs.readFile(path.join(eventsDir, name), 'utf8'))));

  assert.equal(events.filter((event) => event.outcome === 'approved').length, 1, 'одно решение gate');

  const next = await serverB.call(['43', 'start', '--profile', 'sample',
    '--routes-dir', input.profileRoot, '--state-dir', input.stateRoot,
    '--control-dir', input.controlRoot]);

  assert.equal(next.ok, true, next.stderr);
  assert.equal(await fs.readFile(path.join(input.root, 'markers'), 'utf8'), 'A\nA\nA\nB\n');
  t.diagnostic(JSON.stringify({
    kind: 'SB18-evidence',
    taskId: '42',
    attemptA: attempt,
    catalogHash: JSON.parse(before).catalogHash,
    routeHash: JSON.parse(routeBefore).routeHash,
    attemptSha256: createHash('sha256').update(before).digest('hex'),
    approvedResults: events.filter((event) => event.outcome === 'approved').length,
    newTaskId: '43',
    attemptB: next.stdout.trim(),
    markers: (await fs.readFile(path.join(input.root, 'markers'), 'utf8')).trim().split('\n'),
  }));
});

for (const systemd of [true, false]) {
  test(`SB18 detached entrypoint pin A, systemd=${systemd}, hostile extraEnv отклонён`, async (t) => {
    const input = await fixture(t);

    await pinA(input);

    const bin = path.join(input.root, 'stub-bin');

    await fs.mkdir(bin);
    await fs.writeFile(path.join(bin, 'systemd-run'), `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] === '--version') process.exit(${systemd ? 0 : 1});
const env = {};
for (const [index, arg] of args.entries()) {
  if (arg.startsWith('--setenv=')) {
    const pair = arg.slice(9);
    env[pair.slice(0, pair.indexOf('='))] = pair.slice(pair.indexOf('=') + 1);
  } else if (!arg.startsWith('--')) {
    const result = spawnSync(arg, args.slice(index + 1), {env, encoding:'utf8'});
    require('node:fs').appendFileSync(${JSON.stringify(path.join(input.stateRoot, 't42.launch.log'))},
      String(result.stdout ?? '') + String(result.stderr ?? ''));
    process.exit(result.status ?? 1);
  }
}
process.exit(2);
`, { mode: 0o755 });
    process.env.PATH = `${bin}:/usr/bin:/bin`;

    const config = input.configFor('B');
    const result = await spawnRouteEngine(config, {
      task: input.task,
      args: routeResumeArgs(config, {
        task: input.task,
        attempt: input.attempt,
        profile: 'sample',
      }),
      extraEnv: {
        FACTORY_HOME: input.variants.B.engineHome,
        NODE_BIN: input.variants.B.node,
        GRIGDESK_SERVER_RUNTIME_NODE: '/untrusted/node',
        GRIGDESK_SERVER_RUNTIME_PIN_HELPER: '/untrusted/helper',
        GRIGDESK_SERVER_RUNTIME_RESERVATION: '/untrusted/reservation',
      },
    });

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(await fs.readFile(path.join(input.root, 'markers'), 'utf8'), 'A\n');

    const log = await fs.readFile(result.logFile, 'utf8');

    assert.ok(log.includes(input.variants.A.engineHome));
    assert.ok(log.includes(input.variants.A.node));
    assert.ok(!log.includes('/untrusted/'));
  });
}

test('SB18 legacy R/source без pin закрепляется до безопасного host resume и переживает B', async (t) => {
  const input = await fixture(t);
  const oldRoot = path.join(input.root, 'legacy-r');

  await fs.cp(input.variants.A.runtimeRoot, oldRoot, { recursive: true });

  const legacy = {
    ...input.configFor('A'),
    rootDir: oldRoot,
    factoryHome: path.join(oldRoot, 'engine'),
    factoryBin: path.join(oldRoot, 'engine/bin/factory'),
    runtime: {
      ...input.variants.A,
      packageId: null,
      runtimeRoot: oldRoot,
      engineHome: path.join(oldRoot, 'engine'),
      engineBin: path.join(oldRoot, 'engine/bin/factory'),
      node: path.join(oldRoot, 'runtime/node/bin/node'),
    },
  };
  const args = routeResumeArgs(legacy, {
    task: input.task,
    attempt: input.attempt,
    profile: 'sample',
  });
  const first = await runRouteEngine(legacy, args);

  assert.equal(first.ok, true, first.stderr);

  const scopes = (await fs.readdir(path.join(input.controlRoot, 'server-runtimes')))
    .filter((name) => /^[a-f0-9]{64}$/u.test(name));
  const pin = JSON.parse(await fs.readFile(path.join(input.controlRoot,
    'server-runtimes', scopes[0], `${input.attempt}.json`), 'utf8'));

  assert.equal(pin.packageId, null);
  assert.equal(pin.reservationToken, null);

  const afterSwap = await runRouteEngine(input.configFor('B'), args);

  assert.equal(afterSwap.ok, true, afterSwap.stderr);
  assert.ok(afterSwap.stdout.includes(path.join(oldRoot, 'engine')));
  assert.equal(await fs.readFile(path.join(input.root, 'markers'), 'utf8'), 'A\nA\n');
});

test('SB18 legacy с несовместимым trusted protocol отказывает до pin и engine', async (t) => {
  const input = await fixture(t);
  const protocol = path.join(input.controlRoot, 'protocol-v2/tasks/t42/protocol.json');

  await fs.chmod(protocol, 0o600);
  await fs.writeFile(protocol, JSON.stringify({ schema: 1, protocolVersion: 1 }));
  await fs.chmod(protocol, 0o400);

  const config = input.configFor('B');
  const result = await runRouteEngine(config, routeResumeArgs(config, {
    task: input.task,
    attempt: input.attempt,
    profile: 'sample',
  }));

  assert.equal(result.ok, false, 'несовместимый protocol не мигрирует в новый pin');
  assert.equal(result.failure?.error, 'factory_runtime_attempt_invalid');
  assert.equal(await fs.access(path.join(input.root, 'markers')).then(() => true, () => false), false);
});

/**
 * Два отдельных fixture host-а вызывают настоящую границу runRouteEngine по loopback.
 * Stop A и новый процесс B исключают зависимость продолжения от памяти прежнего сервера.
 */
async function hostProcess(t, config) {
  const { spawn } = await import('node:child_process');
  const module = new URL('../../server/src/lib/factoryRouteCli.ts', import.meta.url).href;
  const code = `
    import {createServer} from 'node:http';
    import {runRouteEngine} from ${JSON.stringify(module)};
    process.once('message', config => {
      const server = createServer(async(req,res)=>{
        try {
          let data='';
          for await (const chunk of req) data+=chunk;
          const result=await runRouteEngine(config,JSON.parse(data).args);
          res.setHeader('content-type','application/json');
          res.end(JSON.stringify(result));
        } catch(error) {res.statusCode=500;res.end(String(error));}
      });
      server.listen(0,'127.0.0.1',()=>process.send({port:server.address().port}));
      process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
    });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    env: {
      PATH: '/usr/bin:/bin',
      HOME: process.env.HOME,
      GRIGDESK_HOME: config.dataHome,
    },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const closed = new Promise((resolve) => child.once('close', resolve));
  let stderr = '';

  child.stderr.on('data', (bytes) => {
    stderr += bytes;
  });

  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
    }

    await closed;
  };

  t.after(stop);

  const ready = new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Fixture host не начал listen: ${stderr}`));
    }, 10000);

    child.once('message', (message) => {
      clearTimeout(deadline);
      resolve(message);
    });
  });

  child.send(config);

  const { port } = await ready;

  return {
    stop,
    call: async (args) => {
      const response = await fetch(`http://127.0.0.1:${port}/engine`, {
        method: 'POST',
        body: JSON.stringify({ args }),
      });

      assert.equal(response.status, 200);

      return response.json();
    },
  };
}

test('SB18 alias profiles root не создаёт второй scope и не переключает pin на B', async (t) => {
  const input = await fixture(t);

  await pinA(input);

  const alias = path.join(input.root, 'profiles-alias');

  await fs.symlink(input.profileRoot, alias);

  const config = { ...input.configFor('B'), profilesDir: alias };
  const result = await runRouteEngine(config, routeResumeArgs(config, {
    task: input.task,
    attempt: input.attempt,
    profile: 'sample',
  }));

  assert.equal(result.ok, false, 'alias физического root не создаёт legacy pin B');
  assert.equal(result.failure?.error, 'factory_runtime_pin_invalid');
  assert.equal(await fs.access(path.join(input.root, 'markers')).then(() => true, () => false), false);
});
