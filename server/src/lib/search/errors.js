export class KnowledgeError extends Error {
  constructor(message, { code, reasonCode, currentRevision, cause } = {}) {
    super(message, { cause });
    this.name = 'KnowledgeError';
    this.code = code;
    if (reasonCode) {
      this.reasonCode = reasonCode;
    }
    if (currentRevision !== undefined) {
      this.currentRevision = currentRevision;
    }
  }
}

export function unavailable(reasonCode, cause) {
  if (cause?.code === 'KNOWLEDGE_UNAVAILABLE') {
    return cause;
  }
  return new KnowledgeError('Хранилище знаний недоступно.', {
    code: 'KNOWLEDGE_UNAVAILABLE',
    reasonCode,
    cause,
  });
}

export function notFound() {
  return new KnowledgeError('Запись знаний не найдена.', { code: 'KNOWLEDGE_NOT_FOUND' });
}

export function conflict(currentRevision) {
  return new KnowledgeError('Запись уже изменена.', {
    code: 'KNOWLEDGE_CONFLICT',
    currentRevision,
  });
}

export function invalidArguments(message) {
  return new KnowledgeError(message, { code: 'KNOWLEDGE_INVALID_ARGUMENTS' });
}
