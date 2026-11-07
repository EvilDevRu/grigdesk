import assert from 'node:assert/strict';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { readFile, access } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  installFixture, installNpmFixture, current, start, completed, until, cookie,
  prepare, startWithToken,
} from './helpers/providerInstallFixture.js';

test('реестр после удаления npm сохраняет обычные действия оставшейся native-копии', async (t) => {
  const fixture = await installNpmFixture(t);
  const nativeRoot = path.join(fixture.root, 'native');
  const native = path.join(nativeRoot, fixture.binName);
  const packageRoot = path.join(fixture.prefix, 'lib/node_modules', fixture.packageId);
  const alias = path.join(fixture.prefix, 'bin', fixture.binName);
  const definition = {
    packageId: fixture.packageId,
    binName: fixture.binName,
    configKey: 'claudeBin',
    envKey: 'GRIGDESK_CLAUDE_BIN',
    native: [{ entry: native, root: nativeRoot }],
  };

  fixture.provider.externalCli = () => definition;
  fixture.provider.bin = (config) => config.claudeBin;
  fixture.config.claudeBin = fixture.binName;
  await fs.mkdir(nativeRoot, { recursive: true });
  await fs.writeFile(native, Buffer.from([0x7f, 0x45, 0x4c, 0x46]), { mode: 0o755 });
  await fs.mkdir(packageRoot, { recursive: true });
  await fs.mkdir(path.dirname(alias), { recursive: true });
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: fixture.packageId,
    version: '1.0.0',
    bin: { [fixture.binName]: 'cli.js' },
  }));
  await fs.writeFile(path.join(packageRoot, 'cli.js'), '#!/bin/sh\necho 1.0.0\n', { mode: 0o755 });
  await fs.symlink(path.join(packageRoot, 'cli.js'), alias);
  await fs.writeFile(path.join(fixture.root, '.bashrc'),
    `export PATH="${fixture.prefix}/bin:${nativeRoot}:${path.dirname(fixture.npm)}:/usr/bin:/bin"\n`);

  const installed = (await fixture.app.inject('/api/providers')).json().providers[0];

  assert.equal(installed.canUpdate, true);
  assert.equal(installed.installation.canUpdate, true);
  assert.equal(installed.installation.canUninstall, true);
  assert.equal(installed.installation.manualInstallCommand, undefined);

  await fs.unlink(alias);
  await fs.rm(packageRoot, { recursive: true });

  const remaining = (await fixture.app.inject('/api/providers?refresh=1')).json().providers[0];

  assert.equal(remaining.installed, true);
  assert.equal(remaining.canUpdate, true);
  assert.equal(remaining.installation.canUpdate, true);
  assert.equal(remaining.installation.canInstall, false);
  assert.equal(remaining.installation.canUninstall, true);
  assert.equal(remaining.installation.canReinstall, true);
  assert.equal(remaining.installation.manualInstallCommand, undefined);
  assert.equal(remaining.installation.inventory.installations[0].source, 'native');

  fixture.setInstalled(false);

  const broken = (await fixture.app.inject('/api/providers?refresh=1')).json().providers[0];

  assert.equal(broken.installation.canInstall, false);
  assert.equal(broken.installation.manualInstallCommand, undefined);

  await fs.unlink(native);

  const missing = (await fixture.app.inject('/api/providers?refresh=1')).json().providers[0];

  assert.equal(missing.installed, false);
  assert.equal(missing.installation.canInstall, true);
  assert.equal(missing.installation.manualInstallCommand, undefined);
});

/**
 * Настоящие routes и discovery работают с ELF-маркером в изолированном HOME.
 * Installer и version probe подменены на границе worker, без сети и auth владельца.
 */
async function nativeFixture(t) {
  let native;
  let version = '1.0.0';
  const commands = [];
  const fixture = await installFixture(t, {
    /**
     * Транспорт различает чтение версии и запуск объявленного installer.
     * Только запуск меняет искусственную программу и публикует прогресс.
     */
    async runner(file, args, options) {
      if (file !== native) {
        commands.push({ file, args });
        version = '2.0.0';
        await fs.writeFile(native, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2]), { mode: 0o755 });
        options.onStdout?.('fixture installer\n');
      }

      return {
        code: 0,
        signal: null,
        timedOut: false,
        aborted: false,
        stdout: file === native ? version : 'fixture installer',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        workspaceLimitExceeded: false,
      };
    },
  });
  const root = path.join(fixture.root, '.kimi-code/bin');

  native = path.join(root, 'fixture');
  fixture.provider.bin = (config) => config.claudeBin;
  fixture.provider.externalCli = () => ({
    packageId: '@fixture/cli',
    binName: 'fixture',
    configKey: 'claudeBin',
    envKey: 'GRIGDESK_CLAUDE_BIN',
    native: [{ entry: native, root }],
  });
  fixture.provider.probe = async () => ({
    ok: await fs.lstat(native).then(() => true, () => false),
    version,
  });
  fixture.env.SHELL = '/bin/bash';
  fixture.config.claudeBin = native;
  fixture.config.envPath = path.join(fixture.root, '.env');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await fs.writeFile(native, Buffer.from([0x7f, 0x45, 0x4c, 0x46]), { mode: 0o755 });
  await fs.writeFile(fixture.config.envPath, `GRIGDESK_CLAUDE_BIN=${native}\n`);
  await fs.writeFile(path.join(fixture.root, '.bashrc'), `export PATH="${root}:/usr/bin:/bin"\n`);
  await fs.writeFile(path.join(fixture.root, '.bash_profile'), 'source "$HOME/.bashrc"\n');

  return {
    ...fixture,
    root,
    native,
    commands,
  };
}

test('native v2 update использует официальный installer, а uninstall сохраняет auth', async (t) => {
  const fixture = await nativeFixture(t);
  const auth = path.join(path.dirname(fixture.root), 'credentials.json');
  const route = '/api/providers/installations/v2/claude';

  await fs.writeFile(auth, 'fixture credentials');
  await fs.chmod(fixture.root, 0o775);

  for (const operation of ['update', 'uninstall']) {
    const prepared = await fixture.app.inject({
      method: 'POST',
      url: `${route}/${operation}/prepare`,
      payload: {},
    });

    assert.equal(prepared.statusCode, 200, prepared.body);
    assert.equal(prepared.json().method, 'native');
    assert.equal(fixture.commands.length, operation === 'update' ? 0 : 1);

    const started = await fixture.app.inject({
      method: 'POST',
      url: `${route}/${operation}/start`,
      payload: { preparationToken: prepared.json().token },
    });

    assert.equal(started.statusCode, 202, started.body);

    const finished = await until(async () =>
      (await fixture.app.inject('/api/providers/installations/v2/current')).json(),
    (snapshot) => snapshot.recent.claude?.operation === operation && !snapshot.active);

    assert.equal(finished.recent.claude.status, 'succeeded');
    assert.equal(await fs.readFile(auth, 'utf8'), 'fixture credentials');
  }

  assert.equal(fixture.commands.length, 1);
  assert.deepEqual(fixture.commands[0].args, fixture.descriptor.install.args);
  assert.equal(fixture.config.claudeBin, 'fixture');
  assert.equal(await fs.lstat(fixture.root).then(() => true, () => false), false);
});

test('native HTTP prepare возвращает причину отказа по правам с проблемным путём', async (t) => {
  const fixture = await nativeFixture(t);

  await fs.chmod(fixture.root, 0o777);

  const response = await fixture.app.inject({
    method: 'POST',
    url: '/api/providers/installations/v2/claude/uninstall/prepare',
    payload: {},
  });

  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().error, 'native_ownership_unverified');
  assert.ok(response.json().message.includes(fixture.root));
  assert.doesNotMatch(response.json().message, /Имя команды занято/u);
  assert.equal(fixture.commands.length, 0);
});

test('прежний POST update продолжает обслуживать native-копию', async (t) => {
  const fixture = await nativeFixture(t);
  const response = await fixture.app.inject({
    method: 'POST',
    url: '/api/providers/claude/update',
    payload: {},
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().ok, true);
  assert.equal(response.json().after, '2.0.0');
  assert.equal(fixture.commands.length, 1);
});

test('start отвечает 202 до окончания и GET возвращает тот же job', async (t) => {
  const { app, config, gate, calls } = await installFixture(t);
  const response = await start(app);

  assert.equal(response.statusCode, 202, response.body);

  const snapshot = response.json();
  const saved = JSON.parse(await readFile(config.providerInstallStatePath, 'utf8'));

  assert.equal(snapshot.active.status, 'running');
  assert.equal(saved.active.id, snapshot.active.id, 'ACK предшествовал durable running');
  assert.equal((await current(app)).active.id, snapshot.active.id);
  assert.equal(calls.commands.length, 1);
  gate.resolve();
  assert.equal((await completed(app)).recent.claude.id, snapshot.active.id);
});

test('два клиента и legacy update разделяют lock', async (t) => {
  const { app, gate, calls } = await installFixture(t);
  const first = await start(app);

  assert.equal(first.statusCode, 202, first.body);

  for (const url of ['/api/providers/claude/update/start', '/api/providers/claude/update']) {
    const second = await app.inject({
      method: 'POST',
      url
    });

    assert.equal(second.statusCode, 409, second.body);
  }

  assert.equal(calls.commands.length, 1);
  gate.resolve();
  await completed(app);

  const legacy = await app.inject({
    method: 'POST',
    url: '/api/providers/claude/update'
  });

  assert.equal(legacy.statusCode, 200, legacy.body);
  assert.deepEqual(legacy.json(), {
    ok: true,
    before: '2.0.0',
    after: '2.0.0',
    changed: false,
    output: 'готово',
  });
  assert.equal(calls.commands.length, 2);
});

test('auth отвергает до adapters/models/runner', async (t) => {
  const { app, calls } = await installFixture(t, { auth: true });

  for (const url of [
    '/api/providers/installations/current',
    '/api/providers/claude/install/start',
    '/api/providers/claude/update/start',
  ]) {
    const result = await app.inject({
      method: url.endsWith('current') ? 'GET' : 'POST',
      url
    });

    assert.equal(result.statusCode, 401, result.body);
  }

  assert.equal(calls.adapters, 0);
  assert.equal(calls.models.length, 0);
  assert.equal(calls.commands.length, 0);

  const allowed = await app.inject({
    url: '/api/providers/installations/current',
    headers: { cookie }
  });

  assert.equal(allowed.statusCode, 200, allowed.body);
});

test('команда из body не исполняется', async (t) => {
  const { app, calls, marker } = await installFixture(t);
  const response = await start(app, 'claude', 'update', { command: 'маркер' });

  assert.equal(response.statusCode, 400, response.body);
  assert.equal(calls.commands.length, 0);
  assert.equal((await current(app)).active, null);
  await assert.rejects(access(marker), { code: 'ENOENT' });
});

test('start отвергает любые поля тела до допуска команды', async (t) => {
  for (const operation of ['install', 'update']) {
    await t.test(operation, async (scenario) => {
      const { app, calls, gate } = await installFixture(scenario, { installed: operation === 'update' });

      for (const payload of [
        { command: 'маркер' }, { argv: [] }, { env: { PATH: '/fixture' } }, { cwd: '/fixture' },
      ]) {
        const result = await start(app, 'claude', operation, payload);

        assert.equal(result.statusCode, 400, `${JSON.stringify(payload)}: ${result.body}`);
        assert.equal(calls.commands.length, 0);
        assert.equal((await current(app)).active, null);
      }

      const empty = await start(app, 'claude', operation, {});

      assert.equal(empty.statusCode, 202, empty.body);
      gate.resolve();
      await completed(app);

      if (operation === 'install') {
        const repeated = await start(app, 'claude', operation);

        assert.equal(repeated.statusCode, 409, 'Install не обходит запрет обновления');
      }

      const withoutBody = await installFixture(scenario, { installed: operation === 'update' });
      const absent = await start(withoutBody.app, 'claude', operation);

      assert.equal(absent.statusCode, 202, absent.body);
      withoutBody.gate.resolve();
    });
  }
});

test('managed и contained update отказаны до spawn', async (t) => {
  const fixture = await installFixture(t);

  for (const id of ['deepseek', 'glm']) {
    fixture.adapters.set(id, {
      ...fixture.provider,
      id,
      distribution: () => ({
        kind: 'binary',
        managed: true,
        label: 'Поставка'
      }),
    });

    for (const operation of ['install', 'update']) {
      const response = await start(fixture.app, id, operation);

      assert.equal(response.statusCode, 400, response.body);
    }
  }

  fixture.adapters.set('kimi', {
    ...fixture.provider,
    id: 'kimi',
    installation: () => ({
      ...fixture.descriptor,
      update: null
    }),
  });

  const contained = await start(fixture.app, 'kimi');
  const installed = await start(fixture.app, 'kimi', 'install');
  const unknown = await start(fixture.app, 'missing');

  assert.equal(contained.statusCode, 400, contained.body);
  assert.equal(installed.statusCode, 409, installed.body);
  assert.equal(unknown.statusCode, 404, unknown.body);
  assert.equal(fixture.calls.commands.length, 0);
});

test('progress не перечитывает реестр', async (t) => {
  const { app, calls, gate } = await installFixture(t);
  const response = await start(app);

  assert.equal(response.statusCode, 202, response.body);
  await until(() => calls.commands.length, (length) => length === 1);

  const models = calls.models.length;
  const registryEvents = calls.events.filter((entry) => entry.event === 'providers-update').length;
  const runOptions = calls.commands[0].options;

  for (let index = 0; index < 40; index += 1) {
    runOptions.onStdout?.(`строка ${index}\n`);
  }

  await until(() => calls.events, (events) => events.some((entry) =>
    entry.event === 'provider-install' && entry.data.active?.outputTail.includes('строка 39')));
  assert.equal(calls.models.length, models);
  assert.equal(calls.events.filter((entry) => entry.event === 'providers-update').length, registryEvents);
  gate.resolve();
  await completed(app);

  const snapshots = calls.events.filter((entry) => entry.event === 'provider-install');

  assert.ok(snapshots.length < 40, 'Поток не объединяется перед публикацией');
  assert.ok(snapshots.every((entry, index) => index === 0
    || entry.data.revision > snapshots[index - 1].data.revision));
  assert.doesNotMatch(JSON.stringify(snapshots), /"(?:env|pid|worker|credential)":/u);
});

/**
 * Подготовка ничего не устанавливает и не пишет shell: тест сравнивает байты
 * файла настройки до и после и убеждается, что команда не запускалась.
 */
test('prepare возвращает reviewable DTO, но не запускает npm и не пишет shell', async (t) => {
  const fixture = await installNpmFixture(t, { installed: true });
  const bashrc = path.join(fixture.root, '.bashrc');
  const before = await readFile(bashrc, 'utf8');

  const response = await prepare(fixture.app, 'claude', 'update');

  assert.equal(response.statusCode, 200, response.body);

  const preparation = response.json();
  const { isProviderInstallPreparation } = await import(
    '../../shared/chat/providerInstallContracts.ts');

  assert.equal(isProviderInstallPreparation(preparation), true);
  assert.equal(preparation.prefix, fixture.prefix);
  assert.equal(preparation.terminalSetup, 'bash');
  assert.ok(preparation.command.includes(`--prefix ${fixture.prefix}`));
  assert.deepEqual(preparation.shellChanges.map((change) => path.basename(change.file)),
    ['.bashrc', '.bash_profile']);
  assert.ok(preparation.shellChanges.every((change) => change.block.includes(fixture.prefix)));
  assert.equal(fixture.calls.commands.length, 0, 'prepare запустил команду');
  assert.equal(await readFile(bashrc, 'utf8'), before, 'prepare изменил shell rc');
});

test('token связывает preview со стартом, а чужой token отвергается', async (t) => {
  const fixture = await installNpmFixture(t, { installed: true });
  const preparation = (await prepare(fixture.app, 'claude', 'update')).json();
  const forged = await startWithToken(fixture.app, 'forged-token', 'claude', 'update');

  assert.equal(forged.statusCode, 409, forged.body);
  assert.equal(forged.json().error, 'preparation_invalid');
  assert.equal(fixture.calls.commands.length, 0);

  const started = await startWithToken(fixture.app, preparation.token, 'claude', 'update');

  assert.equal(started.statusCode, 202, started.body);
  assert.equal(started.json().active.command, preparation.command);
  fixture.gate.resolve();

  const job = (await completed(fixture.app)).recent.claude;

  assert.equal(job.status, 'succeeded');
  assert.equal(job.terminal.status, 'ready', JSON.stringify(job.terminal));
  assert.equal(job.terminal.binDirectory, path.join(fixture.prefix, 'bin'));
  assert.equal(fixture.config.claudeBin, fixture.npmBinary);
  assert.equal((await readFile(fixture.config.envPath, 'utf8')).includes(fixture.npmBinary), true);
});

test('истёкшая подготовка требует нового preview', async (t) => {
  const fixture = await installNpmFixture(t, {
    installed: true,
    providerInstall: { preparationTtlMs: 1 },
  });
  const preparation = (await prepare(fixture.app, 'claude', 'update')).json();

  await new Promise((resolve) => setTimeout(resolve, 10));

  const started = await startWithToken(fixture.app, preparation.token, 'claude', 'update');

  assert.equal(started.statusCode, 409, started.body);
  assert.equal(started.json().error, 'preparation_expired');
  assert.equal(fixture.calls.commands.length, 0);
});

test('один token запускает не более одного job', async (t) => {
  const fixture = await installNpmFixture(t, { installed: true });
  const preparation = (await prepare(fixture.app, 'claude', 'update')).json();
  const first = await startWithToken(fixture.app, preparation.token, 'claude', 'update');

  assert.equal(first.statusCode, 202, first.body);
  fixture.gate.resolve();
  await completed(fixture.app);

  const second = await startWithToken(fixture.app, preparation.token, 'claude', 'update');

  assert.equal(second.statusCode, 409, second.body);
  assert.equal(second.json().error, 'preparation_consumed');
  assert.equal(fixture.calls.commands.length, 1);
});

test('token не принимается для другой учётной записи', async (t) => {
  const fixture = await installNpmFixture(t, {
    installed: true,
    auth: true,
    sessions: ['provider-install-fixture', 'second-account'],
  });
  const preparation = (await prepare(fixture.app, 'claude', 'update',
    { cookie })).json();
  const started = await startWithToken(fixture.app, preparation.token, 'claude', 'update',
    { cookie: 'grigdesk_sid=second-account' });

  assert.equal(started.statusCode, 409, started.body);
  assert.equal(started.json().error, 'preparation_invalid');
  assert.equal(fixture.calls.commands.length, 0);
});

test('token другого исполнителя не запускает установку', async (t) => {
  const fixture = await installFixture(t, { installed: false });
  const second = {
    ...fixture.provider,
    id: 'codex',
    name: 'Второй исполнитель',
    installation: () => structuredClone(fixture.descriptor),
  };

  fixture.adapters.set('codex', second);

  const preparation = (await prepare(fixture.app, 'claude', 'install')).json();
  const started = await startWithToken(fixture.app, preparation.token, 'codex', 'install');

  assert.equal(started.statusCode, 409, started.body);
  assert.equal(started.json().error, 'preparation_invalid');
  assert.equal(fixture.calls.commands.length, 0);
});

test('изменение shell rc между prepare и start требует нового preview', async (t) => {
  const fixture = await installNpmFixture(t, { installed: true });
  const preparation = (await prepare(fixture.app, 'claude', 'update')).json();

  await appendFile(path.join(fixture.root, '.bashrc'), '# человек дописал\nexport NEW=1\n');

  const started = await startWithToken(fixture.app, preparation.token, 'claude', 'update');

  assert.equal(started.statusCode, 409, started.body);
  assert.equal(started.json().error, 'preparation_changed');
  assert.equal(fixture.calls.commands.length, 0);
});

test('изменение effective prefix между prepare и start требует нового preview', async (t) => {
  const fixture = await installNpmFixture(t, { installed: true });
  const preparation = (await prepare(fixture.app, 'claude', 'update')).json();
  const other = path.join(fixture.root, 'other-prefix');

  await mkdir(other, { recursive: true });
  await writeFile(fixture.npm,
    `#!/bin/sh\nif [ "$1" = "prefix" ]; then printf '%s\\n' ${JSON.stringify(other)}; fi\n`,
    { mode: 0o755 });

  const started = await startWithToken(fixture.app, preparation.token, 'claude', 'update');

  assert.equal(started.statusCode, 409, started.body);
  assert.equal(started.json().error, 'preparation_changed');
  assert.equal(fixture.calls.commands.length, 0);
});

test('появление чужого объекта в цели блокирует старт', async (t) => {
  const fixture = await installNpmFixture(t, { installed: true });
  const preparation = (await prepare(fixture.app, 'claude', 'update')).json();

  await mkdir(path.dirname(fixture.npmBinary), { recursive: true });
  await writeFile(fixture.npmBinary, '#!/bin/sh\n', { mode: 0o755 });

  const started = await startWithToken(fixture.app, preparation.token, 'claude', 'update');

  assert.equal(started.statusCode, 409, started.body);
  assert.equal(started.json().error, 'preparation_changed');
  assert.equal(fixture.calls.commands.length, 0);
});

test('занятость не тратит token: старт после завершения проходит', async (t) => {
  const fixture = await installFixture(t, { installed: false });
  const second = {
    ...fixture.provider,
    id: 'codex',
    name: 'Второй исполнитель',
    installation: () => structuredClone(fixture.descriptor),
    probe: async () => ({ ok: false, version: '' }),
  };

  fixture.adapters.set('codex', second);

  const preparation = (await prepare(fixture.app, 'codex', 'install')).json();
  const busyStart = await start(fixture.app, 'claude', 'install');

  assert.equal(busyStart.statusCode, 202, busyStart.body);

  const blocked = await startWithToken(fixture.app, preparation.token, 'codex', 'install');

  assert.equal(blocked.statusCode, 409, blocked.body);
  assert.equal(blocked.json().error, 'busy');

  fixture.gate.resolve();
  await completed(fixture.app, 'claude');

  const started = await startWithToken(fixture.app, preparation.token, 'codex', 'install');

  assert.equal(started.statusCode, 202, started.body);
  fixture.gate.resolve();
  await completed(fixture.app, 'codex');
});

test('перезапуск сервера делает подготовку недействительной', async (t) => {
  const fixture = await installNpmFixture(t, { installed: true });
  const preparation = (await prepare(fixture.app, 'claude', 'update')).json();
  const { ProviderInstallService } = await import(
    '../../server/src/lib/providerInstall/service.ts');
  const restarted = new ProviderInstallService({
    statePath: fixture.config.providerInstallStatePath,
    config: fixture.config,
    env: fixture.env,
    adaptersOf: async () => fixture.adapters,
    latestOf: () => '2.0.0',
    refreshModels: async () => ({}),
    invalidate: async () => {},
    broadcast: () => {},
  });

  await assert.rejects(restarted.start('claude', 'update', {
    token: preparation.token,
    scope: 'restarted',
  }), { code: 'preparation_invalid' });
  assert.equal(fixture.calls.commands.length, 0);
});

test('неподдержанная оболочка даёт установку без изменения rc', async (t) => {
  const fixture = await installNpmFixture(t, { installed: true, shell: '/bin/zsh' });
  const bashrc = path.join(fixture.root, '.bashrc');
  const before = await readFile(bashrc, 'utf8');
  const preparation = (await prepare(fixture.app, 'claude', 'update')).json();

  assert.equal(preparation.terminalSetup, 'manual');
  assert.deepEqual(preparation.shellChanges, []);
  assert.ok(preparation.warnings.some((warning) => warning.code === 'terminal_setup_required'));

  const started = await startWithToken(fixture.app, preparation.token, 'claude', 'update');

  assert.equal(started.statusCode, 202, started.body);
  fixture.gate.resolve();

  const job = (await completed(fixture.app)).recent.claude;

  assert.equal(job.status, 'succeeded');
  assert.equal(job.terminal.status, 'needs_setup');
  assert.equal(job.terminal.shell, 'other');
  assert.equal(await readFile(bashrc, 'utf8'), before);
});

test('зависший Bash не блокирует установку и помечает shell probe', async (t) => {
  const fixture = await installNpmFixture(t, {
    installed: true,
    providerInstall: { bashTimeoutMs: 200 },
  });

  await writeFile(path.join(fixture.root, '.bashrc'), 'exec sleep 30\n');

  const preparation = await prepare(fixture.app, 'claude', 'update');

  assert.equal(preparation.statusCode, 200, preparation.body);
  assert.ok(preparation.json().warnings.some((warning) => warning.code === 'shell_probe_failed'));
  assert.equal(preparation.json().terminalSetup, 'manual');
});

test('v2 требует auth, проверяет payload и не публикует отдельную миграцию', async (t) => {
  const { app, calls } = await installFixture(t, { auth: true });

  for (const [method, url] of [
    ['GET', '/api/providers/installations/v2/current'],
    ['POST', '/api/providers/installations/v2/claude/install/prepare'],
    ['POST', '/api/providers/installations/v2/claude/install/start'],
  ]) {
    const result = await app.inject({
      method,
      url,
      payload: {},
    });

    assert.equal(result.statusCode, 401, `${url}: ${result.body}`);
  }

  assert.equal(calls.adapters, 0);

  for (const [url, payload] of [
    ['/api/providers/installations/v2/claude/install/prepare', { path: '/tmp/claude' }],
    ['/api/providers/installations/v2/claude/install/start', { preparationToken: 'x', path: '/x' }],
  ]) {
    const result = await app.inject({
      method: 'POST',
      url,
      payload,
      headers: { cookie },
    });

    assert.equal(result.statusCode, 400, `${url}: ${result.body}`);
  }

  for (const action of ['prepare', 'start']) {
    const result = await app.inject({
      method: 'POST',
      url: `/api/providers/installations/v2/migrations/${action}`,
      payload: {},
      headers: { cookie },
    });

    assert.equal(result.statusCode, 404);
  }

  assert.equal(calls.commands.length, 0);
});
