import { Unzip, UnzipInflate } from 'fflate';

import { createPayloadCodec } from '../../../shared/node/payloadArchive.ts';
import type { PayloadZipFactory, PayloadZipFile } from '../../../shared/node/payloadArchive.ts';

/**
 * Только пакет знает fflate; общий код получает ограниченный потоковый port.
 * Прокладка ondata сохраняет точный callback protocol без type cast всей библиотеки.
 */
const makeUnzip: PayloadZipFactory = (onFile) => {
  const zip = new Unzip((file) => {
    const port: PayloadZipFile = {
      name: file.name,
      start: () => file.start(),
    };

    file.ondata = (error, bytes, final) => port.ondata?.(error, bytes, final);
    onFile(port);
  });

  zip.register(UnzipInflate);

  return { push: (bytes, final) => zip.push(bytes, final) };
};

/**
 * Ошибка архива не раскрывает исходные пути сборки или сырые filesystem details.
 * Один код используется до распаковки и при нарушении индекса во время чтения ZIP.
 */
export function invalidPayload(): never {
  throw Object.assign(new Error('Индекс или архив поставки DeepSeek повреждён'), {
    code: 'deepseek_payload_invalid',
  });
}

const codec = createPayloadCodec(invalidPayload, makeUnzip);

export const decodePayloadIndex = codec.decodePayloadIndex;
export const decodePayloadDescriptor = codec.decodePayloadDescriptor;
export const consumePayloadArchive = codec.consumePayloadArchive;

export type { PayloadEntry, PayloadDescriptor, PayloadSink } from '../../../shared/node/payloadArchive.ts';
