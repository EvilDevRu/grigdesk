import fs from 'node:fs';
import path from 'node:path';

import { runtimeInstallationBin, runtimeKind } from '../runtimePaths.ts';

interface DeepSeekDeliveryConfig {
  deepseekBin?: string;
  deepseekBinOverride?: string;
  deepseekRuntimeMode?: string;
  rootDir?: string;
  installationBin?: string;
}

/**
 * Способ доставки определяется серверной конфигурацией без проверки файлов.
 * Явный override также требует metadata автономной поставки.
 */
export function usesDeepSeekBinary(_config: DeepSeekDeliveryConfig): boolean {
  return true;
}

/**
 * Выбранный путь возвращается без stat, запуска процесса или поиска CLI в PATH.
 * Проверка абсолютности и executable принадлежит async resolver.
 */
export function selectedDeepSeekBinary(config: DeepSeekDeliveryConfig): string {
  const sourceBin = runtimeKind() === 'source' && config.rootDir && path.isAbsolute(config.rootDir)
    ? path.join(config.rootDir, 'bin') : undefined;
  const bin = config.installationBin ?? sourceBin ?? runtimeInstallationBin();

  return config.deepseekBinOverride || config.deepseekBin || path.join(bin, 'deepseek');
}

/**
 * Единственный способ доставки объявлен marker независимого бинарного пакета.
 * Повреждённый marker не разрешает fallback на stock CLI или исходники Harness.
 */
export function deepSeekDistributionMode(file: string): 'binary' {
  const contract = JSON.parse(fs.readFileSync(file, 'utf8'));

  if (contract.format !== 1 || contract.publishContract !== 2
      || contract.mode !== 'binary') {
    throw new Error('Повреждён контракт поставки DeepSeek');
  }

  return contract.mode;
}
