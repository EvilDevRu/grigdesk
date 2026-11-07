import {
  DocumentsContractError,
  parseResolvedDocument,
} from '../../../../shared/plugins/documents/documentsContracts.ts';
import { contractDecoders } from '../../../../shared/lib/contractDecoders.ts';

const { record, text, numeric } = contractDecoders((path) => {
  throw new DocumentsContractError(path);
});

/**
 * Проверяет содержимое файла до публикации в просмотрщике.
 * Ссылка использует общий контракт; неизвестные расширения ответа сохраняются.
 */
export function parseDocumentFile(value: unknown) {
  const source = record(value, 'documentFile');
  const resolved = parseResolvedDocument(source);

  return {
    ...source,
    ...resolved,
    displayPath: text(source.displayPath, 'documentFile.displayPath'),
    content: text(source.content, 'documentFile.content'),
    size: numeric(source.size, 'documentFile.size'),
    modifiedAt: text(source.modifiedAt, 'documentFile.modifiedAt'),
  };
}

export type DocumentFile = ReturnType<typeof parseDocumentFile>;
