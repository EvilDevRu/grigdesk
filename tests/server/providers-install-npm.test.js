import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import claude from '../../server/src/lib/executors/claude.ts';
import codex from '../../server/src/lib/executors/codex.ts';
import kimi from '../../server/src/lib/executors/kimi.ts';
import { installFixture, start, completed } from './helpers/providerInstallFixture.js';

const packages = new Map([
  [claude, '@anthropic-ai/claude-code'],
  [codex, '@openai/codex'],
  [kimi, '@moonshot-ai/kimi-code'],
]);

/**
 * Настоящий адаптер объявляет команды, а probe и runner остаются офлайн-фикстурой.
 * Ни один сценарий не устанавливает пакеты и не запускает CLI владельца машины.
 */
async function npmFixture(t, adapter, operation, mode) {
  const runtimePaths = { kind: 'packaged', node: '' };
  const fixture = await installFixture(t, {
    installed: operation === 'update',
    providerInstall: { runtimePaths },
  });
  const bundled = path.join(fixture.root, 'runtime', 'bin');
  const user = path.join(fixture.root, 'user-bin');

  await fs.mkdir(bundled, { recursive: true });
  await fs.mkdir(user);
  await fs.writeFile(path.join(bundled, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  if (mode === 'user') {
    await fs.writeFile(path.join(user, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  } else if (mode === 'not-executable') {
    await fs.writeFile(path.join(user, 'npm'), 'нет права запуска', { mode: 0o644 });
  } else if (mode === 'directory') {
    await fs.mkdir(path.join(user, 'npm'));
  }

  runtimePaths.node = path.join(bundled, 'node');
  fixture.env.PATH = ['relative-bin', bundled, user].join(path.delimiter);
  fixture.config[`${adapter.id}Bin`] = '/fixture/configured-cli';
  fixture.provider.installation = adapter.installation;

  return { ...fixture, npm: path.join(user, 'npm') };
}

test('npm имеет приоритет у трёх CLI: карточка и выполняемая команда совпадают', async (t) => {
  for (const [adapter, packageId] of packages) {
    for (const operation of ['install', 'update']) {
      await t.test(`${adapter.id}: ${operation}`, async (scenario) => {
        const fixture = await npmFixture(scenario, adapter, operation, 'user');
        const command = `npm i -g ${packageId}@latest`;
        const response = await fixture.app.inject({ url: '/api/providers?refresh=1' });

        assert.equal(response.statusCode, 200, response.body);
        assert.equal(response.json().providers[0].installation[`${operation}Command`], command);

        const started = await start(fixture.app, 'claude', operation);

        assert.equal(started.statusCode, 202, started.body);
        assert.equal(started.json().active.command, command);
        fixture.gate.resolve();

        const job = (await completed(fixture.app)).recent.claude;

        assert.equal(job.status, 'succeeded');
        assert.equal(fixture.calls.commands[0].bin, fixture.npm);
        assert.deepEqual(fixture.calls.commands[0].args, ['i', '-g', `${packageId}@latest`]);
        assert.equal(fixture.config[`${adapter.id}Bin`], '/fixture/configured-cli');
      });
    }
  }
});

test('без пользовательского npm сохраняются прежние команды установки и обновления', async (t) => {
  for (const adapter of packages.keys()) {
    for (const operation of ['install', 'update']) {
      for (const mode of ['missing', 'not-executable', 'directory']) {
        await t.test(`${adapter.id}: ${operation}, ${mode}`, async (scenario) => {
          const fixture = await npmFixture(scenario, adapter, operation, mode);
          const previous = adapter.installation(fixture.config)[operation];
          const response = await fixture.app.inject({ url: '/api/providers?refresh=1' });

          assert.equal(response.statusCode, 200, response.body);
          assert.equal(response.json().providers[0].installation[`${operation}Command`], previous.command);

          const started = await start(fixture.app, 'claude', operation);

          assert.equal(started.statusCode, 202, started.body);
          assert.equal(started.json().active.command, previous.command);
          fixture.gate.resolve();

          const job = (await completed(fixture.app)).recent.claude;

          if (previous.executable === 'npm') {
            assert.equal(job.error.code, 'npm_missing');
            assert.equal(fixture.calls.commands.length, 0);
          } else {
            assert.equal(job.status, 'succeeded');
            assert.equal(fixture.calls.commands[0].bin, previous.executable);
            assert.deepEqual(fixture.calls.commands[0].args, previous.args);
          }
        });
      }
    }
  }
});

test('npm не разрешает обновление contained Kimi', async (t) => {
  const fixture = await npmFixture(t, kimi, 'update', 'user');

  fixture.config.kimiLaunchMode = 'contained';

  const response = await start(fixture.app);

  assert.equal(response.statusCode, 400, response.body);
  assert.equal(fixture.calls.commands.length, 0);
});

test('старт повторно проверяет npm после чтения карточки', async (t) => {
  for (const available of [false, true]) {
    await t.test(available ? 'npm исчез' : 'npm появился', async (scenario) => {
      const fixture = await npmFixture(scenario, kimi, 'update', available ? 'user' : 'missing');
      const response = await fixture.app.inject({ url: '/api/providers?refresh=1' });
      const previous = response.json().providers[0].installation.updateCommand;

      if (available) {
        await fs.unlink(fixture.npm);
      } else {
        await fs.writeFile(fixture.npm, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      }

      const started = await start(fixture.app);

      assert.equal(started.statusCode, 202, started.body);
      assert.notEqual(started.json().active.command, previous);
      fixture.gate.resolve();

      const job = (await completed(fixture.app)).recent.claude;

      assert.equal(job.status, 'succeeded');
      assert.equal(fixture.calls.commands[0].bin, available ? '/bin/bash' : fixture.npm);
    });
  }
});
