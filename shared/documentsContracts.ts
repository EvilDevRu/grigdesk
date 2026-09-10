// Контракт просмотра документов.
//
// Наружу уходит ССЫЛКА (источник + относительный путь), а не абсолютный путь на диске:
// абсолютный путь означал бы, что из браузера можно попросить любой файл сервера.
// Разрешение абсолютного пути в ссылку делает сервер и только внутри своих корней.

import { contractDecoders } from './contractDecoders.ts';

export class DocumentsContractError extends Error {
  constructor(path: string) {
    super(`Некорректный ответ раздела документов: поле ${path}`);
    this.name = 'DocumentsContractError';
  }
}

const { objectOf, text } = contractDecoders((path) => {
  throw new DocumentsContractError(path);
});

// Ссылка на документ: только id корня и путь внутри него.
const documentRef = objectOf({
  source: text,
  path: text,
});

const resolvedDocument = objectOf({
  ref: documentRef,
  name: text,
  format: text,
  source: objectOf({
    id: text,
    label: text,
  }),
});

export type DocumentRef = ReturnType<typeof documentRef>;
export type ResolvedDocument = ReturnType<typeof resolvedDocument>;

export function parseResolvedDocument(value: unknown): ResolvedDocument {
  return resolvedDocument(value, 'documentResolve');
}
