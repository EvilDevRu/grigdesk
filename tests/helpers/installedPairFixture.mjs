import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPublicKey } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as pause } from 'node:timers/promises';

import { installedFixture, installedRelease, pinnedKeyHook, isolatedEnvironment }
  from './installedUpdateFixture.mjs';
import { writeInstallationJson } from '../../shared/node/installedLayout.ts';
import { updateProcessAlive, inspectInstalledServer } from '../../shared/node/installedServer.ts';

const repository = path.resolve(import.meta.dirname, '../..');

/**
 * Настоящие подписанные launchers запускают отдельные desktop/server процессы A и B.
 * HTTP реализует внешний серверный порт; manager, worker, drain/proofs и current не подменяются.
 */
export async function installedPair(t, options = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'update-pair-'));
  const driver = path.join(temporary, 'driver.mjs');
  const hook = path.join(temporary, 'pinned-key.mjs');
  const script = (component, identity) => options.desktopScript && component === 'desktop'
    ? options.desktopScript(identity) : [
    '#!/bin/sh',
    'if [ "$1" = "--version" ] || [ "$1" = "--grigdesk-release-probe" ]; then',
    `  printf '%s\\n' '${JSON.stringify(identity)}'`,
    'else',
    `  exec '${process.execPath}' --import '${hook}' '${driver}' ${component} '${identity.version}' "$0"`,
    'fi',
  ].join('\n');
  const release = installedRelease({ script });
  const box = await installedFixture(t, { release });
  const old = installedRelease({
    version: '0.2.0',
    script,
    keys: { privateKey: release.privateKey, publicKey: createPublicKey(release.publicKeyPem) },
  });

  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  await pinnedKeyHook(temporary, release.publicKeyPem);

  for (const component of ['desktop', 'server']) {
    const file = old.files.get(component);
    const target = path.join(box.root, box.previous[component], file.name);

    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.writeFile(target, file.bytes, { mode: 0o555 });
  }

  await writeInstallationJson(box.root, 'generations/0.2.0/release.json', old.envelope);

  const moduleUrl = (name) => JSON.stringify(path.join(repository, `shared/node/${name}.ts`));
  const contents = [
    "import fs from 'node:fs/promises';",
    "import path from 'node:path';",
    "import http from 'node:http';",
    "import { parseEnv } from 'node:util';",
    "import { randomUUID } from 'node:crypto';",
    "import { spawn } from 'node:child_process';",
    "import { once } from 'node:events';",
    'import { readInstallation, readInstalledPointer, writeInstallationJson }',
    `  from ${moduleUrl('installedLayout')};`,
    `import { readInstalledUpdate } from ${moduleUrl('installedUpdateState')};`,
    `import { readUpdateProcess } from ${moduleUrl('updateProcessOwner')};`,
    `import { inspectInstalledServer } from ${moduleUrl('installedServer')};`,
    `import { createUpdateHandoff, launchUpdateWorker, waitUpdateWorker,`,
    `  runInstalledUpdateWorker, writeDesktopBootProof } from ${moduleUrl('installedUpdateWorker')};`,
    `const root = ${JSON.stringify(box.root)};`,
    'const receipt = await readInstallation(root);',
    "const env = parseEnv(await fs.readFile(path.join(receipt.dataHome, '.env'), 'utf8'));",
    'const port = Number(env.GRIGDESK_PORT);',
    "const role = process.argv[2];",
    "const version = process.argv[3];",
    "if (role === 'server') {",
    `  if (${Boolean(options.failTargetServer)} && version === '0.3.0') process.exit(17);`,
    '  const instanceId = randomUUID();',
    '  let active = true;',
    '  const server = http.createServer(async (req, res) => {',
    "    res.setHeader('Content-Type', 'application/json');",
    "    if (req.url === '/api/system/runtime-identity') {",
    '      res.end(JSON.stringify({ installationId: receipt.installationId, productVersion: version,',
    '        packageId: "b".repeat(64), instanceId, pid: process.pid,',
    '        binary: process.argv[4], owner: "desktop" }));',
    "    } else if (req.url === '/api/chat/active') {",
    '      res.end(JSON.stringify({ active: ["ход"], queued: ["очередь"] }));',
    "    } else if (req.url === '/api/tasks') {",
    '      res.end(JSON.stringify({ tasks: [{ task: "123", daemonAlive: active }] }));',
    "    } else if (req.url === '/api/tasks/123/stop') {",
    '      active = false;',
    '      res.end(JSON.stringify({ outcome: "stopped" }));',
    "    } else if (req.url === '/api/system/update-drain') {",
    '      req.resume();',
    '      res.end("{}");',
    '      const job = await readInstalledUpdate(receipt);',
    "      process.stdout.write('LAST_LOG\\n');",
    '      server.close(async () => {',
    "        await writeInstallationJson(root, 'update/server-drain.json', {",
    '          jobId: job.id, nonce: job.intent.nonce, instanceId, success: true,',
    '        });',
    '        process.exit(0);',
    '      });',
    '      server.closeIdleConnections();',
    '    } else { res.end("{}"); }',
    '  });',
    "  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));",
    "} else if (role === 'apply') {",
    '  await runInstalledUpdateWorker(root, version);',
    "} else if (role === 'launch') {",
    '  const pointer = await readInstalledPointer(receipt);',
    '  const child = spawn(root + "/" + pointer.desktop + "/GrigDesk", [], {',
    '    detached: true, stdio: "ignore", env: process.env,',
    '  });',
    '  child.unref();',
    '} else {',
    '  const pointer = await readInstalledPointer(receipt);',
    '  const child = spawn(root + "/" + pointer.server + "/bin/grigdesk-server", [], {',
    '    stdio: ["ignore", "pipe", "pipe"], env: process.env,',
    '  });',
    '  const closed = once(child, "close");',
    '  let tail = "";',
    '  child.stdout.on("data", (bytes) => { tail += bytes; });',
    '  for (let retry = 0; retry < 100; retry++) {',
    '    try { if ((await inspectInstalledServer(receipt)).running) break; } catch {}',
    '    await new Promise((resolve) => setTimeout(resolve, 25));',
    '  }',
    '  const job = await readInstalledUpdate(receipt);',
    '  if (version === "0.2.0" && job.stage === "ready") {',
    '    const handoff = await createUpdateHandoff(root, job.id, {',
    '      desktop: await readUpdateProcess(process.pid), stopLocal: true,',
    '    });',
    '    if (handoff.activity.active !== 1 || handoff.activity.queued !== 1',
    '      || handoff.activity.tasks[0] !== "123") throw new Error("Неверная сводка активности");',
    '    await launchUpdateWorker(root, job.id);',
    '    await waitUpdateWorker(root, handoff, "drained");',
    '    await closed;',
    '    await fs.writeFile(root + "/update/log-tail", tail);',
    '    process.exit(0);',
    '  } else {',
    `    const identity = { ...${JSON.stringify(release.identity)}, version };`,
    '    identity.releaseId = identity.channel + "/" + version + "/" + identity.commit;',
    '    await writeDesktopBootProof(root, identity);',
    '    setInterval(() => {}, 1000);',
    '  }',
    '}',
  ].join('\n');

  await fs.writeFile(driver, contents);

  const bin = path.join(temporary, 'bin');

  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'systemctl'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  await fs.writeFile(path.join(box.root, 'update/maintenance'), [
    '#!/bin/sh', `exec '${process.execPath}' --import '${hook}' '${driver}' "$@"`,
  ].join('\n'), { mode: 0o700 });

  isolatedEnvironment(t, { PATH: `${bin}:/usr/bin:/bin` });

  await options.beforeLaunch?.(box, driver, hook);

  const job = await box.create();

  await box.manager.prepare(job.id);

  const child = spawn(path.join(box.root, box.previous.desktop, 'GrigDesk'), [], {
    env: {
      HOME: temporary,
      PATH: `${bin}:/usr/bin:/bin`,
      LANG: 'C.UTF-8',
      ...options.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const errors = [];

  child.stderr.on('data', (bytes) => errors.push(bytes));
  t.after(() => child.kill('SIGTERM'));
  box.onCleanup(async () => {
    const server = await inspectInstalledServer(box.receipt).catch(() => null);

    if (server?.process && await updateProcessAlive(server.process)) {
      process.kill(server.process.pid, 'SIGTERM');
    }

    for (const name of ['desktop-boot.json', 'worker-process.json']) {
      const marker = await fs.readFile(path.join(box.root, 'update', name), 'utf8')
        .then(JSON.parse, () => null);

      if (marker?.process && await updateProcessAlive(marker.process)) {
        process.kill(marker.process.pid, 'SIGTERM');
      }
    }
  });

  const [exit] = await once(child, 'exit');

  assert.equal(exit, 0, Buffer.concat(errors).toString());

  const deadline = Date.now() + (options.waitMs ?? 12000);

  while ((await box.job())?.stage !== (options.expectedStage ?? 'completed') && Date.now() < deadline) {
    await pause(40);
  }

  return box;
}
