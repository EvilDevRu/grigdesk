import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadavg } from 'node:os';
import test from 'node:test';
import { promisify } from 'node:util';

import { sha256File } from '../../../shared/node/hash.ts';
import { isolatedBinary } from './isolation.mts';

const RUN = path.resolve(import.meta.dirname, '../../../..');
const execute = promisify(execFile);
const MiB = 1024 * 1024;

/**
 * RSS суммируется по всей process group сторожа, включая coordinator, namespace и workers.
 * Sampler имеет свой период100мс и не читает память или окружение посторонних процессов.
 */
async function watchGroupRss() {
  const own = await readFile('/proc/self/stat', 'utf8');
  const pgid = Number(own.slice(own.lastIndexOf(')') + 2).split(' ')[2]);
  let peakKiB = 0;
  let samples = 0;
  let pending = Promise.resolve();
  let sampling = false;

  const sample = () => {
    if (sampling) {
      return;
    }

    sampling = true;
    pending = (async () => {
      const result = await execute('/bin/ps', ['-eo', 'pgid=,rss=']);
      const rss = result.stdout.trim().split('\n').reduce((sum, line) => {
        const fields = line.trim().split(/\s+/u).map(Number);

        return sum + (fields[0] === pgid ? fields[1]! : 0);
      }, 0);

      peakKiB = Math.max(peakKiB, rss);
      samples += 1;
    })().finally(() => {
      sampling = false;
    });
  };

  sample();

  const timer = setInterval(sample, 100);

  return async () => {
    clearInterval(timer);
    await pending;
    assert.ok(peakKiB > 0 && samples > 0, 'RSS всей process group должен быть измерен');

    return {
      peakKiB,
      samples,
      intervalMs: 100,
      pgid,
    };
  };
}

test('SB27-PERF: raw и desktop измерены 5/15/3 без сброса page cache', {
  timeout: 1200000,
}, async (t) => {
  const candidate = process.env.GRIGDESK_TEST_SERVER_BINARY;
  const deepseekBinary = process.env.GRIGDESK_TEST_DEEPSEEK_BINARY;
  const baseline = process.env.GRIGDESK_TEST_BASELINE_RELEASE;

  assert.ok(candidate, 'Нужен явный GRIGDESK_TEST_SERVER_BINARY');
  assert.ok(deepseekBinary, 'Нужен явный GRIGDESK_TEST_DEEPSEEK_BINARY');
  assert.ok(baseline, 'Нужен явный GRIGDESK_TEST_BASELINE_RELEASE, baseline не живая установка');

  const built = JSON.parse(await readFile(path.join(RUN, 'release/build-result.json'), 'utf8'));
  const sha256 = await sha256File(candidate);
  const evidence = JSON.parse(await readFile(path.join(RUN, 's27-build-evidence.json'), 'utf8'));
  const buildLog = await readFile(evidence.log, 'utf8');

  assert.equal(sha256, built.sha256);
  assert.equal(evidence.sha256, sha256, 'Build RSS evidence относится к тому же candidate SHA');
  assert.ok(buildLog.includes(sha256), 'Build log связывает свой RSS с candidate SHA');
  assert.equal(await sha256File(evidence.log), evidence.logSha256);

  const df = await execute('/bin/df', ['-B1', '--output=avail', RUN]);
  const availableBeforeBytes = Number(df.stdout.trim().split('\n').at(-1)?.trim());
  const du = await execute('/usr/bin/du', ['-s', '-B1', baseline]);
  const baselineAllocatedBytes = Number(du.stdout.split(/\s/u)[0]);
  const budget = {
    availableBeforeBytes,
    baselineAllocatedBytes,
    peakEstimateBytes: baselineAllocatedBytes * 3 + built.size * 2 + 128 * MiB,
    reserveBytes: 4096 * MiB,
  };

  assert.ok(availableBeforeBytes > budget.peakEstimateBytes + budget.reserveBytes,
    'До прогона нужен бюджет места для staging/A+B+backup и резерв4GiB');

  const fixture = await isolatedBinary(t, {
    candidate,
    deepseekBinary,
    baselineRelease: baseline,
    previousCandidate: path.join(RUN, 'release/candidate-A/grigdesk-server'),
  });
  const stopRss = await watchGroupRss();
  const loadAverageBefore = loadavg();
  let report;
  let rss;

  try {
    report = await fixture.run(path.join(import.meta.dirname, 'drivers/performance.mts'), {
      timeoutMs: 1100000,
      onProgress: (message) => process.stderr.write(message),
    });
  } finally {
    rss = await stopRss();
  }

  const runId = new Date().toISOString().replaceAll(/[^0-9TZ]/gu, '');
  const buildPeakKiB = Math.max(...[...buildLog.matchAll(/peak-rss=(\d+)KB/gu)]
    .map((match) => Number(match[1])));
  const result = {
    phase: evidence.phase,
    runId,
    sha256,
    build: { log: evidence.log, peakKiB: buildPeakKiB },
    rss,
    budget,
    loadAverageBefore,
    loadAverageAfter: loadavg(),
    ...report,
  };

  for (const [name, probe] of Object.entries(report.hashCounters) as [string, any][]) {
    if (typeof probe === 'object' && probe.traceFile) {
      await copyFile(path.join(fixture.data, path.relative('/D', probe.traceFile)),
        path.join(RUN, `s27-hash-${name}-${runId}.log`));
    }
  }

  await writeFile(path.join(RUN, `s27-performance-${runId}.json`), JSON.stringify(result, null, 2));
  await writeFile(path.join(RUN, 's27-performance.json'), JSON.stringify(result, null, 2));

  assert.deepEqual(report.scenarios.map((item: any) => item.name), ['raw', 'desktop'],
    'S27 обязан измерить оба сценария raw и desktop');
  assert.equal(await sha256File(candidate), sha256, 'Candidate не меняется посреди замера');

  for (const scenario of report.scenarios) {
    assert.equal(scenario.warmups.length, 5);
    assert.equal(scenario.pairs.length, 15);
    assert.equal(scenario.cold.length, 3);
    assert.ok(scenario.ratio.median <= 2, `${scenario.name}: warm median≤2x baseline`);
    assert.ok(scenario.ratio.p95 <= 2, `${scenario.name}: warm p95≤2x baseline`);

    for (const [index, pair] of scenario.pairs.entries()) {
      assert.deepEqual(pair.order, index % 2 === 0 ? ['baseline', 'elf'] : ['elf', 'baseline']);
      assert.ok(pair.baseline.elapsedMs > 0 && pair.elf.elapsedMs > 0);

      if (scenario.name === 'desktop') {
        assert.ok(pair.elf.preflightMs > 0 && pair.baseline.preflightMs > 0);
        assert.equal(pair.elf.adopted, true);
        assert.ok(pair.elf.vpnMs > 0 && pair.baseline.vpnMs > 0);
      }
    }

    for (const cold of scenario.cold) {
      assert.ok(cold.elapsedMs <= 30000, `${scenario.name}: cold≤30с`);
      assert.ok(cold.staging.samples > 0, 'Пик staging наблюдался во время extraction');
    }
  }

  assert.ok(report.elfBytes <= 450 * MiB, 'ELF≤450MiB');
  assert.ok(rss!.peakKiB <= 4096 * 1024, 'Test process group RSS≤4096MiB');
  assert.ok(buildPeakKiB > 0 && buildPeakKiB <= 4096 * 1024, 'Build process group RSS≤4096MiB');
  assert.ok(report.generation.allocatedBytes <= report.baselineSize.allocatedBytes * 1.25);
  assert.ok(report.generation.logicalBytes <= report.baselineSize.logicalBytes * 1.25);
  assert.equal(report.hashCounters.warmRaw.sha256FileCallsUpperBound, 0);
  assert.equal(report.hashCounters.warmDesktop.sha256FileCallsUpperBound, 0);
  assert.ok(report.hashCounters.cold.payloadReadOpens > 1000, 'Cold positive control наблюдает hashes');
  assert.ok(report.space.peakAPlusBPlusBackup.allocatedBytes < budget.peakEstimateBytes);
  assert.deepEqual(report.space.prune.unknown, []);
  assert.equal(report.pageCacheFlushed, false);
});
