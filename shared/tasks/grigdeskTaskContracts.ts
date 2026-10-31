import { contractDecoders } from '../lib/contractDecoders.ts';

export interface GrigdeskTaskSummary {
  id: string;
  source: 'grigdesk';
  title: string;
  projectId: string;
  projectTitle: string;
  sourceUrl: string;
  createdAt: string;
}

export interface GrigdeskTask extends GrigdeskTaskSummary {
  description: string;
}

export interface GrigdeskTasksSnapshot {
  tasks: GrigdeskTaskSummary[];
  revision: number;
  trackerConfigured: boolean;
}

export interface GrigdeskTaskProject {
  id: string;
  title: string;
}

const d = contractDecoders((path) => {
  throw new Error(`Некорректные данные задачи GrigDesk: ${path}`);
});

const summaryFields = {
  id: d.text,
  source: d.oneOf('grigdesk'),
  title: d.text,
  projectId: d.text,
  projectTitle: d.text,
  sourceUrl: d.text,
  createdAt: d.text,
};
const summary = d.objectOf(summaryFields);
const task = d.objectOf({ ...summaryFields, description: d.text });
const snapshot = d.objectOf({
  tasks: d.listOf(summary),
  revision: d.wholeNumber,
  trackerConfigured: d.boolean,
});

/**
 * Собственная запись подтверждает источник и идентичность до попадания в кеш.
 * Повреждённый ответ не превращается в разрешение прочитать задачу портала.
 */
export function decodeGrigdeskTask(value: unknown, expectedId?: string): GrigdeskTask {
  const result = task(value, 'task');

  if (!/^[1-9]\d{11}$/.test(result.id) || (expectedId != null && result.id !== expectedId)
    || !result.title.trim() || !result.projectId || !result.projectTitle
    || !/^https?:\/\//.test(result.sourceUrl) || !Number.isFinite(Date.parse(result.createdAt))) {
    throw new Error('Некорректная запись задачи GrigDesk');
  }

  return result;
}

/**
 * Снимок проверяется целиком до замены списка интерфейса.
 * Ревизия позволяет отсечь ответ, начатый до успешного создания задачи.
 */
export function decodeGrigdeskTasksSnapshot(value: unknown): GrigdeskTasksSnapshot {
  return snapshot(value, 'snapshot');
}

/**
 * Ответ создания сохраняет ту же строгую запись, что возвращает чтение карточки.
 * Номер и ревизия принадлежат серверу, а не черновику формы.
 */
export function decodeGrigdeskTaskCreated(value: unknown): { task: GrigdeskTask; revision: number } {
  const source = d.record(value, 'created');

  return {
    task: decodeGrigdeskTask(source.task),
    revision: d.wholeNumber(source.revision, 'created.revision'),
  };
}

/**
 * Форма получает только доступные проекты с конвейером.
 * Их серверные идентификаторы не выводятся из видимого названия.
 */
export function decodeGrigdeskTaskProjects(value: unknown): GrigdeskTaskProject[] {
  const source = d.record(value, 'projects');

  return d.listOf(d.objectOf({ id: d.text, title: d.text }))(source.projects, 'projects');
}
