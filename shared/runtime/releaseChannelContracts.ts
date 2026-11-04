export interface ChannelCompat {
  os: 'linux';
  arch: 'x64';
  glibc: string;
}

export interface ChannelEntry {
  version: string;
  commit: string;
  archiveSha256: string;
  archiveSize: number;
  bundleSha256: string;
  signature: string;
  archiveUrl: string | null;
  compat: ChannelCompat;
}

export interface ChannelIndex {
  format: 1;
  latest: ChannelEntry | null;
  publishedAt: string;
}

export const RELEASE_CHANNEL_URLS = [
  'https://grigdesk.com/api/releases/v1/channel.json',
  'https://grigdesk.ru/api/releases/v1/channel.json',
] as const;

/**
 * Публичный ключ подписи релизов (SPKI PEM). Пустая строка — ключ ещё не задан владельцем:
 * проверка подписи обязана отказать с release_signing_key_missing, а не пропустить канал.
 */
export const RELEASE_SIGNING_PUBLIC_KEY = '';

const SEMVER_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const SIGNATURE_RE = /^[A-Za-z0-9+/]{86}==$/;
const ARCHIVE_URL_RE = /^https:\/\/[A-Za-z0-9.-]+\/releases\/[0-9.]+\/release\.tar\.gz$/;

/**
 * Канал и бинарная metadata используют один формат стабильной продуктовой версии.
 * Префиксы, ведущие нули и суффиксы не входят в канал автоматического обновления.
 */
export function isStableReleaseVersion(value: unknown): value is string {
  return typeof value === 'string' && SEMVER_RE.test(value);
}

/**
 * Строгий декодер записи канала: посторонние поля и ослабленные форматы отвергаются,
 * чтобы подпись и хеши всегда имели доказанную форму до передачи дальше.
 */
export function decodeChannelEntry(value: unknown): ChannelEntry {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Некорректная запись канала релизов');
  }

  const entry = value as Record<string, unknown>;
  const keys = ['version', 'commit', 'archiveSha256', 'archiveSize', 'bundleSha256',
    'signature', 'archiveUrl', 'compat'];

  for (const key of keys) {
    if (!(key in entry)) {
      throw new Error(`Запись канала не содержит ${key}`);
    }
  }
  if (Object.keys(entry).length !== keys.length) {
    throw new Error('Запись канала содержит посторонние поля');
  }
  if (!isStableReleaseVersion(entry.version)) {
    throw new Error('Некорректная версия в записи канала');
  }
  if (typeof entry.commit !== 'string' || !/^[0-9a-f]{40,64}$/.test(entry.commit)) {
    throw new Error('Некорректный commit в записи канала');
  }
  if (typeof entry.archiveSha256 !== 'string' || !SHA256_RE.test(entry.archiveSha256)) {
    throw new Error('Некорректный archiveSha256 в записи канала');
  }
  if (typeof entry.bundleSha256 !== 'string' || !SHA256_RE.test(entry.bundleSha256)) {
    throw new Error('Некорректный bundleSha256 в записи канала');
  }
  if (typeof entry.archiveSize !== 'number' || !Number.isSafeInteger(entry.archiveSize)
    || entry.archiveSize <= 0) {
    throw new Error('Некорректный размер архива в записи канала');
  }
  if (typeof entry.signature !== 'string' || !SIGNATURE_RE.test(entry.signature)) {
    throw new Error('Некорректная подпись в записи канала');
  }
  if (entry.archiveUrl !== null && (typeof entry.archiveUrl !== 'string'
    || !ARCHIVE_URL_RE.test(entry.archiveUrl))) {
    throw new Error('Некорректный адрес архива в записи канала');
  }
  if (typeof entry.compat !== 'object' || entry.compat === null
    || Object.keys(entry.compat as Record<string, unknown>).length !== 3) {
    throw new Error('Некорректная совместимость в записи канала');
  }

  const compat = entry.compat as Record<string, unknown>;

  if (compat.os !== 'linux' || compat.arch !== 'x64' || typeof compat.glibc !== 'string'
    || !/^\d+\.\d+$/.test(compat.glibc)) {
    throw new Error('Канал поддерживает только linux x64 с версионированным glibc');
  }

  return {
    version: entry.version,
    commit: entry.commit,
    archiveSha256: entry.archiveSha256,
    archiveSize: entry.archiveSize,
    bundleSha256: entry.bundleSha256,
    signature: entry.signature,
    archiveUrl: entry.archiveUrl,
    compat: {
      os: 'linux',
      arch: 'x64',
      glibc: compat.glibc
    },
  };
}

/**
 * Индекс канала декодируется целиком: format 1, latest допускает null (пустой канал),
 * publishedAt — строгий ISO, чтобы кеш мог отличать свежие данные от устаревших.
 */
export function decodeChannelIndex(value: unknown): ChannelIndex {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Некорректный индекс канала релизов');
  }

  const index = value as Record<string, unknown>;

  if (index.format !== 1 || typeof index.publishedAt !== 'string'
    || Number.isNaN(Date.parse(index.publishedAt))
    || new Date(index.publishedAt).toISOString() !== index.publishedAt
    || Object.keys(index).length !== 3) {
    throw new Error('Некорректный индекс канала релизов');
  }

  return {
    format: 1,
    latest: index.latest === null ? null : decodeChannelEntry(index.latest),
    publishedAt: index.publishedAt,
  };
}
