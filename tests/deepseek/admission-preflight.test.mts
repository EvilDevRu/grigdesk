import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { glmRuntimeIdentity } from '../../deepseek/scripts/buildRuntime.mts';
import { COMPOSITION_REVISION } from '../../deepseek/scripts/runtimeComposition.ts';
import { glmCompatibilityHash } from '../../shared/node/glmCompatibility.ts';
import { artifactsPath } from '../../shared/runtime/dataHome.ts';

const run = promisify(execFile);
const script = fileURLToPath(new URL('../../deepseek/scripts/admissionPreflight.mts', import.meta.url));
const hostContract = fileURLToPath(new URL('../../server/deepseek-host-contract.json',
  import.meta.url));

test('PREFLIGHT-IDENTITY: identity дерева детерминирован и привязан к vendor commit', async () => {
  const first = await glmRuntimeIdentity();
  const second = await glmRuntimeIdentity();

  assert.deepEqual(first, second);
  assert.match(first.source.commit, /^[a-f0-9]{40}$/u);
  assert.ok(first.inputIdentity.composition.startsWith(`${COMPOSITION_REVISION}:`));
  assert.match(first.inputIdentity.dependencyLock, /^[a-f0-9]{64}$/u);

  if (!first.llmPiAi) {
    assert.fail('llm-pi-ai отсутствует в рабочем дереве');
  }
});

test('PREFLIGHT: список недостающих режимов точен по списку compatibility', async (t) => {
  const identity = await glmRuntimeIdentity();
  const plugin = identity.llmPiAi;

  if (!plugin) {
    assert.fail('llm-pi-ai отсутствует в рабочем дереве');
  }

  const host = JSON.parse(await readFile(hostContract, 'utf8'));
  const revisions = {
    profile: host.glm.profileRevision,
    policy: host.glm.policyRevision,
  };
  const admitted = glmCompatibilityHash({ ...identity, llmPiAi: plugin }, 'api', revisions);
  const parent = path.join(artifactsPath({ env: process.env, home: os.homedir() }), 'glm-preflight');

  await mkdir(parent, { recursive: true });

  const directory = await mkdtemp(path.join(parent, 'compatibility-'));
  const list = path.join(directory, 'glm.json');

  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(list, JSON.stringify({
    format: 1,
    profileRevision: revisions.profile,
    policyRevision: revisions.policy,
    admission: [{ mode: 'api', compatibility: admitted }],
  }));

  const { stdout } = await run(process.execPath, [script,
    '--mode', 'api', '--compatibility', list, '--host-contract', hostContract]);

  assert.deepEqual(JSON.parse(stdout), {
    consumerMode: 'api',
    missing: ['coding-plan'],
    pluginMissing: false,
  });
});
