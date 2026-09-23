// Ошибки раздела «Проекты»: у отказа есть HTTP-статус и код для клиента.
//
// Отдельный класс нужен, чтобы обработчик не разбирал текст ошибки: статус и код —
// часть контракта §1.3, а `fieldErrors` и `currentRevision` доезжают до формы и
// позволяют ей показать подсказку у поля и предложить перечитать серверную версию.

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
