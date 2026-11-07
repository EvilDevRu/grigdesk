export type ReleaseChannel = 'release' | 'dev';

export interface ProductVersion {
  major: number;
  minor: number;
  patch: number;
  dev: number | null;
}

const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-dev\.(0|[1-9][0-9]*))?$/u;

/**
 * Продукт допускает только стабильный номер или нумерованный dev-выпуск.
 * Ограничение safe integer исключает неоднозначное сравнение больших номеров.
 */
export function parseProductVersion(value: unknown): ProductVersion | null {
  const match = typeof value === 'string' ? VERSION.exec(value) : null;

  if (!match || match.slice(1).some((part) => part !== undefined && !Number.isSafeInteger(Number(part)))) {
    return null;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    dev: match[4] === undefined ? null : Number(match[4]),
  };
}

/**
 * Сравнение числовое: dev.10 новее dev.9, стабильный выпуск новее своих dev.
 * Неверный номер не приравнивается к установленному и не разрешает downgrade.
 */
export function compareProductVersions(left: string, right: string): number {
  const a = parseProductVersion(left);
  const b = parseProductVersion(right);

  if (!a || !b) {
    throw new Error('release_version_invalid');
  }

  for (const field of ['major', 'minor', 'patch'] as const) {
    if (a[field] !== b[field]) {
      return a[field] < b[field] ? -1 : 1;
    }
  }

  if (a.dev === b.dev) {
    return 0;
  }

  if (a.dev === null || b.dev === null) {
    return a.dev === null ? 1 : -1;
  }

  return a.dev < b.dev ? -1 : 1;
}

/**
 * Identity вычисляется до сборки и одинакова у всех компонентов выпуска.
 * Digest подписанного описания вычисляется отдельно и в эту identity не входит.
 */
export function buildReleaseIdentity(channel: ReleaseChannel, version: string, commit: string) {
  const parsed = parseProductVersion(version);

  if (!['release', 'dev'].includes(channel) || !parsed
    || (channel === 'release' ? parsed.dev !== null : parsed.dev === null)
    || !/^[a-f0-9]{40,64}$/u.test(commit)) {
    throw new Error('release_identity_invalid');
  }

  return {
    channel,
    version,
    commit,
    releaseId: `${channel}/${version}/${commit}`,
  };
}
