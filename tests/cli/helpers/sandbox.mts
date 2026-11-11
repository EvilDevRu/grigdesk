import assert from 'node:assert/strict';
import { spawn as spawnChild } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

export interface RunOutput {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Sandbox {
  readonly environment: NodeJS.ProcessEnv;
  home: string;
  root: string;
  port: number;
  calls(): string[];
  unit(fields: Record<string, string> | 'unavailable', after?: Record<string, string>): void;
  journal(text: string): void;
  docker(list: string[] | 'unavailable', inspect?: string): void;
  fail(command: 'systemctl' | 'journalctl' | 'docker', code: number, stderr?: string): void;
  hold(): () => void;
  installWindow(): void;
  installRuntime(text?: string): void;
  lock(target: string): void;
  serve(kind: 'grigdesk' | 'other' | 'hang', mobile?: unknown): Promise<void>;
  requests(): string[];
  run(args: string[], env?: Record<string, string | undefined>): Promise<RunOutput>;
  spawn(args: string[], env?: Record<string, string | undefined>): ChildProcess;
  waitFor(predicate: () => boolean, ms?: number): Promise<void>;
}

const repo = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * Строка передаётся shell как единственный литерал без подстановок.
 * Это сохраняет пути с пробелами и не исполняет содержимое фикстур.
 */
export function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

/**
 * Сбор stdout/stderr начинается сразу после spawn, до ожидания барьеров теста.
 * При зависании завершает только своего ребёнка и возвращает диагностический отказ.
 */
export function completed(child: ChildProcess): Promise<RunOutput> {
  let stdout = '';
  let stderr = '';

  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI завис: ${stdout}\n${stderr}`));
    }, 20_000);

    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({
        code: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
}

// Все системные команды представлены одним скриптом, запущенным через точный Node теста.
// Ответы и барьер хранятся в каталоге фикстуры, на машине никаких эффектов нет.
const stubSource = `
const fs = require('node:fs');
const path = require('node:path');
const command = process.argv[2];
const args = process.argv.slice(3);
const base = process.env.STUB_HOME;
const file = (name) => path.join(base, 'stub', name);
const read = (name) => fs.existsSync(file(name)) ? fs.readFileSync(file(name), 'utf8') : '';
const present = (name) => fs.existsSync(file(name));
fs.appendFileSync(path.join(base, 'calls.log'), command + ' ' + args.join(' ') + '\\n');
(async () => {
  if (command === 'systemctl' && present('hold')) {
    const end = Date.now() + 10000;
    while (!present('release') && Date.now() < end) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!present('release')) process.exit(1);
  }
  const query = command === 'systemctl' ? args.includes('show') :
    command === 'docker' && ['ps', 'inspect'].includes(args[0]);
  if (!query && present(command + '-fail')) {
    const failure = JSON.parse(read(command + '-fail'));
    process.stderr.write(failure.stderr);
    process.exit(failure.code);
  }
  if (command === 'systemctl') {
    if (present('unit-unavailable')) {
      process.stderr.write('Failed to connect to bus');
      process.exit(1);
    }
    if (args.includes('show')) {
      process.stdout.write(read(present('acted') && present('unit-after.txt') ?
        'unit-after.txt' : 'unit.txt'));
    } else if (args.some((arg) => ['start', 'stop', 'restart'].includes(arg))) {
      fs.writeFileSync(file('acted'), '');
    }
  } else if (command === 'journalctl') {
    process.stdout.write(read('journal.txt'));
  } else if (command === 'docker') {
    if (present('docker-unavailable')) {
      process.stderr.write('Docker недоступен: тестовый отказ');
      process.exit(1);
    }
    if (args[0] === 'ps') process.stdout.write(read('docker-list.txt'));
    if (args[0] === 'inspect') process.stdout.write(read('docker-inspect.txt'));
  }
})();
`;

/**
 * Создаёт отдельную копию CLI с командами-заглушками и своим свободным HTTP-портом.
 * До запуска доказывает через command -v, что ни один системный инструмент не достижим.
 */
export async function createSandbox(t: TestContext): Promise<Sandbox> {
  const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'grigdesk-cli-')));
  const root = path.join(home, 'репозиторий с пробелами');
  const stubs = path.join(home, 'stubs');
  const stubDir = path.join(home, 'stub');
  const sockets = new Set<Socket>();
  const servers = new Set<Server>();
  const children = new Set<ChildProcess>();
  const requests: string[] = [];

  for (const dir of [stubs, stubDir, path.join(root, 'bin'), path.join(root, 'tools'),
    path.join(root, 'deploy/lib'), path.join(root, 'shared'), path.join(home, '.grigdesk/state'),
    path.join(root, 'relay')]) {
    mkdirSync(dir, { recursive: true });
  }

  for (const name of ['bin/grigdesk-ctl', 'cli', 'deploy/lib/runtime-env.sh',
    'server/src/lib/runtimePaths.ts', 'server/src/lib/runtimeBuildContext.ts',
    'shared/runtime/dataHome.ts', 'shared/runtime/grigDeskReadiness.ts', 'shared/desktop/desktopRuntime.ts',
    'shared/runtime/runtimeSettings.ts', 'shared/runtime/legacyBrand.ts', 'shared/desktop/windowKeyPath.ts',
    'shared/node',
    'shared/i18n', 'shared/package.json', 'VERSION']) {
    cpSync(path.join(repo, name), path.join(root, name), { recursive: true });
  }

  writeFileSync(path.join(root, 'relay/compose.yaml'), '');
  writeFileSync(path.join(home, '.grigdesk/state/cli-token'), 'sandbox-cli-token');
  writeFileSync(path.join(home, 'cgroup'), '0::/user.slice/test.scope');
  writeFileSync(path.join(stubs, 'stub.cjs'), stubSource);

  for (const name of ['systemctl', 'journalctl', 'docker', 'xdg-open', 'notify-send']) {
    writeFileSync(path.join(stubs, name),
      `#!/bin/bash\nexec ${shellQuote(process.execPath)} ${shellQuote(path.join(stubs, 'stub.cjs'))}` +
      ` ${shellQuote(name)} "$@"\n`, { mode: 0o755 });
  }

  // Команды, которые bin/grigdesk-ctl передаёт отдельным скриптам: имя — путь заглушки.
  const delegated: Record<string, string> = {
    desktop: 'deploy/desktop.sh',
    tracker: 'bin/tracker',
    mobile: 'tools/mobile',
    release: 'tools/release',
  };

  for (const [name, file] of Object.entries(delegated)) {
    writeFileSync(path.join(root, file), `#!/bin/bash
printf '${name} %s\\n' "$*" >> "$STUB_HOME/calls.log"
exit 7
`, { mode: 0o755 });
  }

  const env: NodeJS.ProcessEnv = { ...process.env };

  for (const key of [
    'GRIGDESK_ENV_FILE', 'GRIGDESK_PORT', 'GRIGDESK_CLI_TOKEN_PATH', 'GRIGDESK_WINDOW_KEY_PATH',
    'GRIGDESK_RELAY_PROJECT', 'GRIGDESK_DESKTOP_DATA_DIR', 'NO_COLOR', 'WAYLAND_DISPLAY',
    'GRIGDESK_NODE_DIR', 'GRIGDESK_SERVER_BINARY', 'SECRET_TOKEN']) {
    delete env[key];
  }

  Object.assign(env, {
    HOME: home,
    GRIGDESK_HOME: path.join(home, '.grigdesk'),
    GRIGDESK_ARTIFACTS_DIR: path.join(home, '.grigdesk/artifacts'),
    XDG_CONFIG_HOME: path.join(home, 'config'),
    XDG_DATA_HOME: path.join(home, 'data'),
    PATH: `${stubs}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    STUB_HOME: home,
    GRIGDESK_CLI_CGROUP_FILE: path.join(home, 'cgroup'),
    GRIGDESK_WAIT_SEC: '5',
    DISPLAY: ':99',
  });

  const guard = await completed(spawnChild('bash', ['-c',
    'command -v systemctl journalctl docker xdg-open notify-send'], { env }));

  assert.equal(guard.code, 0, guard.stderr);
  assert.equal(guard.stdout.trim().split('\n').length, 5);

  for (const command of guard.stdout.trim().split('\n')) {
    assert.ok(command.startsWith(stubs + '/'), `В песочнице доступна настоящая команда: ${command}`);
  }

  const reserve = createServer();

  await new Promise<void>((resolve) => reserve.listen(0, '127.0.0.1', resolve));

  const address = reserve.address();

  assert.ok(address && typeof address === 'object');

  const port = address.port;

  await new Promise<void>((resolve) => reserve.close(() => resolve()));
  writeFileSync(path.join(home, '.grigdesk/.env'), `GRIGDESK_PORT=${port}\n`);
  t.after(async () => {
    for (const child of children) {
      child.kill('SIGKILL');
    }

    for (const socket of sockets) {
      socket.destroy();
    }

    await Promise.all([...servers].map((server) => new Promise<void>((resolve) => {
      server.close(() => resolve());
    })));
    rmSync(home, {
      recursive: true,
      force: true,
    });
  });

  const put = (name: string, text: string) => writeFileSync(path.join(stubDir, name), text);
  const remove = (name: string) => rmSync(path.join(stubDir, name), { force: true });
  const box: Sandbox = {
    environment: env,
    home,
    root,
    port,
    calls: () => existsSync(path.join(home, 'calls.log'))
      ? readFileSync(path.join(home, 'calls.log'), 'utf8').split('\n').filter(Boolean) : [],
    /**
     * Подменяет данные show и будущий результат действия службы.
     * Значения по умолчанию всегда относятся только к корню песочницы.
     */
    unit(fields, after) {
      remove('unit-unavailable');
      remove('acted');
      remove('unit-after.txt');

      if (fields === 'unavailable') {
        put('unit-unavailable', '');

        return;
      }

      const content = (values: Record<string, string>) => Object.entries({
        LoadState: 'loaded',
        ActiveState: 'inactive',
        SubState: 'dead',
        Result: 'success',
        WorkingDirectory: path.join(root, 'server'),
        ...values,
      }).map(([key, value]) => `${key}=${value}`).join('\n');

      put('unit.txt', content(fields));

      if (after) {
        put('unit-after.txt', content(after));
      }
    },
    journal(text) {
      put('journal.txt', text);
    },
    docker(list, inspect = 'running\thealthy') {
      remove('docker-unavailable');

      if (list === 'unavailable') {
        put('docker-unavailable', '');
      } else {
        put('docker-list.txt', list.join('\n'));
        put('docker-inspect.txt', inspect);
      }
    },
    fail(command, code, stderr = '') {
      put(command + '-fail', JSON.stringify({
        code,
        stderr,
      }));
    },
    hold() {
      remove('release');
      put('hold', '');

      return () => {
        if (existsSync(stubDir)) {
          put('release', '');
        }
      };
    },
    installWindow() {
      const app = path.join(root, 'bin/grigdesk-app');

      mkdirSync(path.dirname(app), { recursive: true });
      writeFileSync(app, `#!/bin/bash
printf 'app %s\\n' "$*" >> "$STUB_HOME/calls.log"
printf 'app-argc %s\\n' "$#" >> "$STUB_HOME/calls.log"
printf 'app-key %s\\n' "\${GRIGDESK_WINDOW_KEY_PATH:-}" >> "$STUB_HOME/calls.log"
printf 'app-secret %s\\n' "\${SECRET_TOKEN:-}" >> "$STUB_HOME/calls.log"
`, { mode: 0o755 });
    },
    /**
     * Описание установки нового окна (runtime.json) на пути desktopRuntimePath песочницы.
     * Без аргумента — исправное описание этой копии, иначе переданный текст как есть.
     */
    installRuntime(text) {
      const file = path.join(env.XDG_DATA_HOME!, 'grigdesk/desktop/runtime.json');

      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text ?? JSON.stringify({
        version: 1,
        root,
        node: process.execPath,
      }), { mode: 0o600 });
    },
    lock(target) {
      const directory = path.join(env.XDG_CONFIG_HOME!, 'GrigDesk');

      mkdirSync(directory, { recursive: true });
      symlinkSync(target, path.join(directory, 'SingletonLock'));
    },
    /**
     * HTTP-фикстура слушает только свой порт и проверяет тестовый токен.
     * Чужие ответы и зависание не обращаются к рабочему серверу.
     */
    async serve(kind, mobile = { relays: [] }) {
      const server = createServer((request, response) => {
        requests.push(request.url ?? '');

        if (kind === 'hang') {
          return;
        }

        if (kind === 'other') {
          response.writeHead(404).end();

          return;
        }

        response.setHeader('Content-Type', 'application/json');

        if (request.url === '/api/auth/state') {
          response.end(JSON.stringify({
            configured: true,
            authenticated: false,
          }));
        } else if (request.url === '/api/mobile/status' &&
          request.headers['x-grigdesk-token'] === 'sandbox-cli-token') {
          response.end(JSON.stringify(mobile));
        } else {
          response.writeHead(401).end();
        }
      });

      servers.add(server);
      server.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
      });
      await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    },
    // Пути всех HTTP-запросов к фикстуре: отсутствие запроса проверяется прямо.
    requests: () => [...requests],
    /**
     * Ребёнок наследует защищённое окружение, затем явные overrides теста.
     * Его PID учитывается для уборки только собственных процессов.
     */
    spawn(args, overrides = {}) {
      const childEnv = { ...env };

      for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) {
          delete childEnv[key];
        } else {
          childEnv[key] = value;
        }
      }

      const child = spawnChild('bash', [path.join(root, 'bin/grigdesk-ctl'), ...args], {
        env: childEnv,
        cwd: '/',
      });

      children.add(child);
      child.once('close', () => children.delete(child));

      return child;
    },
    run(args, overrides) {
      return completed(box.spawn(args, overrides));
    },
    /**
     * Ждёт наблюдаемое событие без фиксированной задержки перед assertion.
     * Ограниченный срок возвращает журнал вызовов для диагностики барьера.
     */
    async waitFor(predicate, ms = 5000) {
      const end = Date.now() + ms;

      while (!predicate()) {
        if (Date.now() >= end) {
          throw new Error(`Барьер не достигнут: ${box.calls().join('\n')}`);
        }

        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
  };

  box.unit({});
  box.docker([]);

  return box;
}
