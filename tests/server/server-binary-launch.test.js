import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { buildHelper } from '../../server/scripts/sea/helpers.mts';
import { sha256File } from '../../shared/node/hash.ts';

const execute = promisify(execFile);
const SOURCE = path.resolve(import.meta.dirname, '../..');
const PACKAGE = 'a'.repeat(64);
const TOKEN = '12345678-1234-4234-8234-123456789abc';
const metadata = {
  format: 1,
  hostContract: 1,
  version: '0.1.0',
  packagingVersion: 2,
  packageId: PACKAGE,
  runtime: {
    node: '24.21.0',
    abi: '137',
    platform: 'linux',
    arch: 'x64',
  },
  capabilities: ['api', 'ipc', 'helpers', 'engine'],
  engine: { protocol: 'route-v2', sha256: 'b'.repeat(64) },
  payload: {
    sha256: 'c'.repeat(64),
    size: 12,
    entryCount: 1,
  },
};

/**
 * Установка I и извлечённый R раздельны; в PATH нет Node, а systemctl только пишет argv.
 * Маленький настоящий ELF моделирует протокол launcher, helpers собираются штатно.
 */
async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'server-binary-launch-'));
  const root = path.join(temp, 'I with spaces');
  const home = path.join(temp, 'home');
  const data = path.join(temp, 'data');
  const runtime = path.join(data, 'runtimes/server/packages', PACKAGE);
  const stubs = path.join(temp, 'stubs');
  const calls = path.join(temp, 'calls');
  const lease = path.join(temp, 'lease');
  const node = path.join(runtime, 'runtime/node/bin/node');
  const binary = path.join(root, 'bin/grigdesk-server');

  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  await fs.cp(path.join(SOURCE, 'deploy'), path.join(root, 'deploy'), { recursive: true });

  for (const directory of [home, stubs, path.dirname(node), path.dirname(binary),
    path.join(runtime, 'engine/bin')]) {
    await fs.mkdir(directory, { recursive: true });
  }

  await fs.cp(path.join(SOURCE, 'bin/grigdesk-ctl'), path.join(root, 'bin/grigdesk-ctl'));
  await fs.writeFile(path.join(temp, 'metadata.json'), JSON.stringify(metadata));
  await fs.writeFile(path.join(temp, 'prepared.json'), JSON.stringify({
    packageId: PACKAGE,
    root: runtime,
    node,
    engine: path.join(runtime, 'engine/bin/factory'),
    installationBin: path.dirname(binary),
    preparationToken: TOKEN,
  }));
  await fs.writeFile(path.join(runtime, 'engine/bin/factory'), '#!/bin/bash\nexit 0\n', { mode: 0o555 });
  await fs.writeFile(node, [
    '#!/bin/bash',
    '[[ -z "${NODE_OPTIONS+x}" ]] || exit 92',
    '[[ -f "$FIXTURE_LEASE" ]] || exit 93',
    'exec "$FIXTURE_NODE" "$@"',
  ].join('\n'), { mode: 0o555 });

  for (const id of ['grigdesk-cli', 'data-home-check', 'legacy-brand']) {
    await buildHelper({
      root: SOURCE,
      manifestPath: path.join(SOURCE, 'server/build/helpers.json'),
      id,
      outDir: path.join(runtime, 'server/runtime/helpers'),
      workDir: path.join(temp, 'helper-work'),
    });
  }

  for (const command of ['bash', 'readlink', 'dirname', 'mkdir', 'rm', 'sed',
    'mktemp', 'ln', 'mv', 'chmod', 'cat', 'basename', 'head']) {
    const found = (await execute('/bin/bash', ['-c', 'command -v "$1"', '_', command])).stdout.trim();

    await fs.symlink(found, path.join(stubs, command));
  }

  const python = (await execute('/bin/bash', ['-c', 'command -v python3'])).stdout.trim();

  await fs.symlink(python, path.join(stubs, 'python-runtime'));
  await fs.writeFile(path.join(stubs, 'python3'), [
    '#!/bin/bash',
    '[[ "$*" == *"-c"* ]] || { echo forbidden-python >> "$STUB_LOG"; exit 97; }',
    'exec "${BASH_SOURCE[0]%/*}/python-runtime" "$@"',
  ].join('\n'), { mode: 0o755 });

  for (const command of ['systemctl', 'loginctl', 'npm', 'ss']) {
    await fs.writeFile(path.join(stubs, command), [
      '#!/bin/bash',
      `printf '${command} %s\\n' "$*" >> "$STUB_LOG"`,
      command === 'npm' ? 'exit 97' : 'exit 0',
    ].join('\n'), { mode: 0o755 });
  }

  const cSource = path.join(temp, 'launcher.c');

  await fs.writeFile(cSource, `
    #include <stdio.h>
    #include <stdlib.h>
    #include <string.h>
    #include <unistd.h>
    int main(int argc, char **argv) {
      if (getenv("NODE_OPTIONS")) return 91;
      FILE *log = fopen(getenv("STUB_LOG"), "a");
      fprintf(log, "elf");
      for (int i = 1; i < argc; i++) fprintf(log, " %s", argv[i]);
      fprintf(log, "\\n");
      fclose(log);
      const char *file = NULL;
      if (argc > 1 && !strcmp(argv[1], "--runtime-info")) file = getenv("FIXTURE_METADATA");
      else if (argc > 1 && !strcmp(argv[1], "--prepare")) {
        FILE *mark = fopen(getenv("FIXTURE_LEASE"), "w");
        fprintf(mark, "%d", getppid());
        fclose(mark);
        file = getenv("FIXTURE_PREPARED");
      } else if (argc > 1 && !strcmp(argv[1], "--release-preparation")) {
        unlink(getenv("FIXTURE_LEASE"));
        puts("{\\"ok\\":true}");
        return 0;
      } else {
        printf("ELF");
        for (int i = 1; i < argc; i++) printf(" [%s]", argv[i]);
        puts("");
        return 0;
      }
      FILE *input = fopen(file, "r");
      if (!input) return 94;
      int value;
      while ((value = fgetc(input)) != EOF) putchar(value);
      fclose(input);
      return 0;
    }
  `);
  await execute('cc', [cSource, '-o', binary]);

  const env = {
    PATH: stubs,
    HOME: home,
    GRIGDESK_HOME: data,
    GRIGDESK_PORT: '19001',
    GRIGDESK_B24_INSTALL_PAUSE: '0',
    FIXTURE_NODE: process.execPath,
    FIXTURE_METADATA: path.join(temp, 'metadata.json'),
    FIXTURE_PREPARED: path.join(temp, 'prepared.json'),
    FIXTURE_LEASE: lease,
    STUB_LOG: calls,
  };

  return {
    temp,
    root,
    home,
    data,
    runtime,
    binary,
    node,
    lease,
    env,
    calls: () => fs.readFile(calls, 'utf8').catch(() => ''),
    run: async (script, args = [], extra = {}) => {
      try {
        return { code: 0, ...await execute('/bin/bash', [path.join(root, script), ...args], {
          env: { ...env, ...extra },
          cwd: '/',
          timeout: 30000,
        }) };
      } catch (error) {
        return {
          code: error.code,
          stdout: error.stdout ?? '',
          stderr: error.stderr ?? '',
        };
      }
    },
  };
}

test('SB28-run: внешний ELF и metadata без Node/npm, пути с пробелами и точный argv', async (t) => {
  const box = await fixture(t);
  const result = await box.run('bin/grigdesk-ctl', ['run', '--version', '--json'], {
    NODE_OPTIONS: '--require /foreign/loader.cjs', GRIGDESK_HOME: 'relative-data',
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'ELF [--version] [--json]');
  assert.match(await box.calls(), /elf --runtime-info --json/);
  assert.doesNotMatch(await box.calls(), /--prepare|npm|systemctl/);
});

test('SB28-refusal: повреждённые metadata, non-ELF и symlink не переходят к исходникам', async (t) => {
  const box = await fixture(t);

  await fs.writeFile(box.env.FIXTURE_METADATA, JSON.stringify({ ...metadata, hostContract: 2 }));

  const rejected = await box.run('bin/grigdesk-ctl', ['run']);

  assert.equal(rejected.code, 1);
  assert.match(rejected.stderr, /описание серверного ELF/);
  assert.doesNotMatch(await box.calls(), /^elf$/m);
  await fs.writeFile(box.binary, '#!/bin/bash\necho foreign\n');
  assert.equal((await box.run('bin/grigdesk-ctl', ['run'])).code, 1);
  await fs.rm(box.binary);
  await fs.symlink('/missing/server', box.binary);
  assert.equal((await box.run('bin/grigdesk-ctl', ['run'])).code, 1);
  assert.doesNotMatch(await box.calls(), /npm/);
});

test('SB28-tools: отдельный b24 выбирается из bin установки без подготовки runtime', async (t) => {
  const box = await fixture(t);

  await fs.writeFile(path.join(box.root, 'bin/b24'), '#!/bin/bash\necho local-b24 "$@"\n',
    { mode: 0o755 });
  await fs.writeFile(path.join(box.env.PATH, 'b24'), '#!/bin/bash\nexit 97\n', { mode: 0o755 });

  const result = await box.run('bin/grigdesk-ctl', ['b24', '--version']);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'local-b24 --version');
  assert.doesNotMatch(await box.calls(), /--prepare|npm/);
});

test('SB28-unit: внешний ExecStart, cwd I, VPN и прежние ограничения без запуска службы', async (t) => {
  const box = await fixture(t);
  const result = await box.run('deploy/install.sh', ['--unit-only'], {
    NODE_OPTIONS: '--require /foreign/loader.cjs',
  });

  assert.equal(result.code, 0, result.stderr);

  const unit = await fs.readFile(path.join(box.home, '.config/systemd/user/grigdesk-server.service'), 'utf8');

  assert.ok(unit.includes(`ExecStart="${box.binary}"`));
  assert.ok(unit.includes(`WorkingDirectory="${box.root}"`));
  assert.ok(unit.includes(`ExecStartPre="${box.root}/deploy/require-vpn.sh"`));
  assert.ok(unit.includes(`EnvironmentFile=-${box.data}/.env`));
  assert.match(unit, /UnsetEnvironment=NODE_OPTIONS/);
  assert.match(unit, /KillMode=mixed/);
  assert.match(unit, /Restart=always/);
  assert.match(unit, /RestartPreventExitStatus=78/);
  assert.doesNotMatch(unit, /server\/src|packages\/.*ExecStart/);
  assert.match(await box.calls(), /elf --release-preparation .* --package-id/);
  assert.deepEqual((await box.calls()).split('\n').filter((line) => line.startsWith('systemctl ')),
    ['systemctl --user daemon-reload']);
  assert.equal(await fs.stat(box.lease).catch(() => null), null);
  assert.doesNotMatch(await box.calls(), /npm/);
});

test('SB28-cli: собранный helper сохраняет restart guard и освобождает preparation при отказе', async (t) => {
  const box = await fixture(t);
  const cgroup = path.join(box.temp, 'cgroup');

  await fs.writeFile(cgroup, '0::/user.slice/grigdesk-server.service/agents\n');

  const result = await box.run('bin/grigdesk-ctl', ['server', 'restart'], {
    GRIGDESK_CLI_CGROUP_FILE: cgroup,
  });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /прервёт ход агента/);
  assert.doesNotMatch(await box.calls(), /systemctl/);
  assert.match(await box.calls(), /elf --prepare --json --expect-package-id/);
  assert.match(await box.calls(), /elf --release-preparation/);
  assert.equal(await fs.stat(box.lease).catch(() => null), null);
});

test('SB28-prepare: чужой R отклоняется, dev/build не запускают установку зависимостей', async (t) => {
  const box = await fixture(t);
  const foreign = JSON.parse(await fs.readFile(box.env.FIXTURE_PREPARED, 'utf8'));

  foreign.node = process.execPath;
  await fs.writeFile(box.env.FIXTURE_PREPARED, JSON.stringify(foreign));

  const result = await box.run('deploy/install.sh', ['--unit-only']);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /подготовки серверного ELF/);
  assert.doesNotMatch(await box.calls(), /systemctl|npm/);
  assert.equal(await fs.stat(box.lease).catch(() => null), null, 'lease снимается и при неверном R');

  for (const command of ['dev', 'build', 'deps']) {
    const response = await box.run('bin/grigdesk-ctl', [command]);

    assert.equal(response.code, 1);
    assert.match(response.stderr, /доступна в установке из исходников/);
  }
});

test('SB28-loopback: повторная регистрация не стартует соседнюю службу', async (t) => {
  const box = await fixture(t);
  const server = http.createServer((request, response) => {
    assert.equal(request.url, '/api/auth/state');
    assert.equal(request.socket.localAddress, '127.0.0.1');
    response.setHeader('Content-Type', 'application/json');
    response.end('{"configured":true,"authenticated":false}');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const result = await box.run('deploy/install.sh', ['--autostart', '--no-shortcut', '--no-cuda'], {
    GRIGDESK_PORT: String(server.address().port),
  });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /уже работает/);
  assert.match(await box.calls(), /systemctl --user enable grigdesk-server/);
  assert.doesNotMatch(await box.calls(), /systemctl .*start|npm/);
  assert.equal(await fs.stat(box.lease).catch(() => null), null);
});

test('SB28-vpn: ExecStartPre не пропускает маршрут мимо TUN', async (t) => {
  const box = await fixture(t);
  const sys = path.join(box.temp, 'sys');
  const ip = path.join(box.env.PATH, 'ip');

  await fs.mkdir(path.join(sys, 'tun0'), { recursive: true });
  await fs.writeFile(path.join(sys, 'tun0/operstate'), 'up\n');
  await fs.writeFile(path.join(sys, 'tun0/tun_flags'), '1\n');
  await fs.writeFile(ip, '#!/bin/bash\nprintf "1.1.1.1 dev eth0 src 192.0.2.1\\n"\n',
    { mode: 0o755 });

  const env = {
    FACTORY_TESTING: '1',
    GRIGDESK_VPN_SYS_CLASS_NET: sys,
    GRIGDESK_IP_BIN: ip,
    GRIGDESK_VPN_IFACE: 'tun0',
  };
  const blocked = await box.run('deploy/require-vpn.sh', [], env);

  assert.equal(blocked.code, 1);
  assert.match(blocked.stderr, /идёт мимо туннеля/);
  assert.equal((await box.run('deploy/require-vpn.sh', [], { ...env, GRIGDESK_REQUIRE_VPN: '0' })).code,
    0);
  assert.doesNotMatch(await box.calls(), /systemctl/);
});

/**
 * Два независимых loopback-порта не пересекаются с живым сервером и мобильным входом.
 * Между освобождением порта и spawn нет внешних действий, кроме записи fixture env.
 */
async function freePort() {
  const server = http.createServer();

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const port = server.address().port;

  await new Promise((resolve) => server.close(resolve));

  return port;
}

test('SB28-CLI-ROOT: окно из I/bin и standalone unit cwd I', async (t) => {
  const box = await fixture(t);

  await fs.writeFile(path.join(box.root, 'bin/grigdesk-app'), '#!/bin/bash\nexit 0\n',
    { mode: 0o755 });
  await fs.writeFile(path.join(box.env.PATH, 'systemctl'), [
    '#!/bin/bash',
    'printf "LoadState=loaded\\nActiveState=inactive\\nSubState=dead\\nResult=success\\n"',
    'printf "WorkingDirectory=%s\\n" "$FIXTURE_INSTALLATION"',
  ].join('\n'), { mode: 0o755 });

  const result = await box.run('bin/grigdesk-ctl', ['status', '--json'], {
    FIXTURE_INSTALLATION: box.root,
    GRIGDESK_PORT: String(await freePort()),
  });

  assert.equal(result.code, 0, result.stderr);

  const status = JSON.parse(result.stdout);

  assert.deepEqual({
    window: status.window.state,
    server: status.server.state,
  }, { window: 'closed', server: 'stopped' });
});

test('SB28-CLI-LEGACY: прежний R сохраняет окно в R/bin и cwd R/server', async (t) => {
  const box = await fixture(t);

  await fs.rm(box.binary);
  await fs.writeFile(path.join(box.root, 'release.json'), '{"schema":1}\n');
  await fs.writeFile(path.join(box.root, 'VERSION'), '1.2.3\n');
  await fs.mkdir(path.join(box.root, 'runtime/node/bin'), { recursive: true });
  await fs.cp(path.join(box.runtime, 'server/runtime/helpers'),
    path.join(box.root, 'server/runtime/helpers'), { recursive: true });
  await fs.writeFile(path.join(box.root, 'runtime/node/bin/node'), [
    '#!/bin/bash',
    '[[ -z "${NODE_OPTIONS+x}" ]] || exit 92',
    'exec "$FIXTURE_NODE" "$@"',
  ].join('\n'), { mode: 0o755 });
  await fs.writeFile(path.join(box.root, 'server/grigdesk-server'), '#!/bin/bash\nexit 0\n',
    { mode: 0o755 });
  await fs.writeFile(path.join(box.root, 'bin/grigdesk-app'), '#!/bin/bash\nexit 0\n',
    { mode: 0o755 });
  await fs.writeFile(path.join(box.env.PATH, 'systemctl'), [
    '#!/bin/bash',
    'printf "LoadState=loaded\\nActiveState=inactive\\nSubState=dead\\nResult=success\\n"',
    'printf "WorkingDirectory=%s/server\\n" "$FIXTURE_INSTALLATION"',
  ].join('\n'), { mode: 0o755 });

  const result = await box.run('bin/grigdesk-ctl', ['status', '--json'], {
    FIXTURE_INSTALLATION: box.root,
    GRIGDESK_PORT: String(await freePort()),
    NODE_OPTIONS: '--require /foreign/loader.cjs',
  });

  assert.equal(result.code, 0, result.stderr);

  const status = JSON.parse(result.stdout);

  assert.deepEqual({
    window: status.window.state,
    server: status.server.state,
  }, { window: 'closed', server: 'stopped' });
  assert.equal((await box.run('bin/grigdesk-ctl', ['--version'])).stdout.trim(), 'GrigDesk 1.2.3');
});

test('SB28-real: S22 unit/CLI/run без host Node, CA из .env до Node bootstrap', async (t) => {
  const pointer = path.resolve(SOURCE, '../s23-real-candidate.json');
  const candidate = await fs.readFile(pointer, 'utf8').catch(() => null);

  if (!candidate) {
    t.skip('Нужен опубликованный кандидат S22 в RUN/s23-real-candidate.json');

    return;
  }

  const { binary, packageId, sha256 } = JSON.parse(candidate);
  const box = await fixture(t);

  await fs.rm(path.join(box.data, 'runtimes/server'), { recursive: true, force: true });
  await fs.chmod(box.data, 0o700);
  await fs.copyFile(binary, box.binary);

  const digest = await sha256File(box.binary);

  t.diagnostic(`S28b-real packageId=${packageId} sha256=${digest}`);

  if (sha256 !== undefined) {
    assert.equal(digest, sha256);
  }

  const unit = await box.run('deploy/install.sh', ['--unit-only'], {
    NODE_OPTIONS: '--require /foreign/loader.cjs',
  });

  assert.equal(unit.code, 0, unit.stderr);
  assert.equal((await box.run('bin/grigdesk-ctl', ['--help'])).code, 0);
  assert.deepEqual(await fs.readdir(path.join(box.data, 'runtimes/server/leases', packageId)), []);

  const port = await freePort();
  const mobilePort = await freePort();
  const ca = path.join(box.temp, 'synthetic-missing-ca.pem');

  await fs.writeFile(path.join(box.data, '.env'), [
    `GRIGDESK_PORT=${port}`,
    `GRIGDESK_MOBILE_PORT=${mobilePort}`,
    `NODE_EXTRA_CA_CERTS=${ca}`,
    'NODE_OPTIONS=--require /foreign/from-env.cjs',
    '',
  ].join('\n'));

  const { GRIGDESK_PORT: ignoredPort, ...env } = box.env;
  const child = spawn('/bin/bash', [path.join(box.root, 'bin/grigdesk-ctl'), 'run'], {
    cwd: '/',
    env: {
      ...env,
      NODE_ENV: 'production',
      GRIGDESK_REQUIRE_VPN: '0',
      FACTORY_FORBID_LIVE: '1',
      FACTORY_STATE_DIR: path.join(box.data, 'factory/state'),
      FACTORY_CONTROL_ROOT: path.join(box.data, 'factory/control'),
      FACTORY_CONFIG_ROOT: path.join(box.data, 'factory/config'),
      FACTORY_PROFILES_DIR: path.join(box.data, 'profiles'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = once(child, 'close');
  let log = '';
  const capture = (bytes) => {
    log = (log + String(bytes)).slice(-65536);
  };

  child.stdout.on('data', capture);
  child.stderr.on('data', capture);

  const timer = setTimeout(() => child.kill('SIGKILL'), 30000);

  try {
    let ready = false;
    const deadline = Date.now() + 20000;

    while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/auth/state`, {
          signal: AbortSignal.timeout(500),
        });

        ready = response.status === 200 && typeof (await response.json()).configured === 'boolean';
      } catch {}

      if (ready) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    assert.ok(ready, `ELF должен выдать API на loopback: ${log}`);
    assert.ok(log.includes(ca) && log.includes('Ignoring extra certs'),
      'Свой Node должен прочитать CA из .env при bootstrap, до серверного JS');
    assert.doesNotMatch(log, /Cannot find module.*foreign/);
    assert.equal(await fs.readlink(`/proc/${child.pid}/exe`), box.binary);
    child.kill('SIGTERM');

    const [code] = await closed;

    assert.equal(code, 0, log);
    assert.equal(await fs.stat(path.join(box.data, 'state/server.lock')).catch(() => null), null);
    assert.deepEqual(await fs.readdir(path.join(box.data, 'runtimes/server/leases', packageId)), []);
    assert.deepEqual((await box.calls()).split('\n').filter((line) => line.startsWith('systemctl ')),
      ['systemctl --user daemon-reload']);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }

    await closed;
    clearTimeout(timer);
  }
});
