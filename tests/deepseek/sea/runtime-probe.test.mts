import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { createAcpClient } from '../../../server/src/lib/acp/client.ts';
import { startDeepSeekServer } from '../../../server/src/lib/deepseek/serverRuntime.ts';
import { sha256 } from '../../../shared/node/hash.ts';
import { artifactsPath } from '../../../shared/runtime/dataHome.ts';
import { hashRuntimePayload } from '../../../deepseek/scripts/buildRuntime.mts';
import { ensureTestDeepSeekBinary } from '../../helpers/deepseekBinary.mts';
import { nativeSource, workerSource } from '../../helpers/deepseekNativeProbes.mts';

const run = promisify(execFile);

test('изолированный Node 24 runtime работает через ELF в ACP и web без fixture исходников', {
  timeout: 600000,
}, async (t) => {
  const candidate = await ensureTestDeepSeekBinary();
  const artifacts = path.join(artifactsPath({ env: process.env, home: os.homedir() }), 'deepseek-binary');
  const scratch = path.join(artifacts, 's10a/native-proof');
  const source = new URL('../../../deepseek/build/runtime-deps/node_modules', import.meta.url);
  const before = sha256(JSON.stringify(await hashRuntimePayload(fileURLToPath(source))));

  await mkdir(scratch, { recursive: true });

  const temporary = await mkdtemp(path.join(scratch, 'runtime-'));
  const cache = candidate.cacheDir;
  const payload = path.join(cache, 'packages', candidate.info.packageId);
  const binaryDir = path.join(temporary, 'binary');
  const binary = path.join(binaryDir, 'deepseek');
  const nativeProbe = path.join(temporary, 'native-probe.cjs');
  const workerProbe = path.join(temporary, 'workers-probe.mjs');
  let server: Awaited<ReturnType<typeof startDeepSeekServer>> | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let client: ReturnType<typeof createAcpClient> | undefined;

  t.after(async () => {
    try {
      client?.close();

      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => child!.once('exit', () => resolve()));
      }

      await server?.stop();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  assert.equal(candidate.info.workerNode.version, '24.21.0');
  await mkdir(binaryDir);
  await copyFile(candidate.binary, binary);
  await writeFile(nativeProbe, nativeSource);
  await writeFile(workerProbe, workerSource);
  assert.deepEqual(await readdir(binaryDir), ['deepseek']);
  assert.equal((await readdir(path.dirname(path.dirname(candidate.binary))))
    .some((name) => name.startsWith('source-')), false, 'Приватная source fixture удалена helper-ом');

  const home = path.join(temporary, 'home');

  await mkdir(home);

  const environment = {
    PATH: '',
    HOME: home,
    DSH_HOME: home,
    TMPDIR: temporary,
    DSH_TELEMETRY_DISABLED: '1',
    NO_COLOR: '1',
  };
  const acpArgs = ['--cache-dir', cache, '--profile', 'acp'];

  child = spawn(binary, acpArgs, {
    cwd: temporary,
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  client = createAcpClient(child, { requestTimeoutMs: 20000 });

  let stdout = '';

  child.stdout!.on('data', (chunk) => {
    stdout += String(chunk);
  });

  const initialized = await client.request('initialize', {
    protocolVersion: 1,
    clientCapabilities: {},
  }) as Record<string, any>;
  const acpDescription = await client.request('_grigdesk/settings/describe', {}) as Record<string, any>;

  assert.equal(initialized.protocolVersion, 1);
  assert.equal(initialized.agentCapabilities?._meta?.['grigdesk.settings']?.contract, 1);
  assert.equal(acpDescription.writable, true);
  assert.ok(acpDescription.namespaces.some((entry: { ns: string }) => entry.ns === 'llm-deepseek'));
  assert.ok(stdout.trim().split('\n').map((line) => JSON.parse(line))
    .every((frame) => frame.jsonrpc === '2.0'));

  client.close();
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => child!.once('exit', () => resolve()));

  const native = await run(path.join(payload, 'node'), [nativeProbe, payload], {
    cwd: temporary,
    env: environment,
    timeout: 15000,
  });
  const nativeInfo = JSON.parse(native.stdout);
  const helpers = await run(path.join(payload, 'node'), [workerProbe, payload], {
    cwd: temporary,
    env: environment,
    timeout: 15000,
  });
  const helperInfo = JSON.parse(helpers.stdout);

  assert.deepEqual(nativeInfo.addons, {
    'node-pty': true,
    'system.node': true,
    sharp: true,
    koffi: true,
  });
  assert.equal(nativeInfo.nodeVersion, candidate.info.workerNode.version);
  assert.equal(nativeInfo.nativeAbi, candidate.info.workerNode.abi);
  assert.equal(nativeInfo.execPath, path.join(payload, 'node'));
  assert.deepEqual(helperInfo, { code: 42, workflow: 42 });
  await writeFile(path.join(scratch, 'native-from-payload.json'), native.stdout);
  await writeFile(path.join(scratch, 'workers-from-payload.json'), helpers.stdout);

  const overlay = path.join(temporary, 'overlay.yml');

  // Транспорт вызывает spawn с тремя аргументами; адаптер добавляет только cache-dir.
  // Реальный ELF и его stdio сохраняются, подмены процесса здесь нет.
  const spawnWebProcess = ((command: string, args: readonly string[], options: SpawnOptions) => {
    return spawn(command, ['--cache-dir', cache, ...args], options);
  }) as typeof spawn;

  await writeFile(overlay, '[]\n');
  server = await startDeepSeekServer({
    bin: binary,
    overlayPath: overlay,
    cwd: temporary,
    env: environment,
    spawnProcess: spawnWebProcess,
  });

  const webDescription = await server.client.rpc('settings/describe') as Record<string, any>;

  assert.equal(webDescription.writable, true);
  assert.ok(webDescription.namespaces.some((entry: { ns: string }) => entry.ns === 'llm-deepseek'));
  await server.stop();

  const after = await hashRuntimePayload(fileURLToPath(source));

  await writeFile(path.join(scratch, 'legacy-deps-before.sha256'), `${before}\n`);
  await writeFile(path.join(scratch, 'legacy-deps-after.sha256'), `${sha256(JSON.stringify(after))}\n`);
  assert.equal(sha256(JSON.stringify(after)), before);
  await writeFile(path.join(scratch, 'transport-proof.json'), `${JSON.stringify({
    hostNode: process.versions.node,
    workerNode: nativeInfo.nodeVersion,
    workerAbi: nativeInfo.nativeAbi,
    metadataAbi: candidate.info.workerNode.abi,
    acpProtocolVersion: initialized.protocolVersion,
    acpSettingsContract: initialized.agentCapabilities._meta['grigdesk.settings'].contract,
    acpSettings: acpDescription.writable,
    webSettings: webDescription.writable,
    legacyDependenciesUnchanged: true,
  }, null, 2)}\n`);
});
