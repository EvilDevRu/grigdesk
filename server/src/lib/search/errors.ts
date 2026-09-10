export class KnowledgeError extends Error {
  code: string;

  reasonCode?: string;

  currentRevision?: number;

  constructor(message: string, { code, reasonCode, currentRevision, cause }: {
    code?: string;
    reasonCode?: string;
    currentRevision?: number;
    cause?: unknown;
  } = {}) {
    super(message, { cause });
    this.name = 'KnowledgeError';
    this.code = String(code);
    if (reasonCode) {
      this.reasonCode = reasonCode;
    }
    if (currentRevision !== undefined) {
      this.currentRevision = currentRevision;
    }
  }
}

export function unavailable(reasonCode: string, cause?: unknown): KnowledgeError {
  if ((cause as { code?: unknown } | null)?.code === 'KNOWLEDGE_UNAVAILABLE') {
    return cause as KnowledgeError;
  }
  return new KnowledgeError('Хранилище знаний недоступно.', {
    code: 'KNOWLEDGE_UNAVAILABLE',
    reasonCode,
    cause,
  });
}

export function notFound(): KnowledgeError {
  return new KnowledgeError('Запись знаний не найдена.', { code: 'KNOWLEDGE_NOT_FOUND' });
}

export function conflict(currentRevision: number): KnowledgeError {
  return new KnowledgeError('Запись уже изменена.', {
    code: 'KNOWLEDGE_CONFLICT',
    currentRevision,
  });
}

export function invalidArguments(message: string): KnowledgeError {
  return new KnowledgeError(message, { code: 'KNOWLEDGE_INVALID_ARGUMENTS' });
}
