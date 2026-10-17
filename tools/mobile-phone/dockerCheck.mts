import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { artifactsPath } from '../../shared/runtime/dataHome.ts';

const execute = promisify(execFile);

/**
 * Проверяется только собственный compose project, без новой подсети и публикации на внешних интерфейсах.
 * Существующий одноимённый контейнер закрывает проверку: чужой проект не удаляется.
 */
export async function dockerCheck(options: {
  directory: string;
  relayFile: string;
  relayPort: number;
  stopRelay: () => Promise<void>;
  startRelay: () => Promise<void>;
  check: () => Promise<void>;
}) {
  try {
    await execute('docker', ['info'], {
      timeout: 10000,
      maxBuffer: 16384,
    });
  } catch {
    return {
      state: 'NOT RUN',
      detail: 'Docker daemon недоступен в среде',
    };
  }

  const project = 'cockpit-relay-check';
  const existing = await execute('docker', [
    'ps',
    '-aq',
    '--filter',
    'label=com.docker.compose.project=' + project,
  ]);

  if (existing.stdout.trim()) {
    return {
      state: 'NOT RUN',
      detail: 'Имя тестового compose project уже занято',
    };
  }

  const override = path.join(options.directory, 'compose-check.yaml');

  await writeFile(
    override,
    'services:\n  relay:\n    image: cockpit-relay-check:check\n    network_mode: bridge\n',
  );

  const args = ['compose', '-p', project, '-f', path.resolve('relay/compose.yaml'), '-f', override];
  const env = {
    ...process.env,
    RELAY_ENV_FILE: options.relayFile,
    RELAY_PUBLISH_PORT: '127.0.0.1:' + options.relayPort,
    BUILDX_CONFIG: path.join(options.directory, 'buildx'),
  };

  await mkdir(env.BUILDX_CONFIG, {
    recursive: true,
    mode: 0o700,
  });

  const compose = (extra: string[]) =>
    execute('docker', [...args, ...extra], {
      env,
      timeout: 240000,
      maxBuffer: 1024 * 1024,
    });
  let owned = false;
  let container = '';

  await options.stopRelay();

  try {
    try {
      await compose(['build']);
    } catch (failure) {
      const diagnostic = String((failure as { stderr?: string }).stderr || '');

      await writeFile(
        path.join(artifactsPath({ env: process.env, home: os.homedir() }),
          'mobile-remote/docker-build-diagnostic.log'),
        diagnostic.replace(/[A-Za-z0-9_-]{32,}/g, '[скрыто]'),
      );

      const networkFailure = new RegExp(
        [
          'TLS handshake timeout|i/o timeout|network is unreachable|no such host',
          'failed to fetch.*token|unexpected status.*(?:429|50[0-4])',
          'connection reset|context deadline exceeded',
          'failed to do request:',
        ].join('|'),
        'i',
      );

      if (networkFailure.test(diagnostic)) {
        return {
          state: 'NOT RUN',
          detail: 'Docker не смог загрузить официальный базовый образ: сеть registry недоступна',
        };
      }

      throw new Error('Сборка собственного relay-контейнера завершилась ошибкой');
    }

    await compose(['up', '-d', '--no-build']);
    owned = true;
    container = (await compose(['ps', '-q', 'relay'])).stdout.trim();
    assert.ok(container);

    const inspect = async () =>
      JSON.parse(
        (await execute('docker', ['inspect', '--format', '{{json .State}}', container])).stdout,
      );
    const waitHealthy = async () => {
      const deadline = Date.now() + 60000;

      while ((await inspect()).Health?.Status !== 'healthy') {
        assert.ok(Date.now() < deadline, 'Контейнер не стал healthy за 60 секунд');
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    };

    await waitHealthy();
    await options.check();

    const limits = JSON.parse(
      (await execute('docker', ['inspect', '--format', '{{json .HostConfig}}', container])).stdout,
    );

    assert.equal(limits.Memory, 256 * 1024 * 1024);
    assert.equal(limits.PidsLimit, 128);

    const restarts = async () =>
      Number(
        (await execute('docker', ['inspect', '--format', '{{.RestartCount}}', container])).stdout,
      );
    const previous = await restarts();
    const started = performance.now();
    const script = `
      const fs = require('node:fs');
      const ids = fs.readdirSync('/proc').filter((value) => /^\\d+$/.test(value));
      const id = ids.find((value) => {
        try {
          return fs.readFileSync('/proc/' + value + '/cmdline', 'utf8').split('\\0')
            .some((argument) => argument.endsWith('/main.ts'));
        } catch {
          return false;
        }
      });

      if (!id) {
        process.exit(2);
      }
      process.kill(Number(id), 'SIGSTOP');
    `;

    await execute('docker', ['exec', container, 'node', '-e', script]);

    const deadline = Date.now() + 60000;

    while ((await restarts()) <= previous) {
      assert.ok(Date.now() < deadline, 'Docker не перезапустил контейнер после watchdog');
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    await waitHealthy();
    await options.check();
    assert.equal((await inspect()).OOMKilled, false);

    return {
      state: 'PASS',
      detail: `healthy после watchdog: ${Math.round(performance.now() - started)} мс; 256 MiB/128 PID`,
    };
  } finally {
    const created = (
      await execute('docker', [
        'ps',
        '-aq',
        '--filter',
        'label=com.docker.compose.project=' + project,
      ])
    ).stdout.trim();

    if (owned || created) {
      await compose(['down', '--remove-orphans']);
    }

    await options.startRelay();
  }
}
