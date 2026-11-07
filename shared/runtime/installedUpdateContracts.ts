import { buildReleaseIdentity, type ReleaseChannel } from './productReleaseVersion.ts';

export interface ReleaseFile {
  path: string;
  size: number;
  sha256: string;
  mode: number;
}

export type ReleaseIdentity = ReturnType<typeof buildReleaseIdentity>;

export interface ReleaseArtifact {
  url: string;
  size: number;
  sha256: string;
  unpackedSize: number;
  files: ReleaseFile[];
  filesDigest: string;
  buildIdentity: ReleaseIdentity;
  packageId?: string;
}

export interface ReleasePayload extends ReleaseIdentity {
  publishedAt: string;
  notes: { ru: string; en: string } | null;
  dataCompatibility: 'unchanged-v1';
  serverApi: { major: number; minor: number };
  desktopRequiresServerApi: { major: number; minMinor: number };
  platform: {
    os: 'linux';
    arch: 'x64';
    glibc: string;
  };
  artifacts: { desktop: ReleaseArtifact; server: ReleaseArtifact };
}

export interface ReleaseEnvelope {
  payload: ReleasePayload;
  signature: string;
}

export interface ReleaseChannelIndex {
  format: 2;
  channel: ReleaseChannel;
  publishedAt: string;
  latest: ReleaseEnvelope | null;
}

/**
 * Декодер закрывает форму каждого объекта до проверки подписи.
 * Поля вне схемы не должны потеряться при канонизации подписанных данных.
 */
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) {
    throw new Error('release_manifest_invalid');
  }

  return value as Record<string, unknown>;
}

function hash(value: unknown): boolean {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function count(value: unknown, minimum = 0): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}

function iso(value: unknown): boolean {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString() === value;
}

/**
 * Подписанная опись разрешает только обычные файлы с относительными POSIX-путями.
 * Ссылки, специальные биты, дубликаты и расхождение общего размера отвергаются.
 */
function decodeArtifact(value: unknown, identity: ReleaseIdentity, server: boolean): ReleaseArtifact {
  const keys = ['url', 'size', 'sha256', 'unpackedSize', 'files', 'filesDigest', 'buildIdentity'];
  const source = object(value, server ? [...keys, 'packageId'] : keys);
  const build = object(source.buildIdentity, ['channel', 'version', 'commit', 'releaseId']);
  const url = typeof source.url === 'string' ? new URL(source.url) : null;

  if (!url || url.protocol !== 'https:' || url.username || url.password || url.hash
    || !count(source.size, 1) || !count(source.unpackedSize, 1) || !hash(source.sha256)
    || !hash(source.filesDigest) || (server && !hash(source.packageId))
    || Object.entries(identity).some(([key, part]) => build[key] !== part)
    || !Array.isArray(source.files) || source.files.length === 0 || source.files.length > 10000) {
    throw new Error('release_artifact_invalid');
  }

  const paths = new Set<string>();
  let total = 0;

  for (const entry of source.files) {
    const file = object(entry, ['path', 'size', 'sha256', 'mode']);

    if (typeof file.path !== 'string' || !/^[A-Za-z0-9_./-]+$/u.test(file.path)
      || file.path.split('/').some((part) => !part || part === '.' || part === '..')
      || paths.has(file.path) || !count(file.size) || !hash(file.sha256)
      || ![0o444, 0o555, 0o644, 0o755].includes(Number(file.mode))) {
      throw new Error('release_file_invalid');
    }

    paths.add(file.path);
    total += Number(file.size);
  }

  if (!Number.isSafeInteger(total) || total !== source.unpackedSize
    || [...paths].some((name) => name.split('/').slice(0, -1)
      .some((_, index, parts) => paths.has(parts.slice(0, index + 1).join('/'))))) {
    throw new Error('release_file_invalid');
  }

  return source as unknown as ReleaseArtifact;
}

/**
 * Format 2 имеет отдельный канал и подписывает описание вместе с обеими частями.
 * Этот разбор не устанавливает доверие: Node-потребитель обязан проверить Ed25519.
 */
export function decodeReleaseChannelIndex(value: unknown): ReleaseChannelIndex {
  const index = object(value, ['format', 'channel', 'publishedAt', 'latest']);

  if (index.format !== 2 || !['release', 'dev'].includes(String(index.channel)) || !iso(index.publishedAt)) {
    throw new Error('release_channel_invalid');
  }

  if (index.latest === null) {
    return index as unknown as ReleaseChannelIndex;
  }

  const envelope = object(index.latest, ['payload', 'signature']);
  const source = object(envelope.payload, ['channel', 'version', 'commit', 'releaseId',
    'publishedAt', 'notes', 'dataCompatibility', 'serverApi', 'desktopRequiresServerApi',
    'platform', 'artifacts']);
  const identity = buildReleaseIdentity(
    index.channel as ReleaseChannel, String(source.version), String(source.commit),
  );
  const api = object(source.serverApi, ['major', 'minor']);
  const requires = object(source.desktopRequiresServerApi, ['major', 'minMinor']);
  const platform = object(source.platform, ['os', 'arch', 'glibc']);
  const artifacts = object(source.artifacts, ['desktop', 'server']);

  if (source.channel !== identity.channel || source.releaseId !== identity.releaseId
    || !iso(source.publishedAt) || source.publishedAt !== index.publishedAt
    || source.dataCompatibility !== 'unchanged-v1' || !count(api.major) || !count(api.minor)
    || !count(requires.major) || !count(requires.minMinor) || platform.os !== 'linux'
    || platform.arch !== 'x64' || !/^\d+\.\d+$/u.test(String(platform.glibc))
    || typeof envelope.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/u.test(envelope.signature)) {
    throw new Error('release_manifest_invalid');
  }

  if (source.notes !== null) {
    const notes = object(source.notes, ['ru', 'en']);

    if ([notes.ru, notes.en].some((text) => typeof text !== 'string' || text.length > 16000)) {
      throw new Error('release_notes_invalid');
    }
  }

  decodeArtifact(artifacts.desktop, identity, false);
  decodeArtifact(artifacts.server, identity, true);

  return index as unknown as ReleaseChannelIndex;
}
