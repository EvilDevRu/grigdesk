// Транспорт раздела «Проекты».
//
// Сеть отдаёт `unknown`; форму подтверждает декодер раздела. Заведение проекта идёт
// в профили фабрики, а пути — в реестр проектов: это два разных ресурса, и раздел
// не должен склеивать их в одну «сохранить всё» операцию.

import { parseProjectList } from '../../../shared/projectsContracts.ts';
import type { Project, ProjectRepoInput } from '../../../shared/projectsContracts.ts';
import { api } from './apiClient.ts';

export const projectsApi = {
  async list(): Promise<Project[]> {
    const value: unknown = await api.get('/api/projects');

    return parseProjectList(value);
  },

  /** Заводит проект. Пути у него появятся отдельным сохранением — ради них он и нужен. */
  async create(id: string): Promise<void> {
    await api.post('/api/profiles', { id });
  },

  async saveRepos(id: string, repos: ProjectRepoInput[]): Promise<void> {
    await api.put(`/api/projects/${encodeURIComponent(id)}`, { repos });
  },
};
