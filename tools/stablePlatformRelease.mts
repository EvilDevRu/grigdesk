import { buildReleaseIdentity, parseProductVersion } from '../shared/runtime/productReleaseVersion.ts';

export const stablePlatforms = [
  'linux-x64', 'darwin-arm64', 'linux-arm64', 'windows-x64',
  'windows-arm64', 'android-arm64', 'android-x86_64',
] as const;

export type StablePlatform = typeof stablePlatforms[number];

interface StablePlatformInput {
  platforms: string[];
  publish: boolean;
  testMode: string;
  reason: string;
  validationRun: string;
  attempt: string;
  runNumber: string;
  version: string;
  commit: string;
}

/**
 * Разрешает только полный стабильный запуск. Предыдущий номер используется
 * исключительно в закрытой проверке установки и обновления.
 */
export function resolveStablePlatformRelease(input: StablePlatformInput) {
  if (JSON.stringify(input.platforms) !== JSON.stringify(stablePlatforms)
    || input.publish || input.testMode !== 'full' || input.reason !== ''
    || input.validationRun !== '' || input.attempt !== '1'
    || !/^[1-9]\d*$/u.test(input.runNumber)
    || !Number.isSafeInteger(2 * Number(input.runNumber))
    || !/^[a-f0-9]{40}$/u.test(input.commit)) {
    throw new Error('stable_platform_input_invalid');
  }

  const number = parseProductVersion(input.version);

  if (!number || number.dev !== null || !number.major && !number.minor && !number.patch) {
    throw new Error('stable_platform_version_invalid');
  }

  const { major, minor, patch } = number;
  const older = patch > 0 ? [major, minor, patch - 1]
    : minor > 0 ? [major, minor - 1, 0] : [major - 1, 0, 0];

  return {
    platforms: [...stablePlatforms],
    current: buildReleaseIdentity('release', input.version, input.commit),
    previous: buildReleaseIdentity('release', older.join('.'), input.commit),
    androidPrevious: buildReleaseIdentity('dev',
      `${input.version}-dev.${2 * Number(input.runNumber) - 1}`, input.commit),
  };
}

/**
 * Проверочный Android A использует зарезервированный dev-номер для APK.
 * Остальные платформы готовят обновление внутри стабильного канала.
 */
export function previousStablePlatformIdentity(plan: ReturnType<typeof resolveStablePlatformRelease>,
  platform: StablePlatform) {
  return platform === 'android-arm64' || platform === 'android-x86_64'
    ? plan.androidPrevious : plan.previous;
}

/**
 * Связывает каждую платформу с точными файлами публичной выдачи. Манифест
 * и подписи остаются в архиве и сохраняют их локальные имена.
 */
export function stableAssetNames(platform: StablePlatform, version: string): string[] {
  if (platform === 'linux-x64') {
    return [
      'grigdesk-install',
      `grigdesk-${version}-linux-x64-offline.zip`,
      `grigdesk_${version}_amd64.deb`,
    ];
  }

  if (platform === 'android-arm64' || platform === 'android-x86_64') {
    return [`grigdesk-${version}-${platform}.apk`];
  }

  const name = platform === 'darwin-arm64' ? 'macos-arm64' : platform;

  return [`grigdesk-${version}-${name}-offline.zip`];
}

type PublicFile = {
  name: string;
  size: number;
  sha256: string;
};

export interface StableAssetPart {
  platform: StablePlatform;
  version: string;
  commit: string;
  channel: 'release';
  runId: string;
  planDigest: string;
  assets: PublicFile[];
}

/**
 * Общее доказательство допускает строго семь уникальных целей одного run.
 * Хеш каждого выходного файла должен прийти из проверившего его job.
 */
export function collectStableAssetProof(
  expected: {
    version: string;
    commit: string;
    runId: string;
    planDigest: string;
  },
  parts: StableAssetPart[],
) {
  const hex = /^[a-f0-9]{64}$/u;

  if (parts.length !== stablePlatforms.length
    || !/^[1-9]\d*$/u.test(expected.runId)
    || !hex.test(expected.planDigest)
    || !/^[a-f0-9]{40}$/u.test(expected.commit)) {
    throw new Error('stable_asset_matrix_invalid');
  }

  const assets = stablePlatforms.flatMap((platform) => {
    const matches = parts.filter((part) => part.platform === platform);
    const part = matches[0];
    const names = stableAssetNames(platform, expected.version);

    if (matches.length !== 1 || !part || part.channel !== 'release'
      || part.version !== expected.version || part.commit !== expected.commit
      || part.runId !== expected.runId || part.planDigest !== expected.planDigest
      || !Array.isArray(part.assets) || part.assets.length !== names.length
      || names.some((name, index) => {
        const file = part.assets[index];

        return !file || file.name !== name || !hex.test(file.sha256)
          || !Number.isSafeInteger(file.size) || file.size < 1 || file.size >= 2 * 1024 ** 3;
      })) {
      throw new Error('stable_asset_part_invalid: ' + platform);
    }

    return part.assets;
  });

  return {
    ...expected,
    channel: 'release' as const,
    signatureValid: true,
    assets,
  };
}
