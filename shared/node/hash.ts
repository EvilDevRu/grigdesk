import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/**
 * Вычисляет полный SHA256 исходных байтов или UTF-8 строки.
 * Формат результата всегда lowercase hex; сериализация данных здесь не выполняется.
 */
export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Читает файл потоком, не удерживая большой архив в памяти.
 * Ошибка открытия или чтения передаётся вызывающему коду без подмены.
 */
export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');

  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
  }

  return hash.digest('hex');
}

/**
 * Возвращает первые 32 hex-символа SHA256 исходных байтов.
 * Сокращение используется для существующих идентификаторов, не для проверки архива.
 */
export function shortSha256(value: string | Uint8Array): string {
  return sha256(value).slice(0, 32);
}

/**
 * Хеширует ровно JSON.stringify: порядок ключей сохраняется и не канонизируется.
 * Циклы, BigInt и несериализуемый корень сохраняют исходный отказ сериализации/хеша.
 */
export function jsonHash32(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
}
