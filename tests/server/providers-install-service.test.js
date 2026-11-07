import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { runCommand } from '../../server/src/lib/packageInstall/runCommand.ts';
import {
  installFixture, installNpmFixture, current, start, completed, until, prepare, startWithToken,
} from './helpers/providerInstallFixture.js';

test('строки stdout и stderr остаются однократными после успеха и отказа', async (t) => {
  for (const runner of ['fixture', 'child']) {
    for (const code of [0, 1]) {
      await t.test(`${runner}, exit ${code}`, async (scenario) => {
        const stdout = 'stdout-маркер\n';
        const stderr = 'stderr-маркер\n';
        const fixture = await installFixture(scenario, {
          runner: runner === 'child' ? runCommand : undefined,
          commandResult: {
            code,
            stdout,
            stderr
          },
        });
        const release = path.join(fixture.root, 'release-output');

        if (runner === 'child') {
          fixture.descriptor.update.executable = process.execPath;
          fixture.descriptor.update.args = ['-e', `
            process.stdout.write(${JSON.stringify(stdout)});
            process.stderr.write(${JSON.stringify(stderr)});
            const timer = setInterval(() => {
              if (require('node:fs').existsSync(${JSON.stringify(release)})) {
                clearInterval(timer);
                process.exit(${code});
              }
            }, 10);
          `];
        }

        const response = await start(fixture.app);

        assert.equal(response.statusCode, 202, response.body);

        const live = await until(() => current(fixture.app), (value) =>
          value.active?.outputTail.includes(stdout) && value.active.outputTail.includes(stderr));

        for (const line of [stdout.trim(), stderr.trim()]) {
          assert.equal(live.active.outputTail.split('\n').filter((value) => value === line).length, 1);
        }

        fixture.setVersion('2.0.0');
        fixture.gate.resolve();
        await fs.writeFile(release, 'готово');

        const final = (await completed(fixture.app)).recent.claude;

        assert.equal(final.status, code === 0 ? 'succeeded' : 'failed');

        for (const line of [stdout.trim(), stderr.trim()]) {
          const count = final.outputTail.split('\n').filter((value) => value === line).length;

          assert.equal(count, 1, `Итог повторяет ${line}: ${final.outputTail}`);
        }
      });
    }
  }
});

test('один admission до первого await и lock до моделей', async (t) => {
  const { app, calls, gate, modelGate } = await installFixture(t, { holdModels: true });
  const results = await Promise.all([start(app), start(app)]);

  assert.deepEqual(results.map((entry) => entry.statusCode).sort(), [202, 409]);
  assert.equal(calls.commands.length, 1);
  gate.resolve();
  await until(() => current(app), (snapshot) => snapshot.active?.stage === 'models');

  const whileModels = await start(app);

  assert.equal(whileModels.statusCode, 409, whileModels.body);
  modelGate.resolve();
  assert.equal((await completed(app)).recent.claude.status, 'succeeded');
});

test('окно и потеря HTTP не владеют процессом', async (t) => {
  const { app, calls, gate } = await installFixture(t);
  const started = await start(app);

  assert.equal(started.statusCode, 202, started.body);

  const id = started.json().active.id;

  // После окончания start-запроса нет ни одного открытого клиента, runner ещё удержан.
  assert.equal(calls.commands[0].options.signal?.aborted, false);
  assert.equal((await current(app)).active.id, id);
  calls.commands[0].options.onStdout?.('\u001b[31m' + 'x'.repeat(40_000) + '\u0000\n');

  const lines = Array.from({ length: 250 }, (_, index) => `строка ${index}`).join('\n');

  calls.commands[0].options.onStderr?.(lines);

  const progress = await until(() => current(app), (snapshot) =>
    snapshot.active?.outputTail.includes('строка 249'));

  assert.ok(Buffer.byteLength(progress.active.outputTail) <= 32 * 1024);
  assert.ok(progress.active.outputTail.split('\n').length <= 200);
  assert.doesNotMatch(progress.active.outputTail, /[\u0000\u001b]/u);
  gate.resolve();

  const final = await completed(app);

  assert.equal(final.recent.claude.id, id);
  assert.equal(final.recent.claude.status, 'succeeded');

  const stages = calls.events.filter((entry) => entry.event === 'provider-install')
    .map((entry) => entry.data.active?.stage).filter(Boolean);

  for (const stage of ['download-install', 'version', 'models']) {
    assert.ok(stages.includes(stage), `Не опубликована фаза ${stage}`);
  }

  final.recent.claude.outputTail = 'испорченная копия';
  assert.notEqual((await current(app)).recent.claude.outputTail, final.recent.claude.outputTail);
});

test('версионные исходы и ошибка команды сильнее changed', async (t) => {
  const cases = [
    {
      name: 'install',
      installed: false,
      after: '2.0.0',
      outcome: 'installed'
    },
    {
      name: 'update',
      after: '2.0.0',
      outcome: 'updated'
    },
    {
      name: 'current',
      before: '2.0.0',
      after: '2.0.0',
      outcome: 'current'
    },
    {
      name: 'nonzero',
      result: {
      code: 1,
      stderr: 'EACCES'
    },
      failed: /EACCES/u
    },
    {
      name: 'ENOENT',
      result: {
      code: 127,
      stderr: 'ENOENT npm'
    },
      failed: /ENOENT|npm/u
    },
    {
      name: 'timeout',
      result: {
      timedOut: true,
      code: null
    },
      failed: /срок|тайм|timeout/iu
    },
    {
      name: 'probe',
      probe: {
      ok: false,
      version: '2.0.0'
    },
      failed: /верси|провер|probe/iu
    },
    {
      name: 'unparsed',
      probe: {
      ok: true,
      version: 'не версия'
    },
      failed: /верси|version/iu
    },
    {
      name: 'stale',
      before: '1.0.0',
      after: '1.0.0',
      latest: '2.0.0',
      failed: /обнов|копи|stale|updat/iu
    },
    {
      name: 'unknown-latest',
      after: '1.0.0',
      latest: null,
      outcome: 'current'
    },
    {
      name: 'models-warning',
      after: '2.0.0',
      modelsError: true,
      outcome: 'updated'
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async (scenario) => {
      const fixture = await installFixture(scenario, {
        ...entry,
        commandResult: entry.result,
        probeAfter: entry.probe
      });

      if ('latest' in entry) {
        fixture.setLatest(entry.latest);
      }

      await fixture.app.inject({
        method: 'POST',
        url: '/api/providers/check-updates'
      });

      const operation = entry.installed === false ? 'install' : 'update';
      const response = await start(fixture.app, 'claude', operation);

      assert.equal(response.statusCode, 202, response.body);

      fixture.gate.resolve();

      const job = (await completed(fixture.app)).recent.claude;

      if (entry.failed) {
        assert.equal(job.status, 'failed');
        assert.match(JSON.stringify(job.error), entry.failed);
      } else {
        assert.equal(job.status, 'succeeded');
        assert.equal(job.outcome, entry.outcome);
      }
      if (entry.modelsError) {
        assert.equal(job.warnings.length, 1, 'Сбой моделей должен дать одно предупреждение при успехе CLI');
      }
    });
  }
});

test('перезапуск сохраняет interrupted и не трогает чужой PID', async (t) => {
  const fixture = await installFixture(t);
  const started = await start(fixture.app);

  assert.equal(started.statusCode, 202, started.body);
  fixture.gate.resolve();
  await completed(fixture.app);
  await fixture.app.close();

  const recovered = await installFixture(t, {
    config: { providerInstallStatePath: fixture.config.providerInstallStatePath },
  });
  const snapshot = await current(recovered.app);

  assert.equal(snapshot.recent.claude.id, started.json().active.id);
  assert.equal(recovered.calls.commands.length, 0, 'Recovery повторил установку');

  await t.test('собственный server child теряет supervisor и восстанавливает interrupted', async () => {
    const statePath = path.join(fixture.root, 'child-state.json');
    const heartbeat = path.join(fixture.root, 'heartbeat');
    const childScript = `
      import { installFixture, start } from ${JSON.stringify(new URL('./helpers/providerInstallFixture.js',
    import.meta.url).href)};
      import { runCommand } from ${JSON.stringify(new URL('../../server/src/lib/packageInstall/runCommand.ts',
    import.meta.url).href)};
      const f = await installFixture({ after() {} }, {
        config: { providerInstallStatePath: ${JSON.stringify(statePath)} },
        runner: runCommand,
      });
      const script = 'setInterval(() => require("node:fs").appendFileSync('
        + ${JSON.stringify(JSON.stringify(heartbeat))} + ', "x"), 20)';
      f.descriptor.update.executable = process.execPath;
      f.descriptor.update.args = ['-e', script];
      const response = await start(f.app);
      process.send({ status: response.statusCode, body: response.json(), root: f.root });
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', childScript], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let childRoot;

    t.after(async () => {
      child.kill('SIGKILL');

      if (childRoot) {
        await fs.rm(childRoot, {
          recursive: true,
          force: true
        });
      }
    });

    const [message] = await once(child, 'message', { signal: AbortSignal.timeout(5000) });

    childRoot = message.root;
    assert.equal(message.status, 202);
    await until(() => fs.readFile(heartbeat, 'utf8').catch(() => ''), Boolean);

    const runningState = JSON.parse(await fs.readFile(statePath, 'utf8'));

    child.kill('SIGKILL');
    await once(child, 'exit');

    const next = await installFixture(t, { config: { providerInstallStatePath: statePath } });
    const interrupted = await current(next.app);

    assert.equal(interrupted.active, null);
    assert.equal(interrupted.recent.claude.status, 'interrupted');
    assert.equal(next.calls.commands.length, 0);

    const before = await fs.readFile(heartbeat, 'utf8');

    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(await fs.readFile(heartbeat, 'utf8'), before, 'Старый writer продолжает писать');

    const foreign = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });

    t.after(() => foreign.kill('SIGKILL'));
    await once(foreign, 'spawn');

    let replaced = 0;

    /**
     * Сохраняется настоящий формат private state, изменяется только identity worker.
     * Чужой процесс принадлежит этому тесту, но ownership у него заведомо не совпадает.
     */
    function replaceIdentity(value) {
      if (!value || typeof value !== 'object') {
        return;
      }
      if ('supervisorPid' in value && 'supervisorStartTime' in value) {
        value.supervisorPid = foreign.pid;
        value.supervisorStartTime = '0';
        value.pid = foreign.pid;
        value.startTime = '0';
        replaced += 1;
      }

      for (const nested of Object.values(value)) {
        replaceIdentity(nested);
      }
    }

    replaceIdentity(runningState);
    assert.ok(replaced > 0, 'Не сохранена identity собственного реального worker');

    const foreignStatePath = path.join(fixture.root, 'foreign-state.json');

    await fs.writeFile(foreignStatePath, JSON.stringify(runningState));

    const guarded = await installFixture(t, { config: { providerInstallStatePath: foreignStatePath } });
    const guardedSnapshot = await current(guarded.app);

    assert.equal(guardedSnapshot.active, null);
    assert.equal(guardedSnapshot.recent.claude.status, 'interrupted');
    assert.ok(guardedSnapshot.blockedReason);
    assert.equal(foreign.exitCode, null, 'Recovery остановил процесс с несовпавшей identity');
    assert.equal((await start(guarded.app)).statusCode, 409);
    assert.equal(guarded.calls.commands.length, 0);
  });
});

test('новый native каталог доступен configured probe без перезапуска', async (t) => {
  const fixture = await installFixture(t, { installed: false });
  const nativeDir = path.join(fixture.root, 'new-native-bin');

  fixture.config.claudeBin = 'fixture';
  fixture.provider.bin = (config) => config.claudeBin;

  const originalBin = fixture.provider.bin(fixture.config);

  fixture.descriptor.nativeBinDirs = [nativeDir];
  fixture.provider.probe = async (config) => {
    assert.equal(config, fixture.config, 'Probe получил другую конфигурацию');

    const found = fixture.env.PATH.split(path.delimiter).includes(nativeDir)
      && await fs.access(path.join(nativeDir, 'fixture')).then(() => true, () => false);

    return {
      ok: found,
      version: found ? '2.0.0' : ''
    };
  };

  const response = await start(fixture.app, 'claude', 'install');

  assert.equal(response.statusCode, 202, response.body);
  await fs.mkdir(nativeDir);
  await fs.writeFile(path.join(nativeDir, 'fixture'), 'собственный executable', { mode: 0o755 });
  fixture.gate.resolve();

  const snapshot = await completed(fixture.app);

  assert.equal(snapshot.recent.claude.status, 'succeeded');
  assert.equal(fixture.provider.bin(fixture.config), originalBin, 'Явный bin был переписан');
  assert.ok(fixture.env.PATH.split(path.delimiter).includes(nativeDir));
});


// Выбор npm относится к тому же сценарию configured CLI и окружения сервера.
// Его варианты не обращаются к npm владельца и не создают настоящую поставку.
test('новый native каталог: npm выбирается из пользовательского PATH вне packaged runtime', async (t) => {
  for (const mode of ['source', 'packaged', 'packaged-only']) {
    await t.test(mode, async (scenario) => {
      const runtimePaths = {
        kind: mode === 'source' ? 'source' : 'packaged',
        node: ''
      };
      const fixture = await installFixture(scenario, {
        installed: false,
        providerInstall: { runtimePaths },
      });
      const bundled = path.join(fixture.root, 'runtime', 'node', 'bin');
      const user = path.join(fixture.root, 'user-bin');

      await fs.mkdir(bundled, { recursive: true });
      await fs.mkdir(user);

      for (const directory of [bundled, user]) {
        await fs.writeFile(path.join(directory, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      }

      runtimePaths.node = path.join(bundled, 'node');
      fixture.env.PATH = ['relative-bin', bundled, ...(mode === 'packaged-only' ? [] : [user])]
        .join(path.delimiter);
      fixture.descriptor.install.executable = 'npm';
      fixture.descriptor.install.args = ['i', '-g', '@fixture/never-installed'];

      const response = await start(fixture.app, 'claude', 'install');

      assert.equal(response.statusCode, 202, response.body);
      fixture.gate.resolve();

      const job = (await completed(fixture.app)).recent.claude;

      if (mode === 'packaged-only') {
        assert.equal(job.status, 'failed');
        assert.match(JSON.stringify(job.error), /npm/u);
        assert.equal(fixture.calls.commands.length, 0);
      } else {
        assert.equal(job.status, 'succeeded');
        assert.equal(fixture.calls.commands[0].bin,
          path.join(mode === 'source' ? bundled : user, 'npm'));
      }

      assert.equal(fixture.env.PATH.startsWith('relative-bin'), true, 'Общий порядок PATH переписан');
    });
  }
});

/**
 * Core commit предшествует настройке Bash: отказ `.env` не оставляет записанного
 * rc, а отказ writer-а после commit сохраняет новую рабочую привязку и needs_setup.
 */
test('отказ .env до commit сохраняет прежнюю привязку и не пишет shell', async (t) => {
  const fixture = await installNpmFixture(t, { installed: true });
  const bashrc = path.join(fixture.root, '.bashrc');
  const before = await fs.readFile(bashrc, 'utf8');

  await fs.rm(fixture.config.envPath);
  await fs.mkdir(fixture.config.envPath);

  const preparation = (await prepare(fixture.app, 'claude', 'update')).json();
  const started = await startWithToken(fixture.app, preparation.token, 'claude', 'update');

  assert.equal(started.statusCode, 202, started.body);
  fixture.gate.resolve();

  const job = (await completed(fixture.app)).recent.claude;

  assert.equal(job.status, 'failed');
  assert.equal(job.error.code, 'npm_binding_failed');
  assert.equal(fixture.config.claudeBin, '/fixture/configured-cli');
  assert.equal(await fs.readFile(bashrc, 'utf8'), before, 'rc записан до commit');
});

test('отказ настройки shell после commit сохраняет новую привязку и needs_setup', async (t) => {
  const fixture = await installNpmFixture(t, { installed: true });
  const dotfiles = path.join(fixture.root, 'dotfiles-profile');

  await fs.writeFile(dotfiles,
    'source "$HOME/.bashrc"\n# ссылка на dotfiles\nexport FROM_DOTFILES=1\n');
  await fs.rm(path.join(fixture.root, '.bash_profile'));
  await fs.symlink(dotfiles, path.join(fixture.root, '.bash_profile'));

  const preparation = (await prepare(fixture.app, 'claude', 'update')).json();

  assert.equal(preparation.terminalSetup, 'manual');
  assert.deepEqual(preparation.shellChanges, []);

  const started = await startWithToken(fixture.app, preparation.token, 'claude', 'update');

  assert.equal(started.statusCode, 202, started.body);
  fixture.gate.resolve();

  const job = (await completed(fixture.app)).recent.claude;

  assert.equal(job.status, 'succeeded', JSON.stringify(job.error));
  assert.equal(job.terminal.status, 'needs_setup');
  assert.equal(job.terminal.reason, 'shell_rc_symlink');
  assert.equal(fixture.config.claudeBin, fixture.npmBinary);
  assert.ok(job.warnings.some((warning) => warning.code === 'terminal_setup_required'));
  assert.equal(await fs.readFile(dotfiles, 'utf8'),
    'source "$HOME/.bashrc"\n# ссылка на dotfiles\nexport FROM_DOTFILES=1\n');
});
