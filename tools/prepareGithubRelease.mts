import fs from 'node:fs/promises';
import path from 'node:path';

import { publicReleaseFile, type PublicReleaseFile } from './verifyLinuxPackages.mts';
import { stableAssetNames, stablePlatforms } from './stablePlatformRelease.mts';

interface ReleaseIdentity {
  commit: string;
  version: string;
  repository: string;
  runId: string;
  planDigest: string;
}

interface VerifiedStableProof {
  channel: string;
  commit: string;
  version: string;
  signatureValid: boolean;
  runId: string;
  planDigest: string;
  assets: PublicReleaseFile[];
}

/**
 * Привязывает локальные загрузки к конкретному стабильному прогону verify.
 * Два языка используют один и тот же allowlist и ссылки версии, а не latest.
 */
export async function prepareGithubRelease(directory: string, proof: VerifiedStableProof,
  identity: ReleaseIdentity) {
  const { commit, version, repository, runId, planDigest } = identity;

  if (!/^[\da-f]{40}$/u.test(commit) || !/^\d+\.\d+\.\d+$/u.test(version)
    || !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/u.test(repository)
    || proof?.channel !== 'release' || proof.commit !== commit || proof.version !== version
    || !/^[1-9]\d*$/u.test(runId) || !/^[a-f0-9]{64}$/u.test(planDigest)
    || proof.runId !== runId || proof.planDigest !== planDigest
    || proof.signatureValid !== true || !Array.isArray(proof.assets)
    || proof.assets.length !== 9) {
    throw new Error('github_asset_proof_invalid');
  }

  const labels = [
    ['Linux x64 · Сетевой установщик', 'Linux x64 · Online installer'],
    ['Linux x64 · Офлайн-комплект (.zip)', 'Linux x64 · Offline bundle (.zip)'],
    ['Linux x64 · Офлайн-пакет Debian / Ubuntu (.deb)', 'Linux x64 · Debian / Ubuntu offline (.deb)'],
    ['macOS · Apple Silicon · Офлайн-комплект', 'macOS · Apple Silicon · Offline bundle'],
    ['Linux ARM64 · Офлайн-комплект', 'Linux ARM64 · Offline bundle'],
    ['Windows x64 · Офлайн-комплект', 'Windows x64 · Offline bundle'],
    ['Windows ARM64 · Офлайн-комплект', 'Windows ARM64 · Offline bundle'],
    ['Android ARM64 · APK с локальным сервером', 'Android ARM64 · APK with local server'],
    ['Android x86_64 · APK с локальным сервером', 'Android x86_64 · APK with local server'],
  ] as const;
  const names = stablePlatforms.flatMap((platform) => stableAssetNames(platform, version));
  const tag = `v${version}`;
  const assets: (PublicReleaseFile & { label: string })[] = [];
  const notes = {
    en: '## Download\n\n',
    ru: '## Скачать\n\n',
  };

  for (const [index, name] of names.entries()) {
    const recorded = proof.assets[index];

    if (recorded?.name !== name) {
      throw new Error('github_asset_proof_invalid');
    }

    const local = await publicReleaseFile(directory, name);

    if (local.size !== recorded.size || local.sha256 !== recorded.sha256) {
      throw new Error(`github_asset_bytes_mismatch: ${name}`);
    }

    assets.push({
      ...local,
      label: labels[index]![0],
    });
  }

  let family = '';

  for (const index of [0, 1, 2, 4, 3, 5, 6, 7, 8]) {
    const [ru, en] = labels[index]!;
    const nextFamily = en.split(' ')[0]!;
    const url = `https://github.com/${repository}/releases/download/${tag}/${assets[index]!.name}`;

    if (nextFamily !== family) {
      family = nextFamily;
      notes.en += `\n### ${family}\n\n`;
      notes.ru += `\n### ${family}\n\n`;
    }

    notes.en += `- [${en}](${url})\n`;
    notes.ru += `- [${ru}](${url})\n`;
  }

  return {
    tag,
    assets,
    notes,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const [, , directory, proofFile, commit, version, repository, runId, planDigest, ...extra] = process.argv;

  if (!directory || !proofFile || !commit || !version || !repository
    || !runId || !planDigest || extra.length) {
    throw new Error('github_asset_arguments_invalid');
  }

  const proof = JSON.parse(await fs.readFile(proofFile, 'utf8'));
  const result = await prepareGithubRelease(directory, proof, {
    commit,
    version,
    repository,
    runId,
    planDigest,
  });

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
