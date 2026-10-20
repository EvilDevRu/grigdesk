import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';

import { prepareServerBinary, probeServerBinary, releaseServerPreparation,
  verifyServerBinary } from '../../../shared/node/serverBinaryRuntime.ts';
import type { ServerPackageManifest } from '../../src/binary/metadata.ts';

/**
 * Порт выбирается на loopback и освобождается непосредственно перед spawn.
 * Ни один запрос smoke не направляется к живому серверу или внешней модели.
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
 * Каждый запуск получает только синтетическое окружение со своим D/HOME/портами.
 * Пустой PATH проверяет ordinary Node из payload и отсутствие обязательных внешних CLI.
 */
function environment(root: string, data: string, port: number, mobilePort: number): NodeJS.ProcessEnv {
  return {
    PATH: '',
    HOME: path.join(root, 'home'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_DATA_HOME: path.join(root, 'xdg-data'),
    GRIGDESK_HOME: data,
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
 * Authenticated API readiness и закрытие собственного порта проверяются на реальном ELF.
 * IPC case дополнительно принимает точный ACK и снимает только coordinator preparation owner.
 */
async function boot(input: {
  binary: string;
  root: string;
  data: string;
  packageId?: string;
  preparationToken?: string;
  ipc?: boolean;
}): Promise<number> {
  const port = await freePort();
  const env = environment(input.root, input.data, port, await freePort());
  const args = input.packageId ? ['--expect-package-id', input.packageId] : [];

  if (input.preparationToken) {
    args.push('--preparation-token', input.preparationToken);
  }

  const started = performance.now();
  const child = spawn(input.binary, args, {
    cwd: '/',
    env,
    stdio: input.ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  let log = '';
  let adopted = false;
  const timer = setTimeout(() => child.kill('SIGKILL'), 90000);

  void exited.catch(() => {});
  child.stdout!.on('data', (bytes) => {
    log = (log + String(bytes)).slice(-65536);
  });
  child.stderr!.on('data', (bytes) => {
    log = (log + String(bytes)).slice(-65536);
  });
  child.on('message', (message) => {
    const packet = message as Record<string, unknown>;

    if (packet.type === 'grigdesk:preparation-adopted'
      && packet.packageId === input.packageId && packet.token === input.preparationToken) {
      adopted = true;
    }
  });

  try {
    const deadline = Date.now() + 30000;
    let ready = false;

    while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
      try {
        const token = (await readFile(path.join(input.data, 'state/cli-token'), 'utf8')).trim();
        const response = await fetch(`http://127.0.0.1:${port}/api/system/version`, {
          headers: { 'x-grigdesk-token': token },
          signal: AbortSignal.timeout(500),
        });

        if (response.status === 200) {
          const status = await response.json() as { running?: { version?: string; packageId?: string } };

          assert.equal(status.running?.version, '0.1.0');

          if (input.packageId) {
            assert.equal(status.running?.packageId, input.packageId);
          }

          ready = true;
          break;
        }
      } catch {}

      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    if (!ready) {
      throw new Error(`ELF не выдал authenticated API за 30с\n${log}`);
    }

    const elapsed = performance.now() - started;

    if (input.preparationToken) {
      assert.ok(adopted, 'launcher должен подтвердить adoption по IPC');
      await releaseServerPreparation(input.binary, {
        home: input.data,
        packageId: input.packageId!,
        token: input.preparationToken,
      });

      const lease = JSON.parse(await readFile(path.join(input.data, 'runtimes/server/leases',
        input.packageId!, `${input.preparationToken}.json`), 'utf8'));

      assert.ok(lease.owners.length >= 2, 'launcher и worker сохраняют защиту после ACK/release');
    }

    if (input.ipc) {
      child.disconnect();
    } else {
      child.kill('SIGTERM');
    }

    assert.equal(await exited, 0, `Shutdown ELF должен сохранить0\n${log}`);
    assert.equal(await stat(path.join(input.data, 'state/server.lock')).then(() => true, () => false), false);

    await assert.rejects(fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1000),
    }));

    return elapsed;
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }

    await exited.catch(() => {});
    clearTimeout(timer);
  }
}

/**
 * Короткие ворота E0 используют один warm cache candidate и исторический отдельный R.
 * Полная статистическая приёмка S27 выполняет больше пар, эти пороги уже обязательны.
 */
export async function runBinarySmoke(input: {
  binary: string;
  manifest: ServerPackageManifest;
  cacheDir: string;
  reportFile: string;
}) {
  const root = await mkdtemp(path.join(input.cacheDir, 'e0-'));
  const data = path.join(root, 'data');
  const baselineData = path.join(root, 'baseline-data');
  const baseline = path.join(input.cacheDir, 'baseline-release/server/grigdesk-server');

  await mkdir(path.join(root, 'home'));
  await stat(baseline);

  try {
    const metadata = await probeServerBinary(input.binary, { expectPackageId: input.manifest.packageId });

    assert.equal(await stat(data).then(() => true, () => false), false, 'metadata не создаёт D');

    const candidateInput = {
      binary: input.binary,
      root,
      data,
      packageId: metadata.packageId,
    };
    const baselineInput = {
      binary: baseline,
      root,
      data: baselineData,
    };
    const coldMs = await boot(candidateInput);
    const prepared = await prepareServerBinary(input.binary, {
      home: data,
      expectPackageId: metadata.packageId,
    });
    const ipcMs = await boot({
      binary: input.binary,
      root,
      data,
      packageId: metadata.packageId,
      preparationToken: prepared.preparationToken,
      ipc: true,
    });
    const verified = await verifyServerBinary(input.binary, {
      home: data,
      expectPackageId: metadata.packageId,
      timeoutMs: 120000,
    });

    await boot(baselineInput);

    const warm: number[] = [];
    const previous: number[] = [];

    for (let index = 0; index < 3; index += 1) {
      previous.push(await boot(baselineInput));
      warm.push(await boot(candidateInput));
    }

    const sorted = (values: number[]) => [...values].sort((a, b) => a - b);
    const median = (values: number[]) => sorted(values)[1]!;
    const p95 = (values: number[]) => sorted(values)[2]!;
    const report = {
      packageId: metadata.packageId,
      elfSha256: verified.elfSha256,
      size: (await stat(input.binary)).size,
      coldMs,
      ipcMs,
      warm,
      baseline: previous,
      warmRatio: median(warm) / median(previous),
      warmP95Ratio: p95(warm) / p95(previous),
      verified,
    };

    await writeFile(input.reportFile, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    assert.ok(report.size <= 450 * 1024 * 1024, 'ELF ≤450MiB');
    assert.ok(coldMs <= 30000, 'cold API ≤30с');
    assert.ok(report.warmRatio <= 2, `warm median ratio ${report.warmRatio} ≤2`);
    assert.ok(report.warmP95Ratio <= 2, `warm p95 ratio ${report.warmP95Ratio} ≤2`);

    return report;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
