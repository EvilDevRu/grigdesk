import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { testDeepSeekBinarySelection } from '../helpers/deepseekBinary.mts';
import { resolveDeepSeekRuntime } from '../../server/src/lib/deepseek/runtimeProcess.ts';
import { createAcpClient } from '../../server/src/lib/acp/client.ts';
import { acpDeepSeekSettingsRpc } from '../../server/src/lib/deepseek/nativeSettingsRpc.ts';
import { applyDeepSeekNativeSettings } from '../../server/src/lib/executorSettings/deepseek.ts';

/**
 * Probe создаёт только свой процесс и документ, без credentials и рабочих сессий.
 * Наблюдение request frames подтверждает отсутствие session/new и prompt при metadata.
 */
async function settingsProcess(t) {
  const { config } = await testDeepSeekBinarySelection();
  const runtime = resolveDeepSeekRuntime(config);

  assert.equal(runtime.kind, 'binary');

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deepseek-settings-acp-'));
  const overlay = path.join(root, 'overlay.yml');
  const document = path.join(root, 'native-settings.yaml');

  await fs.writeFile(document, '{}\n', { mode: 0o600 });
  await fs.writeFile(overlay, `- id: settings\n  config:\n    path: ${JSON.stringify(document)}\n`);

  const child = spawn(runtime.command, [...runtime.prefixArgs, '--profile', 'acp', '--patch', overlay], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: root,
      DSH_HOME: root,
      DSH_TELEMETRY_DISABLED: '1',
      NO_COLOR: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const client = createAcpClient(child, { requestTimeoutMs: 15_000 });
  const frames = [];
  const write = child.stdin.write.bind(child.stdin);

  child.stdin.write = (chunk, ...args) => {
    frames.push(JSON.parse(String(chunk)));

    return write(chunk, ...args);
  };
  t.after(async () => {
    client.close();
    child.kill('SIGTERM');

    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => child.once('exit', resolve));
    }

    await fs.rm(root, { recursive: true, force: true });
  });

  const initialized = await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} });

  return {
    client,
    initialized,
    frames,
    document,
  };
}

test('настоящий ACP объявляет private settings bridge без ключа и без session/new', async (t) => {
  const { client, initialized, frames } = await settingsProcess(t);

  assert.equal(initialized.agentCapabilities?._meta?.['grigdesk.settings']?.contract, 1);

  const description = await client.request('_grigdesk/settings/describe', {});

  assert.equal(description.writable, true);
  assert.equal(description.hasDocument, true);
  assert.ok(description.namespaces.some((namespace) => namespace.ns === 'llm-deepseek'));
  assert.deepEqual(frames.map((frame) => frame.method), ['initialize', '_grigdesk/settings/describe']);
});

test('настоящий ACP делегирует CAS и validation upstream settings controller', async (t) => {
  const { client, initialized, frames } = await settingsProcess(t);
  const description = await client.request('_grigdesk/settings/describe', {});
  const namespace = description.namespaces.find((item) => item.ns === 'llm-deepseek');
  const mutate = (ns, revision, leaf, value) => client.request('_grigdesk/settings/mutate', {
    ns,
    expectedRevision: revision,
    ops: [{
      op: 'set',
      path: [leaf],
      value,
    }],
  });
  const changed = await mutate(namespace.ns, namespace.revision, 'maxTokens', 64);

  assert.equal(changed.value.maxTokens, 64);
  await assert.rejects(mutate(namespace.ns, namespace.revision, 'maxTokens', 128));
  await assert.rejects(mutate('nonexistent-namespace', 0, 'maxTokens', 128));
  await assert.rejects(mutate(namespace.ns, changed.revision, 'maxTokens', -1));
  await assert.rejects(applyDeepSeekNativeSettings(acpDeepSeekSettingsRpc(client, initialized), {
    accepted: [{
      fieldId: '["llm-deepseek","nonexistent-field"]',
      path: ['llm-deepseek', 'nonexistent-field'],
      value: 128,
    }],
  }));

  const readback = await client.request('_grigdesk/settings/describe', {});

  assert.equal(readback.namespaces.find((item) => item.ns === namespace.ns).value.maxTokens, 64);
  assert.equal(frames.some((frame) => ['session/new', 'session/prompt'].includes(frame.method)), false);
});
