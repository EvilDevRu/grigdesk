import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { assertRuntimeClosure } from '../../tools/runtimeComposition.ts';
import { assertKnownDynamicReferences } from '../../tools/deepseekBuildInputs.ts';
import {
  ensureTestDeepSeekArtifact,
  verifyTestDeepSeekArtifact,
} from '../helpers/deepseekRuntimeArtifact.mts';
import { startDeepSeekServer } from '../../server/src/lib/deepseek/serverRuntime.ts';
import { createAcpClient } from '../../server/src/lib/acp/client.ts';
import {
  resolveDeepSeekRuntime,
  probeDeepSeekRuntime,
} from '../../server/src/lib/deepseek/runtimeProcess.ts';

const exec = promisify(execFile);

test('closure называет missing peer, YAML plugin, generated и native входы вместе', () => {
  const requirements = [
    {
      owner: 'transport',
      kind: 'peer',
      target: 'host-peer',
    },
    {
      owner: 'profile.yml',
      kind: 'yaml',
      target: 'settings-plugin',
    },
    {
      owner: 'api',
      kind: 'generated',
      target: 'api/lib/typert.host.js',
    },
    {
      owner: 'sandbox',
      kind: 'native',
      target: 'linux-x64/bin/glibc/system.node',
    },
  ];

  assert.throws(() => assertRuntimeClosure(new Set(['transport']), requirements), (error) => {
    for (const { target } of requirements) {
      assert.ok(error.message.includes(target), error.message);
    }

    return true;
  });
});

test('неизвестный dynamic import блокирует сборку, разрешённый проверяется как dependency', () => {
  assert.throws(() => assertRuntimeClosure(new Set(), [
    {
      owner: 'loader.ts:12',
      kind: 'dynamic',
      target: 'import(variable)',
    },
  ]), /loader.ts:12.*import\(variable\)/u);
  assertRuntimeClosure(new Set(['known-plugin']), [
    {
      owner: 'loader.ts',
      kind: 'dynamic',
      target: 'known-plugin',
    },
  ]);
});

test('registry проверяет точное выражение dynamic import, а не только имя пакета', () => {
  const reference = {
    file: 'loader/src/index.ts',
    expression: 'import(hostPlugin)',
  };
  const known = [{ ...reference, reason: 'Plugin из проверенной host composition' }];

  assertKnownDynamicReferences([reference], known);
  assert.throws(() => assertKnownDynamicReferences([
    { ...reference, expression: 'import(newTarget)' },
  ], known), /неизвестный dynamic import\(newTarget\)/u);
});

test('настоящий runtime переносится и сохраняет web startup, cookie и settings RPC', async (t) => {
  const artifact = await ensureTestDeepSeekArtifact();
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-dsh-build-'));
  const relocated = path.join(temporary, 'runtime with spaces');
  const home = path.join(temporary, 'private-home');
  const cwd = path.join(temporary, 'workspace');
  let server;

  t.after(async () => {
    await server?.stop();
    await fs.rm(temporary, { recursive: true, force: true });
  });
  await fs.cp(artifact, relocated, { recursive: true, verbatimSymlinks: true });
  await verifyTestDeepSeekArtifact(relocated);
  await fs.mkdir(home);
  await fs.mkdir(cwd);

  const entry = path.join(relocated, 'entry.mjs');
  const version = await exec(process.execPath, [entry, '-V'], { cwd, env: { PATH: process.env.PATH } });

  assert.equal(version.stdout.trim(), '0.1.5-rc.2');

  const overlay = path.join(temporary, 'overlay.yml');

  await fs.writeFile(overlay, '[]\n');

  server = await startDeepSeekServer({
    runtime: resolveDeepSeekRuntime({ deepseekArtifactDir: relocated }),
    bin: process.execPath,
    overlayPath: overlay,
    cwd,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      DSH_HOME: home,
      DSH_TELEMETRY_DISABLED: '1',
      NO_COLOR: '1',
    },
  });

  const description = await server.client.rpc('settings/describe');

  assert.equal(description.writable, true);
  assert.ok(description.namespaces.some((namespace) => namespace.ns === 'llm-deepseek'));
  assert.equal((await probeDeepSeekRuntime({ deepseekArtifactDir: relocated })).ok, true);
  await server.stop();
});

test('настоящий runtime воспроизводим: в payload нет путей временной сборки', async () => {
  const artifact = await ensureTestDeepSeekArtifact();
  const metadata = JSON.parse(await fs.readFile(path.join(artifact, 'runtime.json'), 'utf8'));
  const leaked = [];

  // Случайные имена staging (`.prepare-*`, `.deepseek-build-*`) меняли бы buildId каждой
  // пересборки тех же входов, а с ним привязку сессий чатов и coverage конвейера.
  for (const name of Object.keys(metadata.payload).filter((file) => /\.[cm]?js$/u.test(file))) {
    if (!(await fs.lstat(path.join(artifact, name))).isFile()) {
      continue;
    }

    const text = await fs.readFile(path.join(artifact, name), 'utf8');

    if (/\.deepseek-build-|\.prepare-[A-Za-z0-9]{6}/u.test(text)) {
      leaked.push(name);
    }
  }

  assert.deepEqual(leaked, []);
  assert.equal(JSON.stringify(metadata.inputIdentity).includes(`"${process.versions.node}"`), false);
});

test('настоящий ACP initialize не требует ключа и сохраняет stdout только для frames', async (t) => {
  const artifact = await ensureTestDeepSeekArtifact();
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-dsh-acp-build-'));
  const runtime = resolveDeepSeekRuntime({ deepseekArtifactDir: artifact });
  const child = spawn(runtime.command, [...runtime.prefixArgs, '--profile', 'acp'], {
    cwd: temporary,
    env: {
      PATH: process.env.PATH,
      HOME: temporary,
      DSH_HOME: temporary,
      DSH_TELEMETRY_DISABLED: '1',
      NO_COLOR: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const client = createAcpClient(child, { requestTimeoutMs: 15_000 });
  let output = '';

  child.stdout.on('data', (chunk) => {
    output += String(chunk);
  });
  t.after(async () => {
    client.close();
    child.kill('SIGTERM');

    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => child.once('exit', resolve));
    }

    await fs.rm(temporary, { recursive: true, force: true });
  });

  const initialized = await client.request('initialize', {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: 'grigdesk-build-test', version: '1' },
  });

  assert.equal(initialized.protocolVersion, 1);
  assert.equal(initialized.agentInfo.name, 'deepseek-harness-acp');

  const frames = output.trim().split('\n').map(JSON.parse);

  assert.ok(frames.length > 0);
  assert.ok(frames.every((frame) => frame.jsonrpc === '2.0'));
});
