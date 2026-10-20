import {
  decodeServerBinaryInfo,
  type ServerBinaryInfo,
} from '../../../shared/runtime/serverBinary.ts';
import { canonicalJson } from '../../../shared/lib/canonicalJson.ts';
import { sha256 } from '../../../shared/node/hash.ts';
import { decodePayloadDescriptor, type PayloadDescriptor } from './payload.ts';

export interface ServerPackageManifest extends Record<string, unknown> {
  format: 1;
  hostContract: 1;
  version: '0.1.0';
  packagingVersion: 2;
  packageId: string;
  runtime: ServerBinaryInfo['runtime'];
  capabilities: ServerBinaryInfo['capabilities'];
  engine: ServerBinaryInfo['engine'];
  payload: PayloadDescriptor;
  launcher: { sha256: string };
  inputs: Record<string, string>;
}

/**
 * Полный manifest связывает bytes payload, launcher и хеши сборочных контрактов.
 * ELF SHA не включён: конечный файл хеширует установщик после внедрения SEA assets.
 */
export function createServerManifest(payload: PayloadDescriptor, input: {
  launcherSha256: string;
  engineSha256: string;
  buildInputs: Record<string, string>;
}): ServerPackageManifest {
  const manifest = {
    format: 1 as const,
    hostContract: 1 as const,
    version: '0.1.0' as const,
    packagingVersion: 2 as const,
    runtime: {
      node: '24.21.0',
      abi: '137',
      platform: 'linux',
      arch: 'x64',
    } as const,
    capabilities: ['api', 'ipc', 'helpers', 'engine'] as ServerBinaryInfo['capabilities'],
    engine: { protocol: 'route-v2', sha256: input.engineSha256 } as const,
    payload,
    launcher: { sha256: input.launcherSha256 },
    inputs: input.buildInputs,
  };

  return { ...manifest, packageId: packageIdFor(manifest) };
}

/**
 * Launcher сверяет canonical manifest с отдельным package-id asset до любых D/cache.
 * Приватный index декодируется полностью, публичная проекция строится отдельно.
 */
export function decodeServerManifest(bytes: string, packageId: string): ServerPackageManifest {
  const value = JSON.parse(bytes) as ServerPackageManifest;

  if (!/^[a-f0-9]{64}$/u.test(packageId) || sha256(bytes) !== packageId
    || serverManifestBytes(value) !== bytes || Object.hasOwn(value, 'packageId')) {
    throw Object.assign(new Error('Identity серверного ELF повреждена'), {
      code: 'server_metadata_invalid',
    });
  }

  const manifest = {
    ...value,
    payload: decodePayloadDescriptor(value.payload),
    packageId,
  };

  publicServerBinaryInfo({
    ...manifest,
    payload: {
      sha256: manifest.payload.sha256,
      size: manifest.payload.size,
      entryCount: manifest.payload.entries.length,
    },
  });

  if (!/^[a-f0-9]{64}$/u.test(manifest.launcher?.sha256)
    || !manifest.inputs || typeof manifest.inputs !== 'object'
    || Object.entries(manifest.inputs).some(([key, hash]) => key.startsWith('/')
      || key.split('/').includes('..') || !/^[a-f0-9]{64}$/u.test(hash))) {
    throw Object.assign(new Error('Входы серверной поставки повреждены'), {
      code: 'server_metadata_invalid',
    });
  }

  return manifest;
}

/**
 * Исключает только верхнюю самоссылку перед канонизацией полного manifest.
 * Launcher и приватный индекс остаются частью идентичности поставки.
 */
export function serverManifestBytes(manifest: Record<string, unknown>): string {
  const { packageId: _ignored, ...inputs } = manifest;

  return canonicalJson(inputs);
}

/**
 * Идентификатор связывает launcher и payload без зависимости от порядка ключей.
 * Массивы сохраняют порядок, верхнее поле packageId в хеш не входит.
 */
export function packageIdFor(manifest: Record<string, unknown>): string {
  return sha256(serverManifestBytes(manifest));
}

/**
 * Общий decoder собирает явную публичную проекцию и отбрасывает приватные поля.
 * Проверку SHA полного manifest launcher выполняет до вызова этой функции.
 */
export function publicServerBinaryInfo(value: unknown): ServerBinaryInfo {
  return decodeServerBinaryInfo(value);
}
