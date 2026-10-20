import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { promisify } from 'node:util';

const execute = promisify(execFile);

/**
 * Порт резервируется только на loopback собственного namespace и освобождается перед spawn.
 * Данные, ключи и настройки принадлежат исключительно выбранному тестовому D.
 */
async function freePort(): Promise<number> {
  const server = createServer();

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();

  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

  return address.port;
}

/**
 * Полностью синтетическое окружение позволяет повторять одинаковый сценарий у R и ELF.
 * Пустой PATH делает системный Node непригодным даже при ошибке поиска runtime.
 */
export function bootEnvironment(data: string, port: number, mobilePort: number): NodeJS.ProcessEnv {
  return {
    PATH: '',
    HOME: path.join(data, 'home'),
    XDG_CACHE_HOME: path.join(data, 'xdg/cache'),
    XDG_CONFIG_HOME: path.join(data, 'xdg/config'),
    XDG_DATA_HOME: path.join(data, 'xdg/data'),
    GRIGDESK_HOME: data,
    GRIGDESK_HOST: '127.0.0.1',
    GRIGDESK_PORT: String(port),
    GRIGDESK_MOBILE_PORT: String(mobilePort),
    GRIGDESK_WINDOW_KEY_PATH: path.join(data, 'window-auth/window-key'),
    GRIGDESK_CLI_TOKEN_PATH: path.join(data, 'state/cli-token'),
    FACTORY_STATE_DIR: path.join(data, 'factory/state'),
    FACTORY_CONTROL_ROOT: path.join(data, 'factory/control'),
    FACTORY_CONFIG_ROOT: path.join(data, 'factory/config'),
    FACTORY_PROFILES_DIR: path.join(data, 'profiles'),
    FACTORY_FORBID_LIVE: '1',
    NODE_ENV: 'production',
  };
}

/**
 * Измерение начинается до desktop preflight и завершается authenticated API ответом.
 * Реальный IPC/сигнал закрывает свой сервер; token освобождается только после adoption ACK.
 */
export async function bootApi(input: {
  binary: string;
  data: string;
  packageId?: string;
  preflight?: boolean;
  windowSession?: boolean;
  vpnScript?: string;
}) {
  await mkdir(path.join(input.data, 'home'), { recursive: true });

  const port = await freePort();
  const env = bootEnvironment(input.data, port, await freePort());
  const args: string[] = input.packageId ? ['--expect-package-id', input.packageId] : [];
  const started = performance.now();
  let prepared: { packageId: string; preparationToken: string } | undefined;
  let preflightMs = 0;
  let vpnMs = 0;

  if (input.preflight) {
    env.GRIGDESK_DESKTOP_CHILD = '1';

    const checkArgs = input.packageId ? ['--prepare', '--json'] : ['--check-startup'];
    const check = await execute(input.binary, checkArgs, {
      env,
      cwd: '/',
      timeout: 30000,
      maxBuffer: 65536,
    });

    if (input.packageId) {
      prepared = JSON.parse(check.stdout);
      args.push('--preparation-token', prepared!.preparationToken);
    } else {
      assert.equal(JSON.parse(check.stdout).ok, true);
    }

    if (input.vpnScript) {
      const vpnStarted = performance.now();
      const vpn = await execute('/bin/bash', [input.vpnScript], {
        cwd: '/',
        env: {
          ...env,
          PATH: '/usr/bin:/bin',
          FACTORY_TESTING: '1',
          GRIGDESK_REQUIRE_VPN: '1',
          GRIGDESK_VPN_PROBE: '127.0.0.1',
          GRIGDESK_IP_BIN: '/D/fixtures/vpn-ip',
          GRIGDESK_VPN_SYS_CLASS_NET: '/D/fixtures/vpn-sys',
        },
        timeout: 10000,
        maxBuffer: 65536,
      });

      assert.match(vpn.stdout, /старт разрешён/u);
      vpnMs = performance.now() - vpnStarted;
    }

    preflightMs = performance.now() - started;
  }

  const child = spawn(input.binary, args, {
    cwd: '/',
    env,
    stdio: input.preflight ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  let log = '';
  let adopted = false;
  let released = false;
  const timer = setTimeout(() => child.kill('SIGKILL'), 60000);

  void exited.catch(() => {});
  child.stdout!.on('data', (bytes) => {
    log = (log + String(bytes)).slice(-65536);
  });
  child.stderr!.on('data', (bytes) => {
    log = (log + String(bytes)).slice(-65536);
  });
  child.on('message', (message) => {
    const packet = message as Record<string, unknown>;

    if (packet.type === 'grigdesk:preparation-adopted' && packet.packageId === input.packageId
      && packet.token === prepared?.preparationToken) {
      adopted = true;
    }
  });

  /**
   * Coordinator подтверждает release тем же PID, который получил preparation handle.
   * Повтор cleanup допускается только через production идемпотентный протокол.
   */
  const release = async () => {
    if (prepared && !released) {
      await execute(input.binary, ['--release-preparation', prepared.preparationToken,
        '--package-id', prepared.packageId, '--json'], {
        env,
        cwd: '/',
        timeout: 10000,
      });
      released = true;
    }
  };

  try {
    const deadline = Date.now() + 30000;
    let authenticated = false;

    while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
      try {
        const token = (await readFile(path.join(input.data, 'state/cli-token'), 'utf8')).trim();
        const response = await fetch(`http://127.0.0.1:${port}/api/system/version`, {
          headers: { 'x-grigdesk-token': token },
          signal: AbortSignal.timeout(500),
        });

        if (response.status === 200) {
          const status = await response.json() as { running?: { packageId?: string } };

          if (input.packageId) {
            assert.equal(status.running?.packageId, input.packageId);
          }

          authenticated = true;
          break;
        }
      } catch {}

      await pause(10);
    }

    assert.ok(authenticated, `Authenticated API не готов за 30с\n${log}`);

    const elapsedMs = performance.now() - started;
    let windowSession = false;

    if (input.windowSession) {
      const origin = `http://127.0.0.1:${port}`;
      const denied = await fetch(`${origin}/api/system/version`);

      assert.equal(denied.status, 401);

      const key = (await readFile(path.join(input.data, 'window-auth/window-key'), 'utf8')).trim();
      const exchanged = await fetch(`${origin}/api/auth/window-session`, {
        method: 'POST',
        headers: { 'x-grigdesk-window-key': key, origin },
      });

      assert.equal(exchanged.status, 200, await exchanged.text());

      const cookie = exchanged.headers.get('set-cookie')?.split(';')[0];

      assert.ok(cookie);
      assert.equal((await fetch(`${origin}/api/system/version`, { headers: { cookie } })).status, 200);
      windowSession = true;
    }

    if (prepared) {
      assert.ok(adopted, 'Desktop IPC обязан подтвердить preparation adoption');
      await release();
    }

    if (input.preflight) {
      child.disconnect();
    } else {
      child.kill('SIGTERM');
    }

    assert.equal(await exited, 0, `Штатное завершение своего сервера\n${log}`);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/api/system/version`, {
      signal: AbortSignal.timeout(500),
    }));

    return {
      elapsedMs,
      preflightMs,
      vpnMs,
      authenticated,
      windowSession,
      adopted,
    };
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }

    await exited.catch(() => {});
    await release();
    clearTimeout(timer);
  }
}
