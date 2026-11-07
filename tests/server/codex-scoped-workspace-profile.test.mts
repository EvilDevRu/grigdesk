import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { createRequire } from 'node:module';

import codex from '../../server/src/lib/executors/codex.ts';
import { isRecord } from '../../shared/lib/objects.ts';

const requireServer = createRequire(new URL('../../server/package.json', import.meta.url));
const { parse } = requireServer('smol-toml');
const fixtureUrl = new URL('../fixtures/codex-app-server/scoped-workspace-0.165.mts', import.meta.url);

/**
 * Свежая копия CLI и свои каталоги изолируют кэш capability и все файловые эффекты.
 * Именованный профиль проходит через настоящий адаптер, TOML argv и JSON-RPC handshake.
 */
async function fixture(t: TestContext, failure = '') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-codex-profile-'));
  const bin = path.join(directory, 'codex');
  const repo = path.join(directory, 'repo');
  const output = path.join(directory, 'output');
  const trace = path.join(directory, 'trace.jsonl');

  await Promise.all([mkdir(repo), mkdir(output)]);
  await writeFile(bin, '#!/usr/bin/env node\n'
    + `import { runScopedWorkspaceFixture } from ${JSON.stringify(fixtureUrl.href)};\n`
    + `runScopedWorkspaceFixture({ missingPermissions: ${failure === 'schema'} });\n`);
  await chmod(bin, 0o755);
  t.after(() => rm(directory, { recursive: true, force: true }));

  return {
    bin,
    repo,
    output,
    trace,
    options: {
      config: { codexBin: bin },
      env: {
        ...process.env,
        GRIGDESK_CODEX_PROFILE_FAILURE: failure,
        GRIGDESK_CODEX_PROFILE_TRACE: trace,
      },
      cwd: output,
      model: 'gpt-triage',
      effort: 'high',
      message: 'Оцени задачу по коду.',
      permissionMode: 'acceptEdits',
      tokenInfoReader: async () => null,
      workspaceAccess: {
        readableRoots: [repo],
        writableRoots: [output],
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
        allowExternalMcp: false,
      },
    },
  };
}

test('Codex нового протокола доступен триажу и сохраняет профиль на каждом ходе', async (t) => {
  const f = await fixture(t);

  assert.equal(await codex.scopedWorkspace({ codexBin: f.bin }), true);

  const first = await codex.run(f.options);

  assert.ok(isRecord(first) && typeof first.sessionId === 'string');

  const second = await codex.run({ ...f.options, sessionId: first.sessionId });
  const trace = (await readFile(f.trace, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));

  assert.equal(first.reply, 'Оценка готова.');
  assert.ok(isRecord(second));
  assert.equal(second.reply, 'Оценка готова.');

  for (const process of trace.filter((entry) => entry.argv)) {
    const config: Record<string, unknown> = {};

    for (let index = 0; index < process.argv.length; index += 1) {
      if (process.argv[index] === '-c') {
        Object.assign(config, parse(process.argv[++index]));
      }
    }

    assert.ok(typeof config.default_permissions === 'string' && isRecord(config.permissions));

    const profile = config.permissions[config.default_permissions];

    assert.ok(isRecord(profile) && isRecord(config.features));

    assert.deepEqual(profile.filesystem, {
      ':root': 'deny',
      ':minimal': 'read',
      [f.bin]: 'read',
      [f.repo]: 'read',
      [f.output]: 'write',
    });
    assert.deepEqual(profile.network, { enabled: false });
    assert.deepEqual(config.mcp_servers, {});
    assert.equal(config.features.hooks, false);
  }

  const turns = trace.filter((entry) => entry.method === 'turn/start');

  assert.equal(turns.length, 2);
  assert.ok(turns.every((entry) => entry.params.model === 'gpt-triage' && entry.params.effort === 'high'));
  assert.ok(turns.every((entry) => entry.params.permissions.startsWith('grigdesk-triage-')));
  assert.ok(turns.every((entry) => !Object.hasOwn(entry.params, 'sandboxPolicy')));
});

for (const failure of ['profile', 'network', 'grant', 'mcp']) {
  test(`Codex не получает задачу при подмене изоляции: ${failure}`, async (t) => {
    const f = await fixture(t, failure);

    await assert.rejects(codex.run(f.options), /не подтвердил|не принял/u);

    const trace = (await readFile(f.trace, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));

    assert.equal(trace.some((entry) => entry.method === 'turn/start'), false);
  });
}

test('CLI без проверяемого протокола скрывается из выбора триажа и не получает постановку', async (t) => {
  const f = await fixture(t, 'schema');

  assert.equal(await codex.scopedWorkspace({ codexBin: f.bin }), false);
  await assert.rejects(codex.run(f.options), /не поддерживает/u);

  const trace = await readFile(f.trace, 'utf8').catch(() => '');

  assert.doesNotMatch(trace, /turn\/start/u);
});
