import { createPayloadCache, type ExtractionOptions } from '../../../shared/node/payloadCache.ts';
import * as codec from '../runtime/payloadIndex.ts';
import { dataHome, dataPath, type DataHomeInput } from '../../../shared/runtime/dataHome.ts';
import path from 'node:path';

export type { ExtractionOptions } from '../../../shared/node/payloadCache.ts';

/**
 * Некорректный cache не смешивается с ошибкой payload и сохраняет прежний код.
 * Вычисление default data-home остаётся только в адаптере DeepSeek.
 */
function invalidCache(): never {
  throw Object.assign(new Error('Кэш DeepSeek должен быть приватным каталогом владельца'), {
    code: 'deepseek_cache_invalid',
  });
}

function absoluteCache(value: string): string {
  if (!path.isAbsolute(value) || value === '/') {
    throw Object.assign(new Error('Кэш DeepSeek требует абсолютный путь'), {
      code: 'deepseek_cache_invalid',
    });
  }

  return value;
}

/**
 * Явный cache-dir имеет приоритет без fallback на cwd, DSH_HOME или родительский HOME.
 * Умолчание вычисляется только по запросу режима распаковки из общей папки данных.
 */
export function resolveExtractionCache(explicit: string | undefined, input: DataHomeInput): string {
  return absoluteCache(explicit ?? dataPath(dataHome(input), 'deepseekRuntime'));
}

const cache = createPayloadCache(codec, codec.invalidPayload, invalidCache);

/**
 * Прежний DeepSeek контракт требует согласованный marker и не восстанавливает его.
 * Файлы и полный verifier теперь общие с сервером, политика repair остаётся отдельной.
 */
export function materializePayload(options: ExtractionOptions): Promise<string> {
  return cache.materializePayload({ ...options, repairMarker: false });
}
