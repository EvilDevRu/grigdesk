import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildKimiHostLaunch } from '../../server/src/lib/kimi/hostLaunch.ts';

async function fixture(t, { credentialMode = 0o600 } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-kimi-host-launch-test-'));
  const cwd = path.join(root, 'workspace');
  const kimiHome = path.join(root, 'kimi-home');
  const credentialDir = path.join(kimiHome, 'credentials');
  const kimiBin = path.join(root, 'kimi');
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(credentialDir, { recursive: true });
  await fs.writeFile(kimiBin, '#!/bin/sh\n', { mode: 0o755 });
  await fs.writeFile(path.join(credentialDir, 'kimi-code.json'), '{}\n', { mode: credentialMode });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, cwd, config: { kimiBin, kimiHome } };
}

test('host launch: прямая команда acp, caller-env, без proxy и systemd-юнита', async (t) => {
  const f = await fixture(t);
  const launch = await buildKimiHostLaunch({
    config: f.config,
    cwd: f.cwd,
    env: { PATH: '/usr/bin', CUSTOM_FLAG: '1' },
  });
  assert.equal(launch.command, await fs.realpath(f.config.kimiBin));
  assert.deepEqual(launch.args, ['acp']);
  assert.equal(launch.cwdReal, await fs.realpath(f.cwd));
  assert.equal(launch.env.KIMI_CODE_HOME, f.config.kimiHome);
  assert.equal(launch.env.KIMI_DISABLE_CRON, '1');
  assert.equal(launch.env.CUSTOM_FLAG, '1');
  assert.equal(launch.env.PATH, '/usr/bin');
  assert.equal(launch.env.HTTPS_PROXY, undefined);
  assert.equal(launch.env.HTTP_PROXY, undefined);
  assert.equal(launch.unit, null);
});

test('host launch: caller-env не может подменить KIMI_CODE_HOME', async (t) => {
  const f = await fixture(t);
  const launch = await buildKimiHostLaunch({
    config: f.config,
    cwd: f.cwd,
    env: { KIMI_CODE_HOME: '/etc' },
  });
  assert.equal(launch.env.KIMI_CODE_HOME, f.config.kimiHome);
});

test('host launch: отказывает на битом cwd и неисполняемом бинаре', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    buildKimiHostLaunch({ config: f.config, cwd: path.join(f.root, 'missing'), env: {} }),
    /kimi_cwd_not_directory/,
  );
  const badBin = path.join(f.root, 'kimi-noexec');
  await fs.writeFile(badBin, '#!/bin/sh\n', { mode: 0o644 });
  await assert.rejects(
    buildKimiHostLaunch({ config: { ...f.config, kimiBin: badBin }, cwd: f.cwd, env: {} }),
    /kimi_bin_invalid/,
  );
});

test('host launch: credentials с открытыми правами отклоняются', async (t) => {
  const f = await fixture(t, { credentialMode: 0o644 });
  await assert.rejects(
    buildKimiHostLaunch({ config: f.config, cwd: f.cwd, env: {} }),
    /kimi_credentials_permissions_too_open/,
  );
});

test('host launch: без credential-файла отказывает', async (t) => {
  const f = await fixture(t);
  await fs.rm(path.join(f.config.kimiHome, 'credentials', 'kimi-code.json'));
  await assert.rejects(
    buildKimiHostLaunch({ config: f.config, cwd: f.cwd, env: {} }),
  );
});
