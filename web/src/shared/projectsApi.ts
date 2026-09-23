// Транспорт раздела «Проекты».
//
// Сеть отдаёт `unknown`; форму подтверждает декодер раздела, и только после этого
// данные попадают в состояние. Отказ сервера приходит телом §1.2: его разбирает
// `projectsErrorData`, а форма по `fieldErrors` ставит подсказки у своих полей.

import { api } from './apiClient.ts';
import {
  parseProjectDependencies,
  parseProjectDetail,
  parseProjectSummaries,
  parseProjectsError,
  parseRepositoryCheck,
} from '../../../shared/projectsContracts.ts';
import type {
  ProjectDependencies,
  ProjectDetail,
  ProjectInput,
  ProjectRepositoryCheck,
  ProjectSummary,
  ProjectsErrorBody,
} from '../../../shared/projectsContracts.ts';

export const projectsApi = {
  async list(): Promise<ProjectSummary[]> {
    const value: unknown = await api.get('/api/projects');

    return parseProjectSummaries(value);
  },

  async detail(id: string): Promise<ProjectDetail> {
    const value: unknown = await api.get(`/api/projects/${encodeURIComponent(id)}`);

    return parseProjectDetail(value);
  },

  async create(input: ProjectInput): Promise<ProjectDetail> {
    const value: unknown = await api.post('/api/projects', input);

    return parseProjectDetail(value);
  },

  async update(id: string, input: ProjectInput): Promise<ProjectDetail> {
    const value: unknown = await api.put(`/api/projects/${encodeURIComponent(id)}`, input);

    return parseProjectDetail(value);
  },

  /** Связи проекта: их показывает раздел «Управление» перед архивом. */
  async dependencies(id: string): Promise<ProjectDependencies> {
    const value: unknown = await api.get(`/api/projects/${encodeURIComponent(id)}/dependencies`);

    return parseProjectDependencies(value);
  },

  async archive(id: string, expectedRevision: number): Promise<ProjectDetail> {
    const value: unknown = await api.post(
      `/api/projects/${encodeURIComponent(id)}/archive`,
      { expectedRevision },
    );

    return parseProjectDetail(value);
  },

  async restore(id: string, expectedRevision: number): Promise<ProjectDetail> {
    const value: unknown = await api.post(
      `/api/projects/${encodeURIComponent(id)}/restore`,
      { expectedRevision },
    );

    return parseProjectDetail(value);
  },

  /** Проверка путей без сохранения: паспорт при ней не меняется. */
  async check(dirs: string[]): Promise<ProjectRepositoryCheck> {
    const value: unknown = await api.post('/api/project-tools/repositories/check', {
      repos: dirs.map((dir) => ({ dir })),
    });

    return parseRepositoryCheck(value);
  },
};

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

/**
 * Тело отказа раздела. У `ApiError` в `data` лежит сырой ответ сети, и пока его форма
 * не подтверждена декодером, показывать по нему подсказки у полей нельзя. Пустое или
 * чужое тело — тоже не отказ контракта: просто «подробностей нет».
 */
export function projectsErrorData(error: unknown): ProjectsErrorBody | null {
  const data = asRecord(error).data;

  if (data === null || data === undefined) {
    return null;
  }

  try {
    return parseProjectsError(data);
  } catch {
    return null;
  }
}

/**
 * Текст отказа для человека: серверная формулировка точнее любой запасной.
 * Разобранное тело важнее `message` самого Error — оно называет причину и поля.
 */
export function projectsFailureText(error: unknown, fallback: string): string {
  const body = projectsErrorData(error);

  if (body?.message) {
    return body.message;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return fallback;
}
