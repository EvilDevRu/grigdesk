import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { createPrivateKey, createPublicKey, randomUUID, sign } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import type { TestContext } from 'node:test';

import { canonicalJson } from '../../shared/lib/canonicalJson.ts';
import { decodeReleaseChannelIndex } from '../../shared/runtime/installedUpdateContracts.ts';
import { verifyReleaseEnvelope } from '../../shared/node/releaseTrust.ts';
import { completed } from '../cli/helpers/sandbox.mts';
import { goCandidate } from '../helpers/goCandidate.mts';
import { archiveBytes, installedRelease } from '../helpers/installedUpdateFixture.mjs';
import { sha256 } from '../helpers/releaseV2Fixture.mjs';

const seed = Buffer.concat([
  Buffer.from('302e020100300506032b657004220420', 'hex'),
  Buffer.alloc(32, 0x43),
]);
const privateKey = createPrivateKey({
  key: seed,
  format: 'der',
  type: 'pkcs8',
});
const keys = { privateKey, publicKey: createPublicKey(privateKey) };

/**
 * Собирает воспроизводимый подписанный индекс с Unicode и точной описью control.
 * Все варианты используют тот же выделенный для этого теста ключ.
 */
function signedV3(variant = 'good', version = '0.2.0', executable?: Buffer, server?: Buffer) {
  const { identity, envelope, archives, publicKeyPem } = installedRelease({
    keys,
    version,
    payload: {
      notes: { ru: 'Ёж 🧰 и строка\u2028выпуска', en: 'Tool <kit> & new generation' },
      serverApi: { major: 0, minor: Number.MAX_SAFE_INTEGER },
    },
  });
  const payload = envelope.payload;

  if (server) {
    const archive = archiveBytes('bin/grigdesk-server', server, '0', 0o555);
    const serverArtifact = payload.artifacts.server;
    const files = [{
      path: 'bin/grigdesk-server',
      mode: 0o555,
      size: server.length,
      sha256: sha256(server),
    }];

    Object.assign(serverArtifact, {
      size: archive.length,
      sha256: sha256(archive),
      unpackedSize: server.length,
      files,
      filesDigest: sha256(canonicalJson(files)),
    });
    archives.set(serverArtifact.url, archive);
  }

  const report = JSON.stringify({
    kind: 'grigdesk-ctl',
    runtime: 'go',
    version,
  });
  const control = executable ?? Buffer.from('#!/bin/sh\n'
    + `if [ "$1" = --runtime-info ]; then printf '%s\\n' '${report}'; exit 0; fi\n`
    + 'printf "%s\\n" "$*"\nexit 17\n');
  const entry = 'bin/grigdesk-ctl';
  const archive = archiveBytes(entry, control, variant === 'link' ? '2' : '0', 0o555);
  const inventory = [{
    path: entry,
    mode: 0o555,
    size: control.length,
    sha256: sha256(control),
  }];
  const url = `https://grigdesk.test/${version}/control.tar.gz`;

  payload.artifacts.control = {
    url,
    size: archive.length,
    sha256: sha256(archive),
    unpackedSize: control.length,
    files: inventory,
    filesDigest: sha256(canonicalJson(inventory)),
    buildIdentity: identity,
  };
  archives.set(url, archive);

  const signature = sign(null, Buffer.from(`GrigDesk release v3\n${canonicalJson(payload)}\n`), privateKey);

  return {
    index: {
      format: 3,
      channel: payload.channel,
      publishedAt: payload.publishedAt,
      latest: {
        format: 3 as const,
        payload,
        signature: signature.toString('base64'),
      },
    },
    archives,
    publicKeyPem,
  };
}

/**
 * Проверка описи использует тот же независимый ключ, что и нативный кандидат.
 * Поля с Unicode, предельным safe integer и null не выпрямляются до проверки подписи.
 */
test('GI-INDEX: Node разбирает signed v3 и отказывает несовпадению форматов/ключу', () => {
  const { index, publicKeyPem } = signedV3();
  const decoded = decodeReleaseChannelIndex(index);

  assert.equal(decoded.format, 3);
  assert.ok(decoded.latest);
  assert.match(verifyReleaseEnvelope(decoded.latest, publicKeyPem), /^[a-f0-9]{64}$/u);
  assert.throws(() => verifyReleaseEnvelope(decoded.latest!));
  assert.throws(() => decodeReleaseChannelIndex({ ...index, format: 2 }));
});

/**
 * Сохраняет точные подписанные metadata и архивы в приватной папке фикстуры.
 * Квитанция установщика позволяет испытывать повтор подготовки новой версии.
 */
async function writeCandidate(directory: string, release: ReturnType<typeof signedV3>) {
  for (const [url, bytes] of release.archives) {
    const name = new URL(url).pathname.split('/').at(-1)!;

    await writeFile(path.join(directory, name), bytes);
  }

  await writeFile(path.join(directory, 'release.json'), JSON.stringify(release.index));

  const installer = '#!/bin/sh\n# Фикстура подписи установщика.\n';
  const digest = verifyReleaseEnvelope(release.index.latest, release.publicKeyPem);
  const proof = `GrigDesk installer v1\n${sha256(installer)}  grigdesk-install\n${digest}\n`;

  await writeFile(path.join(directory, 'grigdesk-install'), installer, { mode: 0o755 });
  await writeFile(path.join(directory, 'grigdesk-install.sha256'), proof);
  await writeFile(path.join(directory, 'grigdesk-install.sig'),
    sign(null, Buffer.from(proof), privateKey).toString('base64'));
}

/**
 * Готовит приватные пути и замыкает запуск на команды из рабочего кандидата.
 * Нижележащие команды не видят реальные каталоги служебных настроек.
 */
async function installation(t: TestContext, variant = 'good', control?: Buffer) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-install-go-'));

  const cleanups: (() => Promise<void>)[] = [];

  t.after(async () => {
    for (const cleanup of cleanups) {
      await cleanup();
    }

    await rm(directory, { recursive: true, force: true });
  });

  const indexFile = path.join(directory, 'release.json');

  await writeCandidate(directory, signedV3(variant, '0.2.0', control));

  const root = path.join(directory, 'program');
  const data = path.join(directory, 'data');
  const user = path.join(directory, 'user');
  const paths = {
    root,
    data,
    user,
    bin: path.join(directory, 'launchers'),
    apps: path.join(directory, 'apps'),
    units: path.join(directory, 'units'),
  };

  return {
    directory,
    paths,
    cleanups,
    run: (mode: string, extra: string[] = []) => completed(spawn(goCandidate('grigdesk-maintenance'), [
      'install-online', '--release', indexFile, '--source-dir', directory, '--mode', mode,
      '--root', root, '--data-home', data, '--user-data', user, '--bin-dir', paths.bin,
      '--applications-dir', paths.apps, '--unit-dir', paths.units, ...extra,
    ], {
      env: {
        HOME: directory,
        XDG_DATA_HOME: path.join(directory, 'xdg'),
        PATH: '/usr/bin:/bin',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })),
  };
}

for (const mode of ['local', 'server', 'remote']) {
  test(`GI-CLEAN: новый v3 корень ${mode} получает control и только нужные компоненты`, async (t) => {
    const fixture = await installation(t);
    const result = await fixture.run(mode);

    assert.equal(result.code, 0, result.stderr);

    const { root } = fixture.paths;
    const pointer = JSON.parse(await readFile(path.join(root, 'current.json'), 'utf8'));
    const saved = JSON.parse(await readFile(path.join(root, 'installation.json'), 'utf8'));

    assert.equal(pointer.format, 2);
    assert.equal(pointer.installationId, saved.installationId);
    assert.equal(pointer.control, 'generations/0.2.0');
    assert.equal(pointer.floor, '0.2.0');
    assert.equal(pointer.server, mode === 'remote' ? null : 'generations/0.2.0/server');
    assert.equal(pointer.desktop, mode === 'server' ? null : 'generations/0.2.0/desktop');
    assert.equal((await stat(path.join(root, pointer.control, 'bin/grigdesk-ctl'))).mode % 0o1000, 0o555);

    const repeated = await fixture.run(mode);
    const again = JSON.parse(await readFile(path.join(root, 'installation.json'), 'utf8'));

    assert.equal(repeated.code, 0, repeated.stderr);
    assert.equal(again.installationId, saved.installationId);
  });
}

test('GI-CLEAN: архив с link отказывает до публикации корня', async (t) => {
  const fixture = await installation(t, 'link');
  const result = await fixture.run('remote');

  assert.equal(result.code, 1, result.stderr);
  await assert.rejects(() => stat(fixture.paths.root), { code: 'ENOENT' });
});

test('GI-CLEAN: подмена файла control отказывает до публикации корня', async (t) => {
  const fixture = await installation(t);
  const asset = path.join(fixture.directory, 'control.tar.gz');

  await chmod(asset, 0o600);
  await writeFile(asset, Buffer.from('замена'));

  const result = await fixture.run('server');

  assert.equal(result.code, 1, result.stderr);
  await assert.rejects(() => stat(fixture.paths.root), { code: 'ENOENT' });
});


test('GI-CUTOVER: v2 требует отдельное согласие, а затем выбирает только подписанный v3', async (t) => {
  const fixture = await installation(t);
  const { root, data, user } = fixture.paths;
  const legacy = installedRelease({ keys, version: '0.1.9' });
  const generation = path.join(root, 'generations', '0.1.9');
  const update = path.join(root, 'update');
  const helperPath = path.join(update, 'maintenance');
  const currentPath = path.join(root, 'current.json');
  const installationId = randomUUID();
  const receipt = {
    format: 1,
    installationId,
    uid: process.getuid!(),
    root,
    dataHome: data,
    userData: user,
    channel: 'release',
    mode: 'local',
  };
  const current = Buffer.from(JSON.stringify({
    format: 1,
    installationId,
    desktop: 'generations/0.1.9/desktop',
    server: 'generations/0.1.9/server',
  }));
  const helper = Buffer.from('#!/bin/sh\nexit 0\n');

  await Promise.all([update, data, user].map((dir) => mkdir(dir, { recursive: true, mode: 0o700 })));

  for (const [component, file] of legacy.files) {
    const entry = path.join(generation, component, file.name);

    await mkdir(path.dirname(entry), { recursive: true, mode: 0o700 });
    await writeFile(entry, file.bytes, { mode: 0o755 });
  }

  await writeFile(path.join(generation, 'release.json'), JSON.stringify(legacy.envelope), { mode: 0o600 });
  await writeFile(path.join(root, 'installation.json'), JSON.stringify(receipt), { mode: 0o600 });
  await writeFile(currentPath, current, { mode: 0o600 });
  await writeFile(helperPath, helper, { mode: 0o555 });
  await writeFile(path.join(data, 'sentinel'), 'D');

  const implicit = await fixture.run('local');
  const wrong = await fixture.run('local', ['--migrate-to-go', '--expected-current-sha', '0'.repeat(64)]);

  assert.match(implicit.stderr, /release_go_migration_required/u);
  assert.equal(wrong.code, 1, wrong.stderr);
  assert.deepEqual(await readFile(currentPath), current);
  assert.deepEqual(await readFile(helperPath), helper);

  const consent = ['--migrate-to-go', '--expected-current-sha', sha256(current)];
  // Прежний launcher успевает прочитать A, затем ждёт до попытки exec.
  // Здесь проверяется именно исчезновение канонического пути, прочитанного раньше.
  const late = spawn(process.execPath, ['--input-type=module', '-e', `
    import { execFile, spawn } from 'node:child_process';
    import { readFileSync } from 'node:fs';
    import path from 'node:path';
    const [root, file] = process.argv.slice(1);
    const current = JSON.parse(readFileSync(file, 'utf8'));
    const executable = path.join(root, current.server, 'bin/grigdesk-server');
    process.stdout.write('ready');
    process.stdin.once('data', () => {
      const child = spawn(executable);
      child.once('error', (err) => {
        process.exitCode = err.code === 'ENOENT' ? 0 : 1;
      });
      child.once('exit', () => {
        process.exitCode = 2;
      });
    });
  `, root, currentPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  const launched = completed(late);

  t.after(() => {
    late.kill();
  });
  await once(late.stdout, 'data');

  const result = await fixture.run('local', consent);

  assert.equal(result.code, 0, result.stderr);
  late.stdin.end('exec');
  assert.equal((await launched).code, 0);
  assert.equal(JSON.parse(await readFile(currentPath, 'utf8')).floor, '0.2.0');
  await assert.rejects(() => stat(generation), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(data, 'sentinel'), 'utf8'), 'D');

  const registered = JSON.parse(await readFile(path.join(root, 'installation.json'), 'utf8'));

  assert.equal(registered.installationId, installationId);

  const beforeUpdate = await readFile(currentPath);

  await writeCandidate(fixture.directory, signedV3('good', '0.2.1'));

  const staged = await fixture.run('local');

  assert.equal(staged.code, 10, staged.stderr);
  assert.deepEqual(await readFile(currentPath), beforeUpdate);

  const job = JSON.parse(await readFile(path.join(update, 'job.json'), 'utf8'));

  assert.equal(job.stage, 'ready');

  // Моделируем уже активированный C его настоящими подписанными файлами.
  // Проверяем повтор установщика при сохранённой истории перехода A → B.
  const successor = await installation(t);

  await writeCandidate(successor.directory, signedV3('good', '0.2.1'));

  const clean = await successor.run('local');

  assert.equal(clean.code, 0, clean.stderr);
  await cp(path.join(successor.paths.root, 'generations/0.2.1'),
    path.join(root, 'generations/0.2.1'), { recursive: true });
  await writeFile(currentPath, JSON.stringify(job.target), { mode: 0o600 });

  const replay = await fixture.run('local');

  assert.equal(replay.code, 0, replay.stderr);
});

test('GI-IPC: установленный helper отдаёт состояние через закрытый JSON', async (t) => {
  const fixture = await installation(t);
  const ready = await fixture.run('server');

  assert.equal(ready.code, 0, ready.stderr);

  const helper = path.join(fixture.paths.root, 'update', 'maintenance');
  // Helper запускается из зарегистрированного каталога. Тест проверяет обе трубы
  // и передаёт исходный stdin, в том числе JSON с повторяющимся ключом.
  const run = (action: string, input: string) => {
    const child = spawn(helper, ['control', action, '--json'], {
      cwd: fixture.paths.root,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const result = completed(child);

    child.stdin.end(input);

    return result;
  };
  const result = await run('status', '{"schema":1}');

  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).installed.server, '0.2.0');
  assert.equal((await run('status', '{"schema":1,"env":"unknown"}')).code, 2);
  assert.equal((await run('status', '{"schema":1,"schema":1}')).code, 2);
});

/**
 * Резервирует отдельный loopback-порт для временной регистрации.
 * Фикстура всегда читает свой .env перед попыткой соединения.
 */
async function placePort(data: string): Promise<number> {
  const socket = createServer();

  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');

  const address = socket.address();

  assert.ok(address && typeof address !== 'string');
  socket.close();
  await once(socket, 'close');
  await writeFile(path.join(data, '.env'), `GRIGDESK_PORT=${address.port}\n`, { mode: 0o600 });

  return address.port;
}

test('GI-OFFLINE: повтор C сохраняет job, helper B и floor после активации', async (t) => {
  const fixture = await installation(t);
  const installed = await fixture.run('server');

  assert.equal(installed.code, 0, installed.stderr);

  const { directory, paths } = fixture;
  const { root } = paths;
  const helper = path.join(root, 'update', 'maintenance');
  const current = path.join(root, 'current.json');
  const previous = await readFile(current);
  const helperSHA = sha256(await readFile(helper));

  await placePort(paths.data);

  const target = signedV3('good', '0.2.1');

  await writeCandidate(directory, target);

  const prepared = await fixture.run('server');

  assert.equal(prepared.code, 10, prepared.stderr);
  assert.deepEqual(await readFile(current), previous);

  const repeated = await fixture.run('server');

  assert.equal(repeated.code, 10, repeated.stderr);

  // На этом стенде нет сервера. Подтверждение и CAS идут через публичный stdin Go.
  // Путь продукта и argv сохраняются от проверки до запроса применения.
  const run = (action: string, fields: Record<string, unknown>) => {
    const child = spawn(helper, ['control', action, '--json'], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const result = completed(child);

    child.stdin.end(JSON.stringify({ ...fields, schema: 1 }));

    return result;
  };
  const status = await run('status', {});

  assert.equal(status.code, 0, status.stderr);

  const { job } = JSON.parse(status.stdout);
  const repeat = await run('create-job', {
    requestId: job.requestId,
    manifestDigest: job.manifestDigest,
    scope: 'server',
  });

  assert.equal(repeat.code, 0, repeat.stderr);
  assert.equal(JSON.parse(repeat.stdout).id, job.id);
  assert.match((await run('apply', { jobId: job.id })).stderr, /release_user_consent_required/u);

  const handoff = await run('handoff', {
    jobId: job.id,
    desktop: null,
    stopLocal: true,
    remoteApi: null,
  });

  assert.equal(handoff.code, 0, handoff.stderr);

  const activated = await run('apply', { jobId: job.id });

  assert.equal(activated.code, 0, activated.stderr);
  assert.equal(JSON.parse(activated.stdout).stage, 'applied_not_started');

  const pointer = JSON.parse(await readFile(current, 'utf8'));

  assert.equal(pointer.control, 'generations/0.2.1');
  assert.equal(pointer.server, 'generations/0.2.1/server');
  assert.equal(pointer.floor, '0.2.0');
  assert.equal(sha256(await readFile(helper)), helperSHA);

  const revived = await run('recover', { jobId: job.id });

  assert.equal(revived.code, 0, revived.stderr);
  assert.equal(JSON.parse(revived.stdout).target.server, pointer.server);
});

test('GI-CTL: подписанный control запускается через launcher с пустым PATH', async (t) => {
  const fixture = await installation(t, 'good', await readFile(goCandidate('grigdesk-ctl')));
  const installed = await fixture.run('remote');

  assert.equal(installed.code, 0, installed.stderr);

  const executable = path.join(fixture.paths.bin, 'grigdesk-ctl');
  const environment = {
    HOME: fixture.directory,
    PATH: '',
  };
  const version = await completed(spawn(executable, ['--version'], { env: environment }));

  assert.equal(version.code, 0, version.stderr);
  assert.match(version.stdout, /0\.2\.0/u);

  const control = path.join(fixture.paths.root, 'generations/0.2.0/bin/grigdesk-ctl');

  await chmod(control, 0o700);

  const corrupted = await completed(spawn(executable, ['--version'], { env: environment }));

  assert.equal(corrupted.code, 1, corrupted.stderr);
  assert.match(corrupted.stderr, /release_executable_hash_mismatch/u);
});

test('GI-CTL: relay status читает связи сервера без Docker в PATH', async (t) => {
  const fixture = await installation(t, 'good', await readFile(goCandidate('grigdesk-ctl')));
  const installed = await fixture.run('server');

  assert.equal(installed.code, 0, installed.stderr);

  const state = path.join(fixture.paths.data, 'state');
  const token = 'fixture-cli-token';

  await mkdir(state, { recursive: true, mode: 0o700 });
  await writeFile(path.join(state, 'cli-token'), token, { mode: 0o600 });

  const server = createHttpServer((request, response) => {
    if (request.url === '/api/auth/state') {
      response.end(JSON.stringify({ configured: true, authenticated: false }));

      return;
    }
    if (request.url !== '/api/mobile/status' || request.headers['x-grigdesk-token'] !== token) {
      response.writeHead(401).end();

      return;
    }

    response.end(JSON.stringify({ relays: [{ name: 'Дом', link: { state: 'online' } }] }));
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.close();
  });

  const address = server.address();

  assert.ok(address && typeof address === 'object');

  const executable = path.join(fixture.paths.bin, 'grigdesk-ctl');
  const result = await completed(spawn(executable, ['relay', 'status', '--json'], {
    env: {
      HOME: fixture.directory,
      PATH: '',
      GRIGDESK_PORT: String(address.port),
    },
  }));

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { relay: { links: [{ name: 'Дом', state: 'online' }] } });
});

test('GI-CTL: серверные логи и явный отказ продолжить отсутствующее задание', async (t) => {
  const fixture = await installation(t, 'good', await readFile(goCandidate('grigdesk-ctl')));
  const installed = await fixture.run('server');

  assert.equal(installed.code, 0, installed.stderr);

  const log = path.join(fixture.paths.root, 'update', 'server.log');
  const executable = path.join(fixture.paths.bin, 'grigdesk-ctl');
  const env = {
    HOME: fixture.directory,
    PATH: '',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=' + path.join(fixture.directory, 'closed-bus'),
    XDG_RUNTIME_DIR: fixture.directory,
  };

  await writeFile(log, 'Первая строка\nВторая строка\n', { mode: 0o600 });

  const logs = await completed(spawn(executable, ['server', 'logs', '--lines', '1'], { env }));

  assert.equal(logs.code, 0, logs.stderr);
  assert.equal(logs.stdout, 'Вторая строка\n');

  const update = await completed(spawn(executable, ['server', 'resume-update', '--json'], { env }));

  assert.equal(update.code, 1);
  assert.match(update.stderr, /release_job_missing/u);
});

test('GI-LIVE: drain подтверждается ответом 202 и квитанцией, затем запускается C', async (t) => {
  const fixture = await installation(t);
  const { root, data } = fixture.paths;
  const execute = promisify(execFile);
  const serverSource = path.resolve(import.meta.dirname,
    '../../utilities/maintenance/testdata/server-fixture/main.go');
  const versions = ['0.2.0', '0.2.1'] as const;
  const servers = [];

  for (const version of versions) {
    const file = path.join(fixture.directory, 'server-' + version);

    await execute('go', ['build', '-ldflags', '-X main.version=' + version, '-o', file, serverSource]);
    servers.push(await readFile(file));
  }

  await writeCandidate(fixture.directory, signedV3('good', versions[0], undefined, servers[0]));

  const installed = await fixture.run('server');

  assert.equal(installed.code, 0, installed.stderr);

  const helper = path.join(root, 'update', 'maintenance');
  const port = await placePort(data);
  const env = {
    HOME: fixture.directory,
    PATH: '/usr/bin:/bin',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=' + path.join(fixture.directory, 'closed-bus'),
    XDG_RUNTIME_DIR: fixture.directory,
  };
  const state = path.join(data, 'state');

  await mkdir(state, { mode: 0o700 });
  await writeFile(path.join(state, 'cli-token'), 'fixture-drain-token', { mode: 0o600 });
  await writeFile(path.join(data, 'sentinel'), 'D');
  fixture.cleanups.push(async () => {
    await execute(helper, ['ctl-runtime', 'server', 'stop'], { timeout: 6000, env }).catch(() => {});
  });

  await execute(helper, ['ctl-runtime', 'server', 'start', '--wait'], { timeout: 15_000, env });
  await writeCandidate(fixture.directory, signedV3('good', versions[1], undefined, servers[1]));

  const staged = await fixture.run('server');

  assert.equal(staged.code, 10, staged.stderr);

  const readState = async (relative: string) => {
    return JSON.parse(await readFile(path.join(root, relative), 'utf8'));
  };
  const job = await readState('update/job.json');
  const input = {
    schema: 1,
    jobId: job.id,
    desktop: null,
    stopLocal: true,
    remoteApi: null,
  };
  const confirmed = spawn(helper, ['control', 'handoff', '--json'], {
    cwd: root,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const confirmation = completed(confirmed);

  confirmed.stdin.end(JSON.stringify(input));

  const result = await confirmation;

  assert.equal(result.code, 0, result.stderr);
  await execute(helper, ['apply', job.id], { timeout: 20_000, env });

  const drain = await readState('update/server-drain.json');
  const boot = await readState('update/server-boot.json');
  const final = await readState('update/job.json');

  assert.equal(drain.nonce, final.intent.nonce);
  assert.equal(drain.instanceId, '50bdb29e-1c83-47bc-a001-2b80af4f10c1');
  assert.equal(boot.instanceId, '79d05129-d470-4ab6-9582-b15eabb21034');
  assert.equal(final.stage, 'completed');
  assert.equal(await readFile(path.join(data, 'sentinel'), 'utf8'), 'D');
  await execute(helper, ['ctl-runtime', 'server', 'stop'], { timeout: 6000, env });
  await assert.rejects(fetch(`http://127.0.0.1:${port}/api/health`));
});
