import { contractDecoders } from '../lib/contractDecoders.ts';

const decode = contractDecoders(invalidMetadata);
const requiredCapabilities = ['api', 'ipc', 'helpers', 'engine'] as const;
const decodeInfo = decode.objectOf({
  format: decode.oneOf(1),
  hostContract: decode.oneOf(1),
  version: decode.oneOf('0.1.0'),
  packagingVersion: decode.oneOf(2),
  packageId: sha256Text,
  runtime: decode.objectOf({
    node: decode.oneOf('24.21.0'),
    abi: decode.oneOf('137'),
    platform: decode.oneOf('linux'),
    arch: decode.oneOf('x64'),
  }),
  capabilities: decode.listOf(decode.oneOf(...requiredCapabilities)),
  engine: decode.objectOf({
    protocol: decode.oneOf('route-v2'),
    sha256: sha256Text,
  }),
  payload: decode.objectOf({
    sha256: sha256Text,
    size: decode.wholeNumber,
    entryCount: decode.wholeNumber,
  }),
});

export type ServerBinaryInfo = ReturnType<typeof decodeInfo>;

/**
 * Отказ называет только поле публичного контракта, без недоверенных значений.
 * Ни приватный индекс, ни локальные пути не попадают в текст ошибки.
 */
function invalidMetadata(field: string): never {
  throw Object.assign(new Error(`Некорректное описание сервера: ${field}`), {
    code: 'server_metadata_invalid',
  });
}

/**
 * Полные SHA256 нужны для проверки совместимости поставки с потребителем.
 * Декодирование формы не заменяет проверку фактических байтов manifest.
 */
function sha256Text(value: unknown, field: string): string {
  const result = decode.text(value, field);

  if (!/^[a-f0-9]{64}$/u.test(result)) {
    invalidMetadata(field);
  }

  return result;
}

/**
 * Собирает только объявленные публичные поля без приватного индекса и путей.
 * Все четыре возможности обязательны, неизвестные и повторные отвергаются.
 */
export function decodeServerBinaryInfo(value: unknown): ServerBinaryInfo {
  const info = decodeInfo(value, 'runtime-info');

  if (info.capabilities.length !== requiredCapabilities.length
    || new Set(info.capabilities).size !== requiredCapabilities.length) {
    invalidMetadata('runtime-info.capabilities');
  }

  return info;
}
