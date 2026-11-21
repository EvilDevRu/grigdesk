import fs from 'node:fs/promises';
import { createHash, createPublicKey } from 'node:crypto';
import path from 'node:path';

import { parseReleaseChannelIndex } from '../shared/runtime/installedUpdateContracts.ts';
import { RELEASE_SIGNING_PUBLIC_KEY } from '../shared/runtime/releaseChannelContracts.ts';
import { verifyReleaseEnvelope } from '../shared/node/releaseTrust.ts';
import { requireGoSizeReduction, type SizeMeasures } from './verifyGoReleaseSize.mts';

export const goNativeChecks = {
  linux: ['LINUX-VERIFY-MODES', 'LINUX-VERIFY-OFFLINE-UPDATE', 'LINUX-VERIFY-GO-CUTOVER',
    'LINUX-VERIFY-GO-FIRST-CUTOVER'],
  macos: ['MAC-VERIFY-BYTES', 'MAC-VERIFY-MODES', 'MAC-VERIFY-PROBES', 'MAC-VERIFY-ENGINE',
    'MAC-VERIFY-RUNTIME-PIN', 'MAC-VERIFY-DRAIN', 'MAC-VERIFY-EXIT', 'MAC-VERIFY-UPDATE',
    'MAC-VERIFY-FORWARD-PAIR', 'MAC-VERIFY-RECOVERY-PAIR', 'MAC-VERIFY-FORWARD-SERVER',
    'MAC-VERIFY-LAUNCHER', 'MAC-VERIFY-MISSING', 'MAC-VERIFY-GO-CUTOVER', 'MAC-VERIFY-GO-FIRST-CUTOVER'],
} as const;

interface EvidenceIdentity {
  digest: string;
  commit: string;
  releaseId: string;
  artifactId: string;
}

const legacyCommit = '61d944420a16e0e5bedb0a91dd796deef13abd41';
const hash = /^[a-f0-9]{64}$/u;
const artifactId = /^[1-9][0-9]*$/u;

interface NativeEvidence {
  format: 1;
  route: 'official';
  platform: 'linux-x64' | 'darwin-arm64';
  sourceRunId: string;
  sourceAttempt: string;
  signerFingerprint: string;
  origin: string;
  a: EvidenceIdentity & { format: 2 };
  b: EvidenceIdentity & { format: 3 };
  c: EvidenceIdentity & { format: 3 };
  caseIds: string[];
  size: { legacy: SizeMeasures; current: SizeMeasures };
}

interface EvidenceExpectation {
  commit: string;
  linuxDigest: string;
  linuxArtifactId: string;
  sourceRunId: string;
  sourceAttempt: string;
  signerFingerprint: string;
  origin: string;
}

/**
 * Связывает нативный результат с источником, зафиксированным A и точными байтами C.
 * Список caseIds включает первый переход на тот C, который уже подготовлен к передаче.
 */
export function checkGoReleaseEvidence(value: unknown, platform: 'linux' | 'macos',
  expected: EvidenceExpectation): void {
  const receipt = value as NativeEvidence;
  const cases = goNativeChecks[platform];

  if (!receipt || receipt.format !== 1 || receipt.route !== 'official'
    || receipt.platform !== (platform === 'linux' ? 'linux-x64' : 'darwin-arm64')
    || !artifactId.test(expected.linuxArtifactId) || !artifactId.test(expected.sourceRunId)
    || !artifactId.test(expected.sourceAttempt) || !hash.test(expected.signerFingerprint)
    || receipt.sourceRunId !== expected.sourceRunId || receipt.sourceAttempt !== expected.sourceAttempt
    || receipt.signerFingerprint !== expected.signerFingerprint || receipt.origin !== expected.origin
    || receipt.a?.format !== 2 || receipt.a.commit !== legacyCommit
    || receipt.b?.format !== 3 || receipt.c?.format !== 3 || receipt.c.commit !== expected.commit
    || !Array.isArray(receipt.caseIds) || new Set(receipt.caseIds).size !== receipt.caseIds.length
    || !cases.every((name) => receipt.caseIds.includes(name))
    || !receipt.size?.legacy || !receipt.size.current) {
    throw new Error('release_go_native_evidence_invalid:' + platform);
  }

  const inputs = [receipt.a, receipt.b, receipt.c];

  if (new Set(inputs.map((item) => item.digest)).size !== inputs.length
    || new Set(inputs.map((item) => item.artifactId)).size !== inputs.length
    || inputs.some((item) => !hash.test(item.digest) || !artifactId.test(item.artifactId)
      || typeof item.releaseId !== 'string' || !item.releaseId)
    || platform === 'linux' && (receipt.c.artifactId !== expected.linuxArtifactId
      || receipt.c.digest !== expected.linuxDigest)) {
    throw new Error('release_go_native_inputs_mismatch:' + platform);
  }

  requireGoSizeReduction(receipt.size.legacy, receipt.size.current);
}

/**
 * Действует до получения ключа сайта и повторно до transport.
 * Доверенные координаты CI передаются отдельно от файлов самого выпуска.
 */
export async function verifyGoReleaseEvidence(directory: string): Promise<void> {
  const names = (await fs.readdir(directory)).filter((name) => /^(release|dev)\.json$/u.test(name));

  if (names.length !== 1) {
    throw new Error('release_distribution_ambiguous');
  }

  const index = parseReleaseChannelIndex(await fs.readFile(path.join(directory, names[0]!), 'utf8'));

  if (index.format !== 3) {
    return;
  }
  if (!index.latest) {
    throw new Error('release_distribution_empty');
  }

  const key = createPublicKey(RELEASE_SIGNING_PUBLIC_KEY).export({ format: 'der', type: 'spki' });
  const expected: EvidenceExpectation = {
    commit: index.latest.payload.commit,
    linuxDigest: verifyReleaseEnvelope(index.latest),
    linuxArtifactId: process.env.GRIGDESK_GO_LINUX_ARTIFACT_ID ?? '',
    sourceRunId: process.env.GRIGDESK_GO_SOURCE_RUN_ID ?? '',
    sourceAttempt: process.env.GRIGDESK_GO_SOURCE_ATTEMPT ?? '',
    signerFingerprint: createHash('sha256').update(key).digest('hex'),
    origin: new URL(index.latest.payload.artifacts.server.url).origin,
  };

  for (const platform of ['linux', 'macos'] as const) {
    const file = path.join(directory, `go-native-${platform}.json`);
    const stat = await fs.lstat(file).catch(() => null);

    if (!stat?.isFile() || stat.size <= 0 || stat.size > 1 << 20) {
      throw new Error('release_go_native_evidence_missing:' + platform);
    }

    checkGoReleaseEvidence(JSON.parse(await fs.readFile(file, 'utf8')), platform, expected);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const directory = path.resolve(process.argv[2] ?? 'release-artifacts');

  await verifyGoReleaseEvidence(directory).catch((error: unknown) => {
    process.stderr.write((error as Error).message + '\n');
    process.exitCode = 1;
  });
}
