import { createPayloadCache, type ExtractionOptions } from '../../../shared/node/payloadCache.ts';
import { dataHome, dataPath, type DataHomeInput } from '../../../shared/runtime/dataHome.ts';
import * as codec from './payload.ts';

export type { ExtractionOptions } from '../../../shared/node/payloadCache.ts';

/**
 * Сервер допускает только приватный кэш владельца с абсолютным путём.
 * Неверный путь не подменяется рабочей папкой или fallback из окружения.
 */
function invalidCache(): never {
  throw Object.assign(new Error('Кэш сервера должен быть приватным каталогом владельца'), {
    code: 'server_cache_invalid',
  });
}

const cache = createPayloadCache(codec, codec.invalidPayload, invalidCache);

/**
 * Один источник cache/lease/pin исключает обход сборщика мусора другим каталогом.
 * Публичного cache override нет; путь выводится из проверенной папки данных.
 */
export function resolveServerCache(input: DataHomeInput): string {
  return dataPath(dataHome(input), 'serverRuntime');
}

/**
 * Сервер восстанавливает повреждённый marker только после полной проверки payload.
 * Готовое повреждённое поколение сохраняется и даёт именованный отказ без удаления.
 */
export function materializePayload(options: ExtractionOptions): Promise<string> {
  return cache.materializePayload({ ...options, repairMarker: true });
}
