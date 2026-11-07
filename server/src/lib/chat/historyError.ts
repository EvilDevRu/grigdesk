export class ChatHistoryError extends Error {
  readonly code: string;

  readonly statusCode: number;

  readonly conflicts: unknown[];

  constructor(code: string, message: string, { statusCode = 409, conflicts = [] }: {
    statusCode?: number;
    conflicts?: unknown[];
  } = {}) {
    super(message);
    this.name = 'ChatHistoryError';
    this.code = code;
    this.statusCode = statusCode;
    this.conflicts = conflicts;
  }
}
