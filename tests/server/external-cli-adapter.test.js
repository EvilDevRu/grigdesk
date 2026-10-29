import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { artifactsPath } from '../../shared/runtime/dataHome.ts';
import { externalCliAdapter } from '../../server/src/lib/providerInstall/externalCliAdapter.ts';
import { execFile } from '../../server/src/lib/providerInstall/externalCliProcess.ts';
import { settingsFingerprint } from '../../server/src/lib/executorSettings/fingerprint.ts';

const execute = promisify(execFile);

test('adapter выбирает CLI нового shell для probe/run/session, managed остаётся прежним', async (t) => {
  const base = path.join(artifactsPath({ env: process.env, home: os.homedir() }),
    'external-cli-lifecycle/adapter-tests');

  await fs.mkdir(base, { recursive: true });

  const home = await fs.mkdtemp(path.join(base, 'case-'));
  const bin = path.join(home, 'bin');

  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'agent'), '#!/bin/sh\nprintf "%s" "$FIXTURE_FROM_RC"\n',
    { mode: 0o755 });
  await fs.writeFile(path.join(home, '.bashrc'), [
    `export PATH="${bin}:/usr/bin:/bin"`,
    'export FIXTURE_FROM_RC=chosen',
    '',
  ].join('\n'));
  await fs.writeFile(path.join(home, '.bash_profile'), 'source "$HOME/.bashrc"\n');

  const config = {
    agentBin: 'agent',
    dataHome: path.join(home, 'data'),
    artifactsDir: path.join(home, 'artifacts'),
  };
  const parent = {
    HOME: home,
    SHELL: '/bin/bash',
    PATH: '/usr/bin:/bin',
  };
  const run = async ({ config: input }) => ({ reply: (await execute(input.agentBin, [])).stdout });
  const adapter = {
    id: 'fixture',
    bin: (input) => input.agentBin,
    auth: () => ({ available: true }),
    externalCli: () => ({
      packageId: '@fixture/agent',
      binName: 'agent',
      configKey: 'agentBin',
      envKey: 'FIXTURE_AGENT',
    }),
    probe: async (input) => ({ ok: true, version: (await execute(input.agentBin, [])).stdout }),
    run,
    session: { open: run },
    prepareRuntime: async (input) => Object.freeze({ bin: input.agentBin,
      environment: (await execute(input.agentBin, [])).stdout }),
    nativeSettings: {
      context: (input, cwd) => ({
        providerId: 'fixture',
        binaryIdentity: input.agentBin,
        profileFingerprint: 'fixture',
        transport: 'stdio',
        mode: 'default',
        cwdRealpath: cwd
      }),
      discover: async () => ({}),
      prepare: async () => ({ accepted: [], payload: { safe: true } }),
    },
  };
  const wrapped = externalCliAdapter(adapter, parent);

  assert.equal((await wrapped.probe(config)).version, 'chosen');
  assert.equal((await wrapped.run({ config })).reply, 'chosen');
  assert.equal((await wrapped.session.open({ config })).reply, 'chosen');
  assert.equal(config.agentBin, 'agent');

  const preparedRuntime = await wrapped.prepareRuntime(config, { signal: AbortSignal.timeout(3000) });

  assert.equal(preparedRuntime.bin, path.join(bin, 'agent'));
  assert.equal(preparedRuntime.environment, 'chosen');

  // Новый shell уже не находит alias, а закреплённый handle сохраняет исходный CLI.
  await fs.writeFile(path.join(home, '.bashrc'), 'export PATH="/usr/bin:/bin"\n');
  assert.equal((await wrapped.run({ config, preparedRuntime })).reply, 'chosen');
  await assert.rejects(wrapped.run({ config, preparedRuntime: {} }), /Чужой runtime handle/u);

  const context = await wrapped.nativeSettings.context(config, home, 'chat', preparedRuntime);
  const plan = await wrapped.nativeSettings.prepare(context, {}, [], { signal: AbortSignal.timeout(3000) });
  const nativeSettings = structuredClone({ ...plan,
    fingerprint: settingsFingerprint({ context, accepted: plan.accepted }) });

  assert.equal((await wrapped.run({
    config,
    preparedRuntime,
    nativeSettings
  })).reply, 'chosen');
  await assert.rejects(wrapped.run({
    config,
    preparedRuntime,
    nativeSettings: { ...nativeSettings, payload: { safe: false } }
  }), /другого runtime/u);

  const managed = { ...adapter, externalCli: undefined };

  assert.equal(externalCliAdapter(managed, parent), managed);
});
