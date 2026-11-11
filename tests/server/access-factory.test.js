import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  OLD_KEY, activate, addProfile, apiAdapters, profileFixture, profiles,
  serverWorker, syntheticAdapter, vendorServer,
} from '../helpers/accessProfiles.js';
import { factoryDecisionFixture } from './helpers/factoryDecisionFixture.js';

/**
 * Stub заменяет только процессы движка/systemd, ledger остаётся production-формата.
 * Первый запуск проходит HTTP preflight, продолжение использует production spawn-границу.
 */
async function executable(root, name, fixture) {
  const template = new URL(`../fixtures/access-profiles/${fixture}`, import.meta.url);
  const source = await fs.readFile(template, 'utf8');

  await fs.writeFile(path.join(root, 'bin', name), `#!${process.execPath}\n${source}`, { mode: 0o700 });
}

test('AP20_pipeline_pin: systemd и detached сохраняют выбранный доступ через паузу и рестарт', async (t) => {
  for (const systemd of [true, false]) {
    await t.test(systemd ? 'systemd' : 'detached', async (t) => {
      const cleanups = [];
      let ledger;
      let f;

      t.after(async () => {
        await f?.app.close();
        await ledger?.app.close();

        for (const cleanup of cleanups) {
          await cleanup();
        }
      });
      ledger = await factoryDecisionFixture({ after: (cleanup) => cleanups.push(cleanup) }, {
        after: { state: 'stopped', sequence: 9 },
      });

      const root = path.dirname(ledger.adapter.stateDir);
      const vendor = await vendorServer(t);
      const env = { DEEPSEEK_API_KEY: OLD_KEY };

      await fs.writeFile(path.join(root, '.env'), `DEEPSEEK_API_KEY=${OLD_KEY}\n`, { mode: 0o600 });
      await fs.rename(path.join(root, 'state/t7.pipeline'), path.join(root, 'seed.pipeline'));
      await fs.mkdir(path.join(root, 'lib/runners'), { recursive: true });
      await fs.writeFile(path.join(root, 'lib/runners/deepseek.sh'), '# Исполнитель фикстуры\n');
      await fs.writeFile(path.join(root, 'profiles/demo/graph.json'), JSON.stringify({
        capabilities: [],
        default_route: 'feature',
        routes: { feature: { pos: { build: [0, 0] }, edges: [] } },
      }));
      await fs.writeFile(path.join(root, 'profiles/demo/profile.sh'), [
        'PROFILE_TRIAGE_REPOS=""',
        `profile_repositories() { printf 'demo\\t${root}/worktree\\t${root}/worktree\\n'; }`,
        '',
      ].join('\n'));
      await fs.writeFile(path.join(root, 'bin/systemctl'), '#!/bin/sh\n'
        + `if test -f '${root}/factory-capture.json'; then echo active; else echo inactive; exit 3; fi\n`,
      { mode: 0o700 });

      f = await profileFixture(t, {
        root,
        env,
        vendor,
        adapters: [...apiAdapters(env, vendor), syntheticAdapter()],
        config: {
          stateDir: ledger.adapter.stateDir,
          factoryBin: path.join(root, 'bin/factory'),
          factoryControlDir: path.join(root, 'control'),
          factoryConfigRoot: path.join(root, 'config'),
          routesDir: path.join(root, 'routes'),
          installationBin: path.join(root, 'bin'),
          profilesDir: path.join(root, 'profiles'),
          ticketsDir: path.join(root, 'tickets'),
          accessFactoryFixture: true,
        },
      });

      await executable(root, 'factory', 'factory-engine.mjs');
      await executable(root, 'systemd-run', 'factory-systemd.mjs');
      await fs.writeFile(path.join(root, 'bin/systemd.json'), JSON.stringify(systemd));

      const worker = await serverWorker(t, f);
      const boot = await worker('boot', { provider: 'deepseek' });

      assert.equal(boot.ready, true, JSON.stringify(boot));

      const launch = await worker('factory-http-launch');

      assert.equal(launch.result.status, 200, JSON.stringify(launch));
      assert.equal(launch.result.body.outcome, 'launched');
      assert.ok(launch.capture.argv.includes('start'));

      const before = await profiles(f, 'deepseek');
      const second = await addProfile(f, 'deepseek');
      const neighbor = await addProfile(f);

      assert.equal(launch.capture.env.DEEPSEEK_API_KEY, OLD_KEY);
      await activate(f, neighbor);
      await worker('factory-pause');
      await activate(f, second, 'deepseek', {}, 409);
      await worker('restart');
      await f.restart();
      await activate(f, second, 'deepseek', {}, 409);

      const resumed = await worker('factory-launch', {
        args: ['7', 'resume', '--profile', 'demo', '--attempt', 'a_0123456789abcdef0123456789abcdef'],
      });

      assert.equal(resumed.capture.env.DEEPSEEK_API_KEY, OLD_KEY);
      assert.equal((await profiles(f, 'deepseek')).activeProfileId, before.activeProfileId);
      await worker('factory-pause');

      const runtime = path.join(root, 'control/protocol-v2/tasks/t7/attempts',
        'a_0123456789abcdef0123456789abcdef/stage-results/runtime.json');

      await fs.chmod(runtime, 0o600);
      await fs.copyFile(path.join(root, 'after.json'), runtime);
      await fs.chmod(runtime, 0o400);
      await activate(f, second, 'deepseek');
      assert.equal((await profiles(f, 'deepseek')).activeProfileId, second.id);
    });
  }
});
