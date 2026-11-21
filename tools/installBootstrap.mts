import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';

import { canonicalJson } from '../shared/lib/canonicalJson.ts';
import { shellQuote } from '../shared/lib/shellQuote.ts';
import { sha256 } from '../shared/node/hash.ts';
import { verifyReleaseEnvelope } from '../shared/node/releaseTrust.ts';
import { parseProductVersion } from '../shared/runtime/productReleaseVersion.ts';
import type { ReleaseEnvelope } from '../shared/runtime/installedUpdateContracts.ts';
import { verifyReleaseInstaller } from './installerProof.mts';

const BOOTSTRAP_LIMIT = 64 * 1024;
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const SHEBANG = '#!/bin/sh\n';
const MARKER = '# GRIGDESK_BOOTSTRAP:';

const PLACEHOLDERS = new Set(['VERSION', 'CHANNEL', 'ORIGIN', 'INDEX_SHA256', 'INDEX_SIZE',
  'HELPER_SHA256', 'HELPER_SIZE', 'COMPRESSED_SHA256', 'COMPRESSED_SIZE', 'LOCAL_BYTES',
  'REMOTE_BYTES', 'SERVER_BYTES', 'PLATFORM', 'DELIVERY']);

export interface BootstrapMetadata {
  format: 1;
  version: string;
  channel: 'release' | 'dev';
  origin: string;
  platform?: 'darwin-arm64';
  delivery?: 'candidate-file' | 'local-test';
  manifestDigest: string;
  indexSha256: string;
  indexSize: number;
  helperSha256: string;
  helperSize: number;
  compressedSha256: string;
  compressedSize: number;
  downloadBytes: {
    local: number;
    remote: number;
    server: number;
  };
}

export interface BootstrapMessages {
  ru: Record<string, string>;
  en: Record<string, string>;
}

export interface BootstrapTrust {
  envelope: ReleaseEnvelope;
  publicKey: string;
}

/**
 * Строки case собираются только из фиксированных ключей обоих каталогов.
 * Текст сообщения экранируется shellQuote и никогда не склеивается с кодом шаблона.
 */
function messageArms(messages: BootstrapMessages): string {
  const keys = [...new Set([...Object.keys(messages.ru), ...Object.keys(messages.en)])].sort();
  const arms: string[] = [];

  for (const key of keys) {
    for (const language of ['ru', 'en'] as const) {
      const text = messages[language][key];

      if (text === undefined) {
        continue;
      }

      arms.push(`    ${language}:${key}) printf '%s' ${shellQuote(text)} ;;`);
    }
  }

  return arms.join('\n');
}

/**
 * Шаблон получает значения только полной заменой placeholder-а с shellQuote.
 * Неизвестный placeholder — ошибка сборки, а не молчаливый остаток в скрипте.
 */
export function renderBootstrap(metadata: BootstrapMetadata, template: string,
  messages: BootstrapMessages): string {
  const values: Record<string, string> = {
    VERSION: metadata.version,
    CHANNEL: metadata.channel,
    ORIGIN: metadata.origin,
    PLATFORM: metadata.platform ?? 'linux-x64',
    DELIVERY: metadata.delivery ?? 'channel',
    INDEX_SHA256: metadata.indexSha256,
    INDEX_SIZE: String(metadata.indexSize),
    HELPER_SHA256: metadata.helperSha256,
    HELPER_SIZE: String(metadata.helperSize),
    COMPRESSED_SHA256: metadata.compressedSha256,
    COMPRESSED_SIZE: String(metadata.compressedSize),
    LOCAL_BYTES: String(metadata.downloadBytes.local),
    REMOTE_BYTES: String(metadata.downloadBytes.remote),
    SERVER_BYTES: String(metadata.downloadBytes.server),
  };

  if (!template.startsWith(SHEBANG)) {
    throw new Error('bootstrap_template_shebang_invalid');
  }

  let script = template.replace(/@@([A-Z_0-9]+)@@/gu, (whole, name: string) => {
    if (name === 'MESSAGES') {
      return messageArms(messages);
    }

    if (!PLACEHOLDERS.has(name) || values[name] === undefined) {
      throw new Error('bootstrap_placeholder_unknown:' + name);
    }

    return shellQuote(values[name]!);
  });

  script = SHEBANG + MARKER + canonicalJson(metadata) + '\n' + script.slice(SHEBANG.length);

  if (Buffer.byteLength(script, 'utf8') > BOOTSTRAP_LIMIT) {
    throw new Error('bootstrap_script_too_large');
  }

  return script;
}

/**
 * Схема metadata закрыта точным набором ключей и проверок без доверия к JSON.
 * Лишнее поле, не-число или не-SHA делают скрипт непригодным до любого запуска.
 */
function decodeBootstrapMetadata(value: unknown): BootstrapMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('bootstrap_metadata_invalid');
  }

  const record = value as Record<string, unknown>;
  const expected = ['channel', 'compressedSha256', 'compressedSize', 'downloadBytes', 'format',
    'helperSha256', 'helperSize', 'indexSha256', 'indexSize', 'manifestDigest', 'origin',
    'version', ...['platform', 'delivery'].filter((field) => Object.hasOwn(record, field))].sort().join(',');

  if (Object.keys(record).sort().join(',') !== expected || record.format !== 1
    || !['release', 'dev'].includes(record.channel as string)
    || Object.hasOwn(record, 'platform') && record.platform !== 'darwin-arm64'
    || Object.hasOwn(record, 'delivery')
      && !['candidate-file', 'local-test'].includes(String(record.delivery))) {
    throw new Error('bootstrap_metadata_invalid');
  }

  const origin = new URL(String(record.origin));

  if (origin.protocol !== 'https:' || origin.username || origin.password
    || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('bootstrap_metadata_invalid');
  }

  for (const key of ['indexSize', 'helperSize', 'compressedSize']) {
    const size = record[key];

    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) {
      throw new Error('bootstrap_metadata_invalid');
    }
  }

  for (const key of ['manifestDigest', 'indexSha256', 'helperSha256', 'compressedSha256']) {
    if (typeof record[key] !== 'string' || !SHA256_HEX.test(record[key] as string)) {
      throw new Error('bootstrap_metadata_invalid');
    }
  }

  if (typeof record.version !== 'string' || !parseProductVersion(record.version)
    || !record.downloadBytes || typeof record.downloadBytes !== 'object'
    || Array.isArray(record.downloadBytes)) {
    throw new Error('bootstrap_metadata_invalid');
  }

  const downloadBytes = record.downloadBytes as Record<string, unknown>;

  if (Object.keys(downloadBytes).sort().join(',') !== 'local,remote,server') {
    throw new Error('bootstrap_metadata_invalid');
  }

  for (const mode of ['local', 'remote', 'server']) {
    const bytes = downloadBytes[mode];

    if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes <= 0) {
      throw new Error('bootstrap_metadata_invalid');
    }
  }

  return record as unknown as BootstrapMetadata;
}

/**
 * Metadata читается только из первой после shebang строки и никогда не исполняется.
 * Повтор маркера где-либо ещё в файле делает скрипт непригодным целиком.
 */
export function readBootstrap(script: string | Buffer): BootstrapMetadata {
  const text = Buffer.isBuffer(script) ? script.toString('utf8') : script;

  if (Buffer.byteLength(text, 'utf8') > BOOTSTRAP_LIMIT || !text.startsWith(SHEBANG)) {
    throw new Error('bootstrap_script_invalid');
  }

  const lines = text.split('\n');
  const occurrences = text.split(MARKER).length - 1;

  if (occurrences !== 1 || !lines[1]!.startsWith(MARKER)) {
    throw new Error('bootstrap_metadata_missing');
  }

  return decodeBootstrapMetadata(JSON.parse(lines[1]!.slice(MARKER.length)));
}

/**
 * Gzip проверяется потоком: SHA и размер считаются на лету, лимит helperSize
 * останавливает распаковку до исчерпания памяти. На диск поток не пишется.
 */
async function verifyHelperGunzip(file: string, metadata: BootstrapMetadata): Promise<void> {
  const stat = await fs.lstat(file);

  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== metadata.compressedSize) {
    throw new Error('installer_helper_integrity_invalid');
  }

  const compressedHash = createHash('sha256');
  const rawHash = createHash('sha256');
  let compressedSize = 0;
  let rawSize = 0;
  let overflow = false;

  await new Promise<void>((resolve, reject) => {
    const source = createReadStream(file);
    const gunzip = createGunzip();
    const fail = (error: Error) => {
      source.destroy();
      gunzip.destroy();
      reject(error);
    };

    source.on('error', fail);
    gunzip.on('error', () => fail(new Error('installer_helper_integrity_invalid')));
    source.on('data', (chunk: string | Buffer) => {
      compressedHash.update(chunk);
      compressedSize += Buffer.byteLength(chunk);
    });
    gunzip.on('data', (chunk: Buffer) => {
      if (overflow) {
        return;
      }

      rawHash.update(chunk);
      rawSize += chunk.length;

      if (rawSize > metadata.helperSize) {
        overflow = true;
        resolve();
        source.destroy();
        gunzip.destroy();
      }
    });
    gunzip.on('close', () => resolve());
    source.pipe(gunzip);
  });

  if (overflow || compressedSize !== metadata.compressedSize
    || compressedHash.digest('hex') !== metadata.compressedSha256
    || rawSize !== metadata.helperSize || rawHash.digest('hex') !== metadata.helperSha256) {
    throw new Error('installer_helper_integrity_invalid');
  }
}

/**
 * Заявленные объёмы загрузки обязаны сходиться к подписанным размерам индекса,
 * helper и архивов выбранного режима. Расхождение ловится до публикации.
 */
function assertDownloadBytes(metadata: BootstrapMetadata, envelope: ReleaseEnvelope): void {
  const artifacts = envelope.payload.artifacts;
  const base = metadata.indexSize + metadata.compressedSize + (artifacts.control?.size ?? 0);
  const expected = {
    local: base + artifacts.desktop.size + artifacts.server.size,
    remote: base + artifacts.desktop.size,
    server: base + artifacts.server.size,
  };

  for (const mode of ['local', 'remote', 'server'] as const) {
    if (metadata.downloadBytes[mode] !== expected[mode]) {
      throw new Error('bootstrap_download_bytes_invalid');
    }
  }
}

/**
 * Единая точка доверия установщика: подпись скрипта, его metadata и фактические
 * байты helper/индекса проверяются до любого исполнения или загрузки архивов.
 */
export async function verifyBootstrapFiles(directory: string,
  trust: BootstrapTrust): Promise<BootstrapMetadata> {
  const channel = trust.envelope.payload.channel;
  const scriptFile = path.join(directory, 'grigdesk-install');
  const scriptStat = await fs.lstat(scriptFile);

  if (!scriptStat.isFile() || scriptStat.isSymbolicLink() || scriptStat.size > BOOTSTRAP_LIMIT) {
    throw new Error('bootstrap_script_invalid');
  }

  const script = await fs.readFile(scriptFile, 'utf8');
  const proof = await fs.readFile(path.join(directory, 'grigdesk-install.sha256'), 'utf8');
  const signature = await fs.readFile(path.join(directory, 'grigdesk-install.sig'), 'utf8');

  await verifyReleaseInstaller(scriptFile, trust.envelope, proof, signature, trust.publicKey);

  const metadata = readBootstrap(script);
  const indexFile = path.join(directory, `${channel}.json`);
  const indexStat = await fs.lstat(indexFile);

  if (!indexStat.isFile() || indexStat.isSymbolicLink() || indexStat.size !== metadata.indexSize) {
    throw new Error('bootstrap_index_integrity_invalid');
  }

  const indexBytes = await fs.readFile(indexFile);

  if (metadata.channel !== channel || metadata.version !== trust.envelope.payload.version
    || metadata.platform !== (trust.envelope.payload.platform.os === 'darwin' ? 'darwin-arm64' : undefined)
    || metadata.manifestDigest !== verifyReleaseEnvelope(trust.envelope, trust.publicKey)) {
    throw new Error('bootstrap_metadata_mismatch');
  }

  if (indexBytes.length !== metadata.indexSize || sha256(indexBytes) !== metadata.indexSha256) {
    throw new Error('bootstrap_index_integrity_invalid');
  }

  await verifyHelperGunzip(path.join(directory, 'grigdesk-maintenance.gz'), metadata);
  assertDownloadBytes(metadata, trust.envelope);

  return metadata;
}
