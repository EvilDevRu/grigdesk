// Транспорт просмотра документов.
//
// Абсолютный путь уходит на сервер один раз — чтобы получить взамен ссылку внутри
// разрешённого корня. Дальше раздел работает только ссылкой: так «открой соседний
// файл» физически не может стать «открой любой файл машины».

import { parseResolvedDocument } from '../../../shared/documentsContracts.ts';
import type { ResolvedDocument } from '../../../shared/documentsContracts.ts';
import { api } from './apiClient.ts';

export const documentsApi = {
  async resolve(absolutePath: string, scope = ''): Promise<ResolvedDocument> {
    const body = scope ? { path: absolutePath, scope } : { path: absolutePath };
    const value: unknown = await api.post('/api/documents/resolve', body);

    return parseResolvedDocument(value);
  },
};
