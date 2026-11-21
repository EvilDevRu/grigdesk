import assert from 'node:assert/strict';
import test from 'node:test';

import { checkGoReleaseEvidence, goNativeChecks } from '../../tools/verifyGoReleaseEvidence.mts';

const legacyCommit = '61d944420a16e0e5bedb0a91dd796deef13abd41';
const commit = 'b'.repeat(40);
const digest = 'c'.repeat(64);
const signerFingerprint = 'd'.repeat(64);
const origin = 'https://grigdesk.test';
const expected = {
  commit,
  linuxDigest: digest,
  linuxArtifactId: '39',
  sourceRunId: '41',
  sourceAttempt: '2',
  signerFingerprint,
  origin,
};

/**
 * Модель квитанции проверяет схему ворот без загрузки CI-артефактов.
 * Подписанный нативный результат передаётся отдельным этапом workflow.
 */
function receipt(platform: 'linux' | 'macos') {
  return {
    format: 1,
    route: 'official',
    platform: platform === 'linux' ? 'linux-x64' : 'darwin-arm64',
    sourceRunId: expected.sourceRunId,
    sourceAttempt: expected.sourceAttempt,
    signerFingerprint,
    origin,
    a: {
      format: 2,
      commit: legacyCommit,
      digest: 'a'.repeat(64),
      releaseId: 'A',
      artifactId: '37',
    },
    b: {
      format: 3,
      commit,
      digest: 'b'.repeat(64),
      releaseId: 'B',
      artifactId: '38',
    },
    c: {
      format: 3,
      commit,
      digest: platform === 'linux' ? digest : 'f'.repeat(64),
      releaseId: 'C',
      artifactId: platform === 'linux' ? '39' : '40',
    },
    caseIds: [...goNativeChecks[platform]],
    size: {
      legacy: {
        raw: 20,
        gzip: 10,
        download: {
          local: 100,
          remote: 90,
          server: 80,
        },
      },
      current: {
        raw: 10,
        gzip: 5,
        download: {
          local: 75,
          remote: 60,
          server: 50,
        },
      },
    },
  };
}

test('GO-EVIDENCE: обе платформы требуют первый переход A → exact C', () => {
  for (const platform of ['linux', 'macos'] as const) {
    const fresh = receipt(platform);

    assert.doesNotThrow(() => checkGoReleaseEvidence(fresh, platform, expected));

    fresh.caseIds = fresh.caseIds.filter((id) => !id.endsWith('FIRST-CUTOVER'));
    assert.throws(() => checkGoReleaseEvidence(fresh, platform, expected),
      /release_go_native_evidence_invalid/u);
  }
});

test('GO-EVIDENCE: SHA Linux C, signer и legacy-v2 принадлежат записи своего запуска', () => {
  const native = receipt('linux');

  assert.throws(() => checkGoReleaseEvidence({
    ...native,
    c: { ...native.c, digest: 'e'.repeat(64) },
  }, 'linux', expected), /release_go_native_inputs_mismatch/u);
  assert.throws(() => checkGoReleaseEvidence({
    ...native,
    a: { ...native.a, format: 3 },
  }, 'linux', expected), /release_go_native_evidence_invalid/u);
  assert.throws(() => checkGoReleaseEvidence({
    ...native,
    signerFingerprint: 'f'.repeat(64),
  }, 'linux', expected), /release_go_native_evidence_invalid/u);
});
