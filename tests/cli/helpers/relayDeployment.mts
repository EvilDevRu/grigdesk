import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';

import { build } from '../../../web/node_modules/esbuild/lib/main.js';
import { sourceMenu, repository } from './menuFixture.mts';
import { startPty } from './pty.mts';

/**
 * CLI получает короткую cookie через настоящий HTTP и только свой window-key файл.
 * Серверные DTO здесь синтетические: SSH и установка проверяются отдельными integration tests.
 */
export async function relayCliFixture(t: TestContext, installed = false, options: {
  holdInstall?: boolean;
  jobs?: Record<string, unknown>[];
} = {}) {
  const box = await sourceMenu(t);
  const calls: {
    method: string;
    url: string;
    body: string;
    cookie: string | undefined
  }[] = [];
  const fp = 'a'.repeat(64);
  const keyFile = path.join(box.home, 'window-key');
  const job: Record<string, any> = {
    id: 'deployment-0001',
    revision: 1,
    state: 'draft',
    expectedServerFp: fp,
    mode: 'setup',
    relayId: 'r12345678',
    ssh: {
      host: '127.0.0.1',
      port: 2222,
      user: 'root'
    },
    public: { host: 'relay.example.invalid', port: 443 },
    steps: [],
    service: { state: 'pending' },
    channel: { state: 'unverified' },
  };

  await cp(path.join(repository, 'shared'), path.join(box.root, 'shared'), { recursive: true });
  await writeFile(keyFile, 'fixture-window-key', { mode: 0o600 });
  box.environment.GRIGDESK_WINDOW_KEY_PATH = keyFile;

  const sockets = new Set<import('node:net').Socket>();
  const server = createServer(async (request, response) => {
    const chunks = [];

    for await (const chunk of request) {
      chunks.push(chunk);
    }

    const body = Buffer.concat(chunks).toString();
    const url = new URL(request.url!, 'http://fixture').pathname;

    calls.push({
      method: request.method!,
      url,
      body,
      cookie: request.headers.cookie
    });
    response.setHeader('content-type', 'application/json');
    response.setHeader('cache-control', 'no-store');

    if (url === '/api/auth/window-session') {
      assert.equal(request.headers['x-grigdesk-window-key'], 'fixture-window-key');
      response.setHeader('set-cookie', 'grigdesk_sid=relay-fixture; HttpOnly');
      response.end('{}');

      return;
    }

    if (url.endsWith('/hello')) {
      response.end(JSON.stringify({
        product: 'grigdesk',
        name: 'Домашний стенд',
        fp,
        api: { major: 0, minor: 1 },
        device: null
      }));

      return;
    }

    const relay = {
      id: 'r12345678',
      name: 'Прежний доступ',
      host: 'relay.example.invalid',
      port: 443,
      fp,
      enabled: true,
      link: { state: 'offline' }
    };

    if (url === '/api/mobile/status' || url === '/api/devices/access') {
      response.end(JSON.stringify({
        server: {
          up: true,
          fp,
          name: 'Домашний стенд'
        },
        relays: [relay],
        devices: [],
        name: 'Домашний стенд',
        direct: { state: 'disabled', addresses: [] },
      }));

      return;
    }

    if (url === '/api/mobile/deployments' && request.method === 'GET') {
      response.end(JSON.stringify({
        jobs: [...(options.jobs ?? []), ...(calls.some((call) => call.method === 'POST'
          && call.url === url) ? [job] : [])],
      }));

      return;
    }

    if (url === '/api/mobile/deployments' && request.method === 'POST') {
      Object.assign(job, JSON.parse(body), {
        id: job.id,
        revision: 1,
        state: 'draft',
      });
      response.statusCode = 202;
    } else if (url.endsWith('/probe')) {
      Object.assign(job, {
        state: 'awaiting_host_key',
        revision: job.revision + 1,
        hostKey: {
          challengeId: 'challenge-one',
          fingerprint: 'SHA256:fixture-server',
          decision: 'trust_required',
          revision: 2
        }
      });
    } else if (url.endsWith('/host-key')) {
      Object.assign(job, { state: 'awaiting_credentials', revision: job.revision + 1 });
    } else if (url.endsWith('/credentials')) {
      assert.equal(request.headers['content-type'], 'application/octet-stream');
      Object.assign(job, {
        state: 'awaiting_confirmation',
        revision: job.revision + 1,
        preview: {
          digest: 'b'.repeat(64),
          changes: ['Отдельный пользователь и служба'],
          artifact: { version: '0.3.0', digest: 'c'.repeat(64) }
        }
      });
      response.statusCode = 202;
    } else if (url.endsWith('/start')) {
      Object.assign(job, {
        state: options.holdInstall ? 'installing' : 'ready',
        revision: job.revision + 1,
        service: { state: 'running' },
        channel: { state: 'verified' }
      });
      response.statusCode = 202;
    } else if (url.includes('/phone-pairing')) {
      response.end(JSON.stringify({
        text: 'GRIGDESK:PHONE:2:FIXTURE',
        svg: '<svg/>',
        qr: { rows: ['1'], size: 1 },
        attemptId: 'phone-attempt',
        status: 'pending',
        expiresInMs: 600000,
      }));

      return;
    }

    response.end(JSON.stringify({ job }));
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(box.port, '127.0.0.1', resolve));
  t.after(async () => {
    sockets.forEach((socket) => socket.destroy());
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  let argv = ['/bin/bash', path.join(box.root, 'bin/grigdesk-ctl')];

  if (installed) {
    const root = path.join(box.home, 'installed');

    await mkdir(root, { mode: 0o700 });
    await writeFile(path.join(root, 'installation.json'), JSON.stringify({
      format: 1,
      installationId: randomUUID(),
      uid: process.getuid!(),
      root,
      mode: 'server',
      channel: 'release',
      dataHome: path.join(box.home, '.grigdesk'),
      userData: path.join(box.home, 'desktop-data'),
    }), { mode: 0o600 });

    const entry = path.join(box.home, 'installed-relay.mjs');

    await build({
      stdin: {
        contents: `import { runInstalledCli } from './cli/installedCli.ts';
process.exitCode = await runInstalledCli(${JSON.stringify(root)}, process.argv.slice(2));`,
        resolveDir: repository,
        loader: 'ts'
      },
      outfile: entry,
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'silent',
    });
    argv = [process.execPath, entry];
  }

  return {
    box,
    calls,
    job,
    launch: (action: string, options: {
      inputTTY?: boolean;
      outputTTY?: boolean;
      args?: string[];
    } = {}) =>
      startPty(t, {
        argv: [...argv, 'relay', action, ...(options.args ?? [])],
        env: {
          ...box.environment,
          LANG: 'ru_RU.UTF-8',
          LC_ALL: '',
          TERM: 'xterm'
        },
        cwd: '/',
        ...options,
      }),
  };
}
