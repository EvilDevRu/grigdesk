// Ошибки раздела «Проекты»: у отказа есть HTTP-статус и код для клиента.
//
// Отдельный класс нужен, чтобы обработчик не разбирал текст ошибки: статус и код —
// часть контракта §1.3, а `fieldErrors` и `currentRevision` доезжают до формы и
// позволяют ей показать подсказку у поля и предложить перечитать серверную версию.

import { errorText } from '../../../../shared/lib/errors.ts';
import { PrefsCorruptedError } from '../../lib/prefsStore.ts';

export interface ProjectFieldErrorBody {
  path: string;
  message: string;
}

export interface ProjectsErrorExtras {
  fieldErrors?: ProjectFieldErrorBody[];
  currentRevision?: number;
}

export class ProjectsError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fieldErrors?: ProjectFieldErrorBody[];
  readonly currentRevision?: number;

  constructor(
    status: number,
    code: string,
    message: string,
    extras: ProjectsErrorExtras = {},
  ) {
    super(message);
    this.name = 'ProjectsError';
    this.status = status;
    this.code = code;
    this.fieldErrors = extras.fieldErrors;
    this.currentRevision = extras.currentRevision;
  }
}

/**
 * Название фазы закрепляется там, где произошёл отказ, и сохраняется во внешних обёртках.
 * Нечитаемые настройки остаются исходной ошибкой для прежнего кода prefs_corrupted.
 */
export function projectDeletionError(
  phase: 'снимок корней' | 'настройки чатов' | 'запись регистрации',
  cause: unknown,
): Error {
  if (cause instanceof PrefsCorruptedError
    || (cause instanceof ProjectsError && cause.code === 'deletion_incomplete')) {
    return cause;
  }

  const failure = new ProjectsError(500, 'deletion_incomplete',
    `Удаление не завершено на шаге «${phase}»: ${errorText(cause)}`);

  failure.cause = cause;

  return failure;
}
