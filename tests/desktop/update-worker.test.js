import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as pause } from 'node:timers/promises';
import test from 'node:test';

import { installedFixture, pinnedKeyHook } from '../helpers/installedUpdateFixture.mjs';
import { readUpdateProcess } from '../../shared/node/updateProcessOwner.ts';
import { updateProcessAlive } from '../../shared/node/installedServer.ts';

const repository = path.resolve(import.meta.dirname, '../..');

/**
 * Ожидание ограничено сроком и не подменяет completed готовым ответом.
 * Читает journal настоящего worker, который переживает завершение main.
 */
async function waitJob(box, stage) {
  const deadline = Date.now() + 12000;

  while (Date.now() < deadline) {
    const job = await box.job();

    if (job?.stage === stage) {
      return job;
    }

    if (job?.error) {
      throw new Error(JSON.stringify(job.error));
    }

    await pause(40);
  }

  throw new Error(`Не достигнут ${stage}: ${JSON.stringify(await box.job())}`);
}

for (const mode of ['remote', 'server']) {
  test(`WORKER-SURVIVES/APP-REMOTE: ${mode}, main завершён, update продолжен`, async (t) => {
    const box = await installedFixture(t, { mode });
    const created = await box.create();

    await box.manager.prepare(created.id);

    const hook = await pinnedKeyHook(box.temporary, box.release.publicKeyPem);
    const script = path.join(box.temporary, 'lifecycle.mjs');
    const imports = (name) => JSON.stringify(path.join(repository, `shared/node/${name}.ts`));
    const source = [
      `import { createUpdateHandoff, launchUpdateWorker, waitUpdateWorker,`,
      `  runInstalledUpdateWorker, writeDesktopBootProof } from ${imports('installedUpdateWorker')};`,
      `import { readUpdateProcess } from ${imports('updateProcessOwner')};`,
      `import { readInstallationJson } from ${imports('installedLayout')};`,
      `const root = ${JSON.stringify(box.root)};`,
      `const jobId = ${JSON.stringify(created.id)};`,
      "const action = process.argv[2];",
      "if (action === 'main') {",
      `  const desktop = ${mode === 'remote'} ? await readUpdateProcess(process.pid) : undefined;`,
      '  const handoff = await createUpdateHandoff(root, jobId, {',
      `    desktop, stopLocal: ${mode === 'server'}, remoteApi: { major: 0, minor: 1 },`,
      '  });',
      '  await launchUpdateWorker(root, jobId);',
      `  await waitUpdateWorker(root, handoff, '${mode === 'remote' ? 'drained' : 'accepted'}');`,
      "  process.stdout.write('MAIN_DRAINED\\n');",
      "} else if (action === 'apply') {",
      '  await runInstalledUpdateWorker(root, jobId);',
      "} else if (action === 'launch' && process.argv[3] === 'desktop') {",
      `  await writeDesktopBootProof(root, ${JSON.stringify(box.release.identity)});`,
      '  setInterval(() => {}, 1000);',
      '} else { throw new Error("Неожиданное действие " + process.argv.slice(2)); }',
    ].join('\n');

    await fs.writeFile(script, source, { mode: 0o600 });

    const bin = path.join(box.temporary, 'bin');

    await fs.mkdir(bin, { mode: 0o700 });
    await fs.writeFile(path.join(bin, 'systemctl'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
    await fs.writeFile(path.join(box.root, 'update/maintenance'), [
      '#!/bin/sh',
      `exec '${process.execPath}' --import '${hook}' '${script}' "$@"`,
    ].join('\n'), { mode: 0o700 });

    const child = spawn(process.execPath, ['--import', hook, script, 'main'], {
      env: {
        HOME: box.temporary,
        PATH: `${bin}:/usr/bin:/bin`,
        LANG: 'C.UTF-8',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks = [];

    child.stdout.on('data', (bytes) => chunks.push(bytes));
    child.stderr.on('data', (bytes) => chunks.push(bytes));
    t.after(() => {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
      }
    });
    box.onCleanup(async () => {
      for (const name of ['desktop-boot.json', 'worker-process.json']) {
        const marker = await fs.readFile(path.join(box.root, 'update', name), 'utf8')
          .then(JSON.parse, () => null);

        if (marker?.process && await updateProcessAlive(marker.process)) {
          process.kill(marker.process.pid, 'SIGTERM');
        }
      }
    });

    const [code] = await once(child, 'exit');

    assert.equal(code, 0, Buffer.concat(chunks).toString());
    assert.match(Buffer.concat(chunks).toString(), /MAIN_DRAINED/);

    const job = await waitJob(box, mode === 'remote' ? 'completed' : 'applied_not_started');

    assert.deepEqual(await box.pointer(), job.target);
    assert.equal(job.scope, mode === 'remote' ? 'desktop' : 'server');

    if (mode === 'remote') {
      assert.equal(job.target.server, null);
    }

    await box.preserved();
  });
}

test('OWNER-RECHECK: настоящий PID с изменённым starttime не получает разрешения', async () => {
  const owner = await readUpdateProcess(process.pid);

  assert.equal(await updateProcessAlive(owner), true);
  assert.equal(await updateProcessAlive({ ...owner, starttime: '0' }), false);
  assert.equal(await updateProcessAlive({ ...owner, executable: '/чужой-процесс' }), false);
});

const { loadInstalledModule } = await import('../helpers/installedBuildFixture.mjs');

test('APP-NONBLOCK: первый локальный снимок доступен до удержанного ответа сайта', async (t) => {
  const box = await installedFixture(t, { mode: 'remote' });
  const { createApplicationUpdates } = await loadInstalledModule(t, 'desktop/src/applicationUpdates.ts',
    box.release.publicKeyPem);
  const gate = Promise.withResolvers();
  let requests = 0;

  t.mock.method(globalThis, 'fetch', async () => {
    requests += 1;
    await gate.promise;

    return new Response(JSON.stringify(box.release.index));
  });

  const app = createApplicationUpdates({
    root: box.root,
    runningVersion: '0.2.0',
    localSelected: () => false,
    prepare: async (job) => box.manager.prepare(job.id),
    apply: async () => {
      throw new Error('Не подтверждено');
    },
  });

  t.after(() => app.close());
  t.after(() => gate.resolve());
  await app.start();
  assert.equal(app.port.state().running, '0.2.0');
  assert.equal(app.port.state().scope, 'desktop');
  assert.equal(app.port.state().job, null);
  assert.equal(app.port.state().checkState === 'available', false);
  gate.resolve();
  await app.port.action('check', {});
  assert.ok(requests >= 1);
  assert.equal(app.port.state().checkState, 'available');
});

test('JOB-PROFILE: смена профиля и latest не меняет готовую цель пары', async (t) => {
  const box = await installedFixture(t);
  const { createApplicationUpdates } = await loadInstalledModule(t, 'desktop/src/applicationUpdates.ts',
    box.release.publicKeyPem);
  let local = true;
  let applied = 0;

  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(box.release.index)));

  const app = createApplicationUpdates({
    root: box.root,
    runningVersion: '0.2.0',
    localSelected: () => local,
    prepare: async (job) => box.manager.prepare(job.id),
    apply: async () => {
      applied += 1;
    },
  });

  t.after(() => app.close());
  await app.start();
  await app.port.action('check', {});
  await app.port.action('prepare', {});

  const prepared = await box.job();

  assert.equal(prepared.stage, 'ready');
  local = false;
  await app.port.action('prepare', {});
  await assert.rejects(app.port.action('apply', { confirmed: true }), /return_to_confirmed_profile/);
  assert.equal(applied, 0);
  assert.equal(app.port.state().scope, 'pair');
  assert.deepEqual(await box.job(), prepared);
  assert.deepEqual(await box.pointer(), box.previous);
});

for (const changed of ['notes', 'serverApi']) {
  test(`TRUST-PARITY adapters: ${changed}, desktop и настоящая CLI-команда отклоняют подпись`, async (t) => {
    const box = await installedFixture(t, { mode: 'remote' });
    const { createApplicationUpdates } = await loadInstalledModule(t, 'desktop/src/applicationUpdates.ts',
      box.release.publicKeyPem);
    const { runUpdateCommand } = await loadInstalledModule(t, 'cli/updates.ts', box.release.publicKeyPem);
    const forged = structuredClone(box.release.index);

    forged.latest.payload[changed] = changed === 'notes'
      ? { ru: 'Подмена', en: 'Forged' } : { major: 0, minor: 2 };
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(forged)));

    const app = createApplicationUpdates({
      root: box.root,
      runningVersion: '0.2.0',
      localSelected: () => false,
      prepare: async () => {
        throw new Error('Доверие не проверено');
      },
      apply: async () => {
        throw new Error('Доверие не проверено');
      },
    });
    const output = [];

    t.after(() => app.close());
    await app.start();

    const deadline = Date.now() + 2000;

    while (app.port.state().checkState !== 'error' && Date.now() < deadline) {
      await pause(10);
    }

    assert.equal(app.port.state().checkState, 'error');
    assert.equal(app.port.state().error, 'release_signature_invalid');

    const code = await runUpdateCommand({
      kind: 'server',
      action: 'check-updates',
      json: true,
    }, box.root, {
      write: (text) => output.push(text),
      error: (text) => output.push(text),
    });
    const cli = JSON.parse(output.join(''));

    assert.equal(code, 1);
    assert.equal(cli.check.error, app.port.state().error);

    const server = await installedFixture(t, { mode: 'server', release: box.release });

    output.length = 0;

    const forced = await runUpdateCommand({
      kind: 'server',
      action: 'update',
      json: true,
      force: true,
    }, server.root, {
      write: (text) => output.push(text),
      error: (text) => output.push(text),
    });

    assert.equal(forced, 1);
    assert.equal(JSON.parse(output.join('')).error, 'release_signature_invalid');
    assert.equal(await server.job(), null);
    assert.deepEqual(await server.pointer(), server.previous);
    assert.equal(await box.job(), null);
    assert.deepEqual(await box.pointer(), box.previous);
    await box.preserved();
  });
}

const { installedPair } = await import('../helpers/installedPairFixture.mjs');

 test('LIVE-PAIR/APP-OWNERS/LOG-TAIL: новые живые версии пары после штатного drain', {
  timeout: 20000,
}, async (t) => {
  const box = await installedPair(t);
  const job = await box.job();

  assert.equal(job.stage, 'completed', JSON.stringify(job.error));
  assert.deepEqual(await box.pointer(), job.target);
  assert.match(await fs.readFile(path.join(box.root, 'update/log-tail'), 'utf8'), /LAST_LOG/);
  await box.preserved();
});

const { createServer: createTlsServer } = await import('node:https');
const { makeCert } = await import('../relay/helpers.js');
const { createUpstream } = await import('../../desktop/src/pipe/upstream.ts');

 test('REMOTE-RETURN: тот же TLS pin восстанавливается, чужой не получает HTTP', async (t) => {
  const box = await installedFixture(t, { mode: 'remote' });
  const trusted = await makeCert(box.temporary, 'trusted');
  const foreign = await makeCert(box.temporary, 'foreign');
  const client = await makeCert(box.temporary, 'client');
  let requests = 0;
  let server;
  let upstream;
  let port = 0;

  const listen = async (certificate) => {
    server = createTlsServer({ key: certificate.keyPem, cert: certificate.certPem }, (_request, response) => {
      requests += 1;
      response.setHeader('X-GrigDesk-Api', '0.1');
      response.end(JSON.stringify({ name: 'Тот же сервер', fp: certificate.fp }));
    });
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    port = server.address().port;
  };
  const disconnect = async () => {
    upstream?.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  };

  t.after(async () => {
    upstream?.close();
    server?.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve));
  });
  await listen(trusted);

  const profile = {
    address: `https://127.0.0.1:${port}`,
    fp: trusted.fp,
    identity: { key: client.keyPem, cert: client.certPem },
  };

  upstream = createUpstream(profile);
  await upstream.probe();
  assert.equal(upstream.state().status, 'online');
  await disconnect();
  upstream = createUpstream(profile);
  await upstream.probe();
  assert.equal(upstream.state().status, 'offline');
  upstream.close();
  await listen(trusted);
  upstream = createUpstream(profile);
  await upstream.probe();
  assert.equal(upstream.state().status, 'online');
  await disconnect();
  await listen(foreign);

  const before = requests;

  upstream = createUpstream(profile);
  await upstream.probe();
  assert.equal(upstream.state().status, 'identityMismatch');
  assert.equal(requests, before);
  assert.equal(profile.fp, trusted.fp);
});

const { installedServerUnit, inspectInstalledServer } = await import('../../shared/node/installedServer.ts');
const { isolatedEnvironment } = await import('../helpers/installedUpdateFixture.mjs');

for (const foreign of [false, true]) {
  test(`APP-OWNERS/OWNER-RECHECK: ${foreign ? 'чужая' : 'своя inactive'} unit`, async (t) => {
    const box = await installedFixture(t);
    const unitFile = path.join(box.temporary, 'grigdesk-server.service');
    const executable = path.join(box.root, 'bin/grigdesk-server');
    const stubs = path.join(box.temporary, 'stubs');
    const calls = path.join(box.temporary, 'systemctl-calls');
    const text = [
      'LoadState=loaded',
      'ActiveState=inactive',
      `ExecStart={ path=${executable} ; argv[]=${executable} ; }`,
      `WorkingDirectory=${foreign ? '/foreign' : box.root}`,
      'MainPID=0',
      'Result=success',
      `FragmentPath=${unitFile}`,
    ].join('\n');

    await fs.mkdir(stubs);
    await fs.writeFile(unitFile, `# GrigDesk installationId=${box.receipt.installationId}\n`,
      { mode: 0o600 });
    await fs.writeFile(path.join(stubs, 'systemctl'), [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> '${calls}'`,
      `printf '%s\\n' '${text}'`,
    ].join('\n'), { mode: 0o700 });
    isolatedEnvironment(t, { PATH: `${stubs}:/usr/bin:/bin` });

    if (foreign) {
      await assert.rejects(installedServerUnit(box.receipt), /release_foreign_service/);

      const { runInstalledCli } = await loadInstalledModule(t, 'cli/installedCli.ts',
        box.release.publicKeyPem);
      const output = [];

      t.mock.method(process.stderr, 'write', (value) => {
        output.push(String(value));

        return true;
      });
      assert.equal(await runInstalledCli(box.root, ['server', 'stop', '--force']), 1);
      assert.match(output.join(''), /release_foreign_service/);
    } else {
      assert.equal((await installedServerUnit(box.receipt)).ActiveState, 'inactive');
      assert.equal((await inspectInstalledServer(box.receipt)).kind, 'service');
      assert.equal((await inspectInstalledServer(box.receipt)).running, false);
    }

    assert.doesNotMatch(await fs.readFile(calls, 'utf8'), /start|stop|restart/);
    assert.deepEqual(await box.pointer(), box.previous);
    await box.preserved();
  });
}
