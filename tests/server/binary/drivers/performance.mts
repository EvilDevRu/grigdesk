import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type { BinaryIsolationPaths } from '../isolation.mts';
import { bootApi } from './api.mts';
import { launcherPayloadReads } from './hashCounters.mts';

const execute = promisify(execFile);
const paths = JSON.parse(process.argv[2]!) as BinaryIsolationPaths;

interface Usage {
  allocatedBytes: number;
  logicalBytes: number;
  inodes: number;
}

/**
 * GNU du считает физические блоки, apparent bytes и уникальные inodes одинаково для R и cache.
 * Symlink не разыменовывается; три независимых чтения выполняются вне тёплых таймингов.
 */
async function usage(directory: string): Promise<Usage> {
  const result = await Promise.all([
    execute('/usr/bin/du', ['-s', '-B1', directory]),
    execute('/usr/bin/du', ['-s', '-B1', '--apparent-size', directory]),
    execute('/usr/bin/du', ['-s', '--inodes', directory]),
  ]);
  const values = result.map((value) => Number(value.stdout.split(/\s/u)[0]));

  assert.ok(values.every((value) => Number.isSafeInteger(value) && value > 0));

  return {
    allocatedBytes: values[0]!,
    logicalBytes: values[1]!,
    inodes: values[2]!,
  };
}

/**
 * Median берётся из центрального отсортированного sample, p95 — nearest rank ceil(0.95*n).
 * Исходный порядок и обе стороны каждой пары сохраняются отдельно в отчёте.
 */
function summary(values: number[]) {
  const sorted = values.toSorted((left, right) => left - right);

  return {
    medianMs: sorted[Math.floor(sorted.length / 2)]!,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
  };
}

/**
 * Каждый desktop preflight вызывает production VPN-скрипт с synthetic интерфейсом и маршрутом.
 * IP probe ничего не отправляет в сеть: namespace имеет только свой loopback.
 */
async function prepareVpnFixture() {
  const directory = '/D/fixtures/vpn-sys/tun-fixture';

  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'tun_flags'), '1\n');
  await writeFile(path.join(directory, 'operstate'), 'up\n');
  await writeFile('/D/fixtures/vpn-ip', '#!/bin/sh\necho "127.0.0.1 dev tun-fixture src 127.0.0.1"\n', {
    mode: 0o755,
  });
}

/**
 * Обе поставки проходят один API/auth/shutdown код; меняются только binary и preflight command.
 * Все warm пары используют повторяемые D, cold получает новый cache без сброса page cache.
 */
function boot(kind: 'baseline' | 'elf', scenario: string, data?: string) {
  const root = kind === 'baseline' ? paths.baseline! : paths.runtime;

  return bootApi({
    binary: kind === 'baseline' ? path.join(root, 'server/grigdesk-server') : paths.binary,
    data: data ?? (kind === 'baseline' ? '/D/baseline-data' : '/D'),
    ...(kind === 'elf' ? { packageId: paths.packageId } : {}),
    preflight: scenario === 'desktop',
    vpnScript: path.join(root, 'deploy/require-vpn.sh'),
  });
}

/**
 * Наблюдатель места работает только во время cold, не добавляя обходы к warm измерениям.
 * Rename может опередить du: такой неполный sample пропускается, published R измеряется отдельно.
 */
function watchStaging(data: string) {
  let peak: Usage = {
    allocatedBytes: 0,
    logicalBytes: 0,
    inodes: 0,
  };
  let pending = Promise.resolve();
  let sampling = false;
  let samples = 0;

  const timer = setInterval(() => {
    if (sampling) {
      return;
    }

    sampling = true;
    pending = (async () => {
      const packages = path.join(data, 'runtimes/server/packages');
      const names = await readdir(packages).catch(() => [] as string[]);

      for (const name of names.filter((name) => name.includes('.staging-'))) {
        const value = await usage(path.join(packages, name)).catch(() => null);

        if (value) {
          samples += 1;
          peak = {
            allocatedBytes: Math.max(peak.allocatedBytes, value.allocatedBytes),
            logicalBytes: Math.max(peak.logicalBytes, value.logicalBytes),
            inodes: Math.max(peak.inodes, value.inodes),
          };
        }
      }
    })().finally(() => {
      sampling = false;
    });
  }, 100);

  return async () => {
    clearInterval(timer);
    await pending;

    return {
      peak,
      samples,
      intervalMs: 100,
    };
  };
}

/**
 * Тайминги выполняются без tracer: 5 разогревов, 15 пар с чередованием и 3 новых ELF cache.
 * В каждой паре порядок известен заранее и одинаков для повторного полного прогона.
 */
async function measureScenario(name: string) {
  const warmups = [];
  const pairs = [];
  const cold = [];

  for (let index = 0; index < 5; index += 1) {
    warmups.push({ baseline: await boot('baseline', name), elf: await boot('elf', name) });
  }

  for (let index = 0; index < 15; index += 1) {
    const order: ('baseline' | 'elf')[] = index % 2 === 0 ? ['baseline', 'elf'] : ['elf', 'baseline'];
    const pair: Record<string, any> = { index, order };

    for (const kind of order) {
      pair[kind] = await boot(kind, name);
    }

    pairs.push(pair);
    console.error(`S27 ${name}: пара ${index + 1}/15 завершена`);
  }

  for (let index = 0; index < 3; index += 1) {
    const data = `/D/cold-${name}-${index}`;
    const stopWatching = watchStaging(data);
    let measured;

    try {
      measured = await boot('elf', name, data);
    } finally {
      const staging = await stopWatching();

      if (measured) {
        const runtime = path.join(data, 'runtimes/server/packages', paths.packageId);

        cold.push({
          ...measured,
          staging,
          generation: await usage(runtime),
        });
      }
    }

    await rm(data, { recursive: true });
    console.error(`S27 ${name}: cold ${index + 1}/3 завершён`);
  }

  const baseline = summary(pairs.map((pair) => pair.baseline.elapsedMs));
  const elf = summary(pairs.map((pair) => pair.elf.elapsedMs));

  return {
    name,
    warmups,
    pairs,
    cold,
    baseline,
    elf,
    ratio: {
      median: elf.medianMs / baseline.medianMs,
      p95: elf.p95Ms / baseline.p95Ms,
    },
  };
}

/**
 * Tracer работает отдельно от замеров и наблюдает настоящие ELF launcher PID до ordinary worker.
 * Нулевое число открытий payload даёт верхнюю границу SHA file calls=0; cold — positive control.
 */
async function hashProbe(scenario: string, data: string) {
  const traceFile = `/D/fixtures/hash-${scenario}.log`;

  await execute('/usr/bin/strace', ['-f', '-qq', '-s', '4096', '-e', 'trace=%process,openat',
    '-o', traceFile, process.execPath, '/suite/driver.mjs', JSON.stringify(paths),
    'hash-probe', scenario === 'cold' ? 'raw' : scenario, data], {
    cwd: '/',
    env: process.env,
    timeout: 120000,
    maxBuffer: 1024 * 1024,
  });

  const root = path.join(data, 'runtimes/server/packages', paths.packageId);
  const counter = launcherPayloadReads(await readFile(traceFile, 'utf8'), paths.binary, root);

  assert.ok(counter.launcherPids.length > 0, 'Tracer обязан увидеть настоящий ELF execve');

  return {
    traceFile,
    launcherPids: counter.launcherPids,
    threadIds: counter.threadIds,
    payloadReadOpens: counter.opened.length,
    sha256FileCallsUpperBound: counter.opened.length,
    examples: counter.opened.slice(0, 3),
  };
}

/**
 * Два настоящих поколения и backup измеряются до и после production --cache-prune линии A.
 * Никакие registry/usage/pins не подделываются: current/previous устанавливают реальные boot.
 */
async function spaceAndGc() {
  assert.ok(paths.previousBinary);

  const previousInfo = JSON.parse((await execute(paths.previousBinary, ['--runtime-info', '--json'], {
    env: { PATH: '' },
    timeout: 10000,
  })).stdout);

  await bootApi({
    binary: paths.previousBinary,
    data: '/D',
    packageId: previousInfo.packageId,
  });
  await boot('elf', 'raw');
  await mkdir('/D/chats', { recursive: true });
  await writeFile('/D/chats/s27-sentinel', 'synthetic-chat');
  await writeFile('/D/profiles/s27-sentinel', 'synthetic-profile');

  const before = await usage('/D/runtimes/server');
  const installation = await usage(paths.installation);
  const previousGeneration = await usage(path.join('/D/runtimes/server/packages', previousInfo.packageId));
  const backupBefore = createHash('sha256').update(await readFile(paths.previousBinary)).digest('hex');
  const prune = JSON.parse((await execute(paths.binary, ['--cache-prune', '--json'], {
    env: {
      PATH: '',
      HOME: paths.home,
      GRIGDESK_HOME: '/D',
    },
    timeout: 120000,
    maxBuffer: 65536,
  })).stdout);
  const after = await usage('/D/runtimes/server');

  assert.deepEqual(prune.deleted, []);
  assert.ok(prune.retained.some((entry: any) => entry.packageId === paths.packageId));
  assert.ok(prune.retained.some((entry: any) => entry.packageId === previousInfo.packageId));
  assert.equal(await readFile('/D/chats/s27-sentinel', 'utf8'), 'synthetic-chat');
  assert.equal(await readFile('/D/profiles/s27-sentinel', 'utf8'), 'synthetic-profile');
  assert.equal((await stat(paths.previousBinary)).size > 0, true);
  assert.equal(createHash('sha256').update(await readFile(paths.previousBinary)).digest('hex'), backupBefore);

  return {
    policy: 'manual',
    previousPackageId: previousInfo.packageId,
    previousGeneration,
    backupSha256: backupBefore,
    installation,
    beforeGc: before,
    peakAPlusBPlusBackup: {
      allocatedBytes: before.allocatedBytes + installation.allocatedBytes,
      logicalBytes: before.logicalBytes + installation.logicalBytes,
      inodes: before.inodes + installation.inodes,
    },
    afterGc: after,
    prune,
    chatsProfilesBackupUnchanged: true,
  };
}

/**
 * Итог содержит исходные samples и отдельно физические пределы для внешних assertions.
 * Неудачный порог сохраняет JSON до отказа теста, вместо выбора удачного подмножества.
 */
async function measure() {
  assert.ok(paths.baseline, 'Нужен read-only baseline mount');
  await prepareVpnFixture();

  const baselineManifest = JSON.parse(await readFile(path.join(paths.baseline, 'release.json'), 'utf8'));

  assert.equal(baselineManifest.runtime.node, process.versions.node);
  assert.equal(baselineManifest.runtime.abi, process.versions.modules);

  const baselineSize = await usage(paths.baseline);
  const generation = await usage(paths.runtime);
  const scenarios = [await measureScenario('raw'), await measureScenario('desktop')];
  const hashCounters = {
    method: 'strace successful regular payload O_RDONLY opens in actual ELF launcher PIDs',
    warmRaw: await hashProbe('raw', '/D'),
    warmDesktop: await hashProbe('desktop', '/D'),
    cold: await hashProbe('cold', '/D/hash-cold'),
  };

  await rm('/D/hash-cold', { recursive: true });

  return {
    packageId: paths.packageId,
    node: process.versions.node,
    abi: process.versions.modules,
    scenarios,
    hashCounters,
    elfBytes: (await stat(paths.binary)).size,
    baselineSize,
    generation,
    space: await spaceAndGc(),
    pageCacheFlushed: false,
    network: 'private namespace, loopback only',
    clock: 'performance.now monotonic; nearest-rank p95',
    vpn: 'production require-vpn.sh; synthetic TUN route via FACTORY_TESTING',
  };
}

if (process.argv[3] === 'hash-probe') {
  await boot('elf', process.argv[4]!, process.argv[5]!);
} else {
  console.log('BINARY_REPORT ' + JSON.stringify(await measure()));
}
