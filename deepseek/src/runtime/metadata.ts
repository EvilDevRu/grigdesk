import {
  decodeDeepSeekRuntimeInfo,
  type DeepSeekRuntimeInfo,
} from '../../../shared/chat/deepSeekBinary.ts';
import { canonicalJson } from '../../../shared/lib/canonicalJson.ts';
import { sha256 } from '../../../shared/node/hash.ts';

export type DeepSeekManifest = Omit<DeepSeekRuntimeInfo, 'packageId'> & Record<string, unknown>;

/**
 * Канонические bytes вычисляются сборщиком один раз и встраиваются в SEA без самоссылки.
 * При запуске достаточно сравнить SHA256 этих bytes с отдельным packageId asset.
 */
export function manifestBytes(manifest: Record<string, unknown>): string {
  const { packageId: _ignored, ...inputs } = manifest;

  return canonicalJson(inputs);
}

/**
 * Связывает всю поставку одним packageId без самоссылки.
 * Канонизация совпадает с прежним GLM-контрактом и сохраняет порядок массивов.
 */
export function packageIdFor(manifest: Record<string, unknown>): string {
  return sha256(manifestBytes(manifest));
}

/**
 * Добавляет packageId к публичному описанию и полному индексу поставки.
 * Не обращается к файлам, окружению или внешним процессам.
 */
export function createDeepSeekMetadata<T extends DeepSeekManifest>(manifest: T): T & { packageId: string } {
  const result = {
    ...manifest,
    packageId: packageIdFor(manifest),
  };

  decodeDeepSeekRuntimeInfo(result);

  return result;
}
