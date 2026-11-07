// Объявленные отказы раздела. Код, статус и текст для человека идут вместе: HTTP
// отвечает по коду, а формулировку не сочиняет заново — иначе один и тот же отказ
// звучал бы в ручке и в журнале по-разному.
//
// Чужое исключение своего кода не имеет и наружу текстом не уходит: в нём может
// быть путь файла или содержимое настроек.

export class ShowcaseError extends Error {
  code: string;

  status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'ShowcaseError';
    this.code = code;
    this.status = status;
  }
}

export function notFound(message: string): ShowcaseError {
  return new ShowcaseError('not_found', message, 404);
}

/**
 * Конфликт редакций. Человек мог править ролик во второй вкладке, поэтому его
 * правка не затирается: ответ несёт текущую редакцию, и интерфейс перечитывает
 * запись, а не отправляет своё состояние поверх чужого.
 */
export function revisionConflict(current: number): ShowcaseError {
  const error = new ShowcaseError(
    'revision_conflict',
    `Ролик изменился в другом месте: сейчас редакция ${current}.`,
    409,
  );

  return error;
}
