// Ошибка проверенного файлового входа сохраняет только безопасные поля.
// HTTP адаптер отображает её код, ядру не нужны Fastify или приватные пути.
export class StudioHttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly extra: Record<string, unknown>;

  constructor(statusCode: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.extra = extra;
  }
}

