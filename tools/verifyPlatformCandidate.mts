import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';

import type { CandidatePlan, CandidatePlatform, CandidateVerification } from './platformCandidate.mts';
import { checkRuntimePinOutcomes, readRuntimePinJson } from './ci/runtimePinEvidence.mts';
import { removePrivateTree } from '../shared/node/files.ts';

interface InputTrust {
  publicKeyBase64: string;
  signerFingerprint: string;
  manifestDigest: string;
}

const root = path.resolve(import.meta.dirname, '..');

/**
 * Verify запускает ограниченный npm-free test runner из checkout, тогда как
 * приложение, CLI и сервис поступают только из готовых и проверенных A/B.
 */
async function run(command: string, argv: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(command, argv, {
    cwd: root,
    env,
    stdio: 'inherit',
  });
  const [code, signal] = await once(child, 'exit');

  if (code !== 0) {
    throw new Error(`candidate_native_check_failed:${code ?? signal ?? 'unknown'}`);
  }
}

/**
 * Loopback доступен в отдельном network namespace, внешних интерфейсов нет.
 * Строки strace остаются в private scratch. Ошибка сообщает только тип результата.
 */
async function runLinuxOfflineAcceptance(args: string[], env: NodeJS.ProcessEnv, temp: string) {
  const interfaces = Object.entries(os.networkInterfaces());

  if (process.env.GRIGDESK_ACCEPTANCE_NETNS !== '1' || interfaces.length !== 1
    || interfaces[0]?.[0] !== 'lo' || !interfaces[0][1]?.some((address) => address.address === '127.0.0.1')
    || !interfaces[0][1]?.every((address) => address.internal)) {
    throw new Error('candidate_linux_network_scope_invalid');
  }

  const trace = path.join(temp, 'network.log');

  await run('/usr/bin/strace', ['-f', '-q', '-e', 'trace=connect,sendto,sendmsg,sendmmsg',
    '-o', trace, '--', '/usr/bin/xvfb-run', '-a', '/bin/bash', ...args], {
    ...env, APPIMAGE_EXTRACT_AND_RUN: '1',
  });

  const lines = createInterface({ input: createReadStream(trace), crlfDelay: Infinity });
  let loopbackSeen = false;

  for await (const line of lines) {
    const addresses = line.matchAll(/sa_family=AF_INET(6)?[, ]([^}]+)/gu);

    for (const [, ipv6, address] of addresses) {
      const loopback = ipv6
        ? /inet_pton\(AF_INET6, "::(?:1|ffff:127\.(?:\d{1,3}\.){2}\d{1,3})"/u.test(address!)
        : /inet_addr\("127\.(?:\d{1,3}\.){2}\d{1,3}"\)/u.test(address!);

      if (!loopback) {
        throw new Error('candidate_linux_outbound_attempt');
      }

      loopbackSeen = true;
    }
  }

  if (!loopbackSeen) {
    throw new Error('candidate_linux_network_observation_missing');
  }
}

/**
 * Каждый verifier получает один private report dir и независимый checkout
 * без подписи или подготовки исходников. Приёмка остаётся на нативном хосте.
 */
export async function runPlatformAcceptance(
  platform: CandidatePlatform,
  current: string,
  previous: string,
  plan: CandidatePlan,
  trust: InputTrust,
  priorTrust: InputTrust,
): Promise<CandidateVerification> {
  const darwin = platform === 'darwin-arm64';
  const prefix = darwin ? 'MACOS_' : 'LINUX_';
  const temp = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'gd-acceptance-'));
  const reports = path.join(temp, 'pin');
  const report = path.join(temp, 'platform.json');

  await fs.mkdir(reports, { mode: 0o700 });

  const env: NodeJS.ProcessEnv = {
    PATH: [path.dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
    HOME: process.env.HOME,
    TMPDIR: temp,
    LANG: 'C.UTF-8',
    NODE_TEST_MAX_RSS_MB: '4096',
    GRIGDESK_CANDIDATE_ACCEPTANCE_REPORT: report,
    GRIGDESK_RUNTIME_PIN_REPORT_DIR: reports,
    GRIGDESK_ARTIFACTS_DIR: temp,
    GRIGDESK_BUILD_PROCESS_HELPER: process.env.GRIGDESK_BUILD_PROCESS_HELPER,
    GRIGDESK_BUILD_PROCESS_HELPER_SHA256: process.env.GRIGDESK_BUILD_PROCESS_HELPER_SHA256,
    GRIGDESK_TEST_SETSID_BIN: process.env.GRIGDESK_TEST_SETSID_BIN,
    GRIGDESK_BUILD_SETSID_SHA256: process.env.GRIGDESK_BUILD_SETSID_SHA256,
    GRIGDESK_ACCEPTANCE_DISPOSABLE_MAC: darwin && process.env.GITHUB_ACTIONS === 'true'
      && process.env.RUNNER_ENVIRONMENT === 'github-hosted' && process.env.GITHUB_JOB === 'macos_verify'
      ? '1' : undefined,
    [prefix + 'CANDIDATE_DIR']: current,
    [prefix + 'PREVIOUS_DIR']: previous,
    [prefix + 'COMMIT']: plan.plan.candidate.commit,
    [prefix + 'CANDIDATE_PUBLIC_KEY_B64']: trust.publicKeyBase64,
    [prefix + 'CANDIDATE_PUBLIC_KEY_FINGERPRINT']: trust.signerFingerprint,
    [prefix + 'EXPECTED_MANIFEST_DIGEST']: trust.manifestDigest,
    [prefix + 'PREVIOUS_MANIFEST_DIGEST']: priorTrust.manifestDigest,
  };
  const file = darwin ? 'macos-release-install.e2e.mts' : 'linux-candidate-install.e2e.mts';
  let completed = false;

  try {
    const args = ['tests/run-node-tests-safe.sh', '--test', '--test-concurrency=1', 'tests/server/' + file];

    if (darwin) {
      await run('/bin/bash', args, env);
    } else {
      await runLinuxOfflineAcceptance(args, env, temp);
    }

    const result = await readRuntimePinJson(report, true) as CandidateVerification;

    if (darwin) {
      await run(process.execPath, ['tools/ci/run-macos-runtime-pin-tests.mts', 'packaged'], env);

      const outcomes = checkRuntimePinOutcomes('packaged',
        await readRuntimePinJson(path.join(reports, 'runtime-pin-outcomes.json'), true));

      result.passed.push('MAC-VERIFY-RUNTIME-PIN');
      result.runtime.runtimePin = outcomes;
    }

    completed = true;

    return result;
  } finally {
    if (darwin && !completed) {
      process.stderr.write(`Сохранены журналы нативной приёмки ${temp}\n`);
    } else {
      await removePrivateTree(temp);
    }
  }
}
