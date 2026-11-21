import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  bindFactoryRuntime, reserveFactoryRuntime, unpinFactoryRuntimeAttempt,
} from '../../server/src/lib/factoryRuntimePins.ts';
import { probeFactoryGotoCapability } from '../../server/src/lib/factoryRuntimeCapabilities.ts';
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
      'if [[ "$1" == capabilities ]]; then\n' +
      `  printf '%s\\n' '{"schema":1,"features":${label === 'A' ? '[]' : '["goto-expected-stage-v1"]'}}'\n` +
      '  exit 0\nfi\n' +
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

test('capabilities отклоняет снятое поколение, сохраняя control и cache', async (t) => {
  const input = await fixture(t);

  await pinA(input);

  /**
   * Сравнивает имена и bytes authority, registry, reservation и index до и после probe.
   * Маркер вызванного CLI лежит снаружи этих roots и служит только наблюдением теста.
   */
  const snapshot = async () => {
    const roots = [input.controlRoot, input.variants.A.cacheDir];
    const files = [];

    for (const root of roots) {
      for (const name of (await fs.readdir(root, { recursive: true })).sort()) {
        const file = path.join(root, name);
        const stat = await fs.lstat(file);

        if (stat.isFile()) {
          files.push([file, createHash('sha256').update(await fs.readFile(file)).digest('hex')]);
        }
      }
    }

    return files;
  };
  const before = await snapshot();
  const capability = await probeFactoryGotoCapability(input.configFor('B'), {
    task: input.task,
    attempt: input.attempt,
    profile: 'sample',
  });

  assert.equal(capability.status, 'unknown');
  await assert.rejects(fs.access(path.join(input.root, 'markers')), { code: 'ENOENT' });
  assert.deepEqual(await snapshot(), before);
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

for (const systemd of [true, false]) {
  test(`SB18 detached отказывает старому пину при systemd=${systemd} и hostile extraEnv`, async (t) => {
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

    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.failure?.error, 'factory_runtime_engine_retired');
    await assert.rejects(fs.access(path.join(input.root, 'markers')), { code: 'ENOENT' });
  });
}

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

// Снятие закрепления после runner_preflight_incompatible: попытка освобождает
// прежний рантайм целиком (authority pin, индекс, бронь и ссылки реестра) и тут же
// свободно закрепляется за текущей поставкой. Повторный вызов — no-op.
test('unpin снимает pin A и позволяет повторно закрепить B на ту же попытку', async (t) => {
  const input = await fixture(t);

  await pinA(input);

  const unpinned = await unpinFactoryRuntimeAttempt({
    controlRoot: input.controlRoot,
    stateRoot: input.stateRoot,
    profileRoot: input.profileRoot,
    cacheDir: input.variants.A.cacheDir,
    task: input.task,
    attempt: input.attempt,
    profile: 'sample',
  });

  assert.equal(unpinned.unpinned, true);
  assert.equal(unpinned.packageId, input.variants.A.packageId);

  const scopeDir = path.join(input.controlRoot, 'server-runtimes');

  for (const root of [scopeDir, path.join(input.variants.A.cacheDir, 'attempt-pins')]) {
    const names = await fs.readdir(root, { recursive: true }).catch(() => []);

    for (const name of names) {
      assert.ok(!String(name).includes(input.attempt), `файл закрепления попытки удалён: ${name}`);
    }
  }

  const registry = JSON.parse(await fs.readFile(
    path.join(input.variants.A.cacheDir, 'state/control-roots.json'), 'utf8'));

  for (const root of registry.roots) {
    for (const reference of root.references) {
      assert.ok(reference.attempt !== input.attempt, 'ссылка реестра попытки снята');
    }
  }

  const repeated = await unpinFactoryRuntimeAttempt({
    controlRoot: input.controlRoot,
    stateRoot: input.stateRoot,
    profileRoot: input.profileRoot,
    cacheDir: input.variants.A.cacheDir,
    task: input.task,
    attempt: input.attempt,
    profile: 'sample',
  });

  assert.equal(repeated.unpinned, false, 'повторное снятие — no-op');

  const reservation = await reserveFactoryRuntime({
    controlRoot: input.controlRoot,
    stateRoot: input.stateRoot,
    profileRoot: input.profileRoot,
    task: input.task,
    ...input.variants.B,
  });
  const pin = await bindFactoryRuntime({
    reservation: reservation.reservation,
    task: input.task,
    attempt: input.attempt,
    attemptDir: input.attemptDir,
  });

  assert.equal(pin.packageId, input.variants.B.packageId, 'попытка перезакреплена на B');
});

// Сбой удаления пережившей reservation не должен терять её token вместе с пином.
// После устранения файлового отказа тот же unpin завершает очистку идемпотентно.
test('unpin сохраняет token до очистки reservation и допускает повтор после отказа', async (t) => {
  const input = await fixture(t);
  const pin = await pinA(input);
  const request = {
    ...input,
    cacheDir: input.variants.A.cacheDir,
    profile: 'sample',
  };
  const reservation = path.join(
    input.controlRoot, 'server-runtimes/reservations', `${pin.reservationToken}.json`,
  );
  const authority = path.join(input.controlRoot, 'server-runtimes', pin.scope, `${input.attempt}.json`);

  await fs.mkdir(reservation);
  await assert.rejects(unpinFactoryRuntimeAttempt(request));

  assert.deepEqual(JSON.parse(await fs.readFile(authority, 'utf8')), pin,
    'ошибка очистки сохраняет token в authority');

  await fs.rmdir(reservation);
  await fs.writeFile(reservation, '{}');

  assert.equal((await unpinFactoryRuntimeAttempt(request)).unpinned, true);
  await assert.rejects(fs.access(reservation), { code: 'ENOENT' });

  assert.equal((await unpinFactoryRuntimeAttempt(request)).unpinned, false);
});

for (const corruption of ['null', 'other-package']) {
  test(`unpin сохраняет authority при повреждённом индексе: ${corruption}`, async (t) => {
    const input = await fixture(t);
    const pin = await pinA(input);
    const cacheDir = input.variants.A.cacheDir;
    const index = path.join(cacheDir, 'attempt-pins', pin.scope, `${input.attempt}.json`);
    const authority = path.join(input.controlRoot, 'server-runtimes', pin.scope, `${input.attempt}.json`);
    const registry = path.join(cacheDir, 'state/control-roots.json');
    const beforeRegistry = await fs.readFile(registry, 'utf8');
    const value = corruption === 'null' ? null : { ...pin, packageId: input.variants.B.packageId };

    await fs.writeFile(index, JSON.stringify(value));
    await assert.rejects(unpinFactoryRuntimeAttempt({
      ...input,
      cacheDir,
      profile: 'sample',
    }), { code: 'factory_runtime_pin_invalid' });

    assert.deepEqual(JSON.parse(await fs.readFile(authority, 'utf8')), pin);
    assert.equal(await fs.readFile(registry, 'utf8'), beforeRegistry);
  });
}
