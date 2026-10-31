import { isRecord } from '../../../../shared/lib/objects.ts';
import type { GrigdeskTaskProject } from '../../../../shared/tasks/grigdeskTaskContracts.ts';
import type { ProjectsService } from '../../modules/projects/service.ts';
import { TICKET_LIMITS } from '../factoryTicket.ts';
import { GrigdeskTaskStore } from './store.ts';
import type { GrigdeskTasksConfig, TaskNumberProbe } from './numbers.ts';

export interface GrigdeskTasksServiceOptions {
  config: GrigdeskTasksConfig;
  tracker: TaskNumberProbe;
  projectsService: Pick<ProjectsService, 'list' | 'read' | 'withReferences'>;
  factoryState: {
    discoverProfiles(): string[];
    catalog(id: string): Promise<{ routes: string[] } | null>;
  };
}

export class GrigdeskTaskInputError extends Error {
  status = 400;
  code = 'bad_grigdesk_task';
}

/**
 * Origin приходит явно из окна: транспорт устройства может переписать Host и Origin.
 * Ссылка не загружается сервером и не принимает credentials или произвольный путь.
 */
function clientOrigin(value: unknown): string {
  if (typeof value !== 'string') {
    throw new GrigdeskTaskInputError('Не указан адрес интерфейса');
  }

  try {
    const url = new URL(value);

    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash || value !== url.origin
      || value.length + '/#/board?openTask='.length + 12 > TICKET_LIMITS.sourceUrl) {
      throw new Error('Некорректный origin');
    }

    return url.origin;
  } catch {
    throw new GrigdeskTaskInputError('Нужен http(s) origin интерфейса без пути');
  }
}

/**
 * Проект повторно читается под очередью ссылок непосредственно перед сохранением.
 * Отсутствующий профиль или пустой каталог не заменяются глобальным проектом.
 */
export function createGrigdeskTasksService(options: GrigdeskTasksServiceOptions) {
  const { config, tracker, projectsService, factoryState } = options;
  const store = new GrigdeskTaskStore({ config, tracker });

  /**
   * Проверяет выбранный проект по действующему реестру и опубликованному каталогу.
   * Архив и отсутствие профиля не допускают создание новой ссылки на конвейер.
   */
  async function project(id: string): Promise<GrigdeskTaskProject> {
    let selected;

    try {
      selected = await projectsService.read(id);
    } catch (error) {
      if ((error as { status?: number }).status === 404) {
        throw new GrigdeskTaskInputError('Проект недоступен');
      }

      throw error;
    }

    if (selected.archivedAt || !selected.profile.present || !factoryState.discoverProfiles().includes(id)
      || !(await factoryState.catalog(id))?.routes.length) {
      throw new GrigdeskTaskInputError('У проекта нет доступного конвейера');
    }

    return { id: selected.id, title: selected.title };
  }

  return {
    get: (id: string) => store.get(id),
    async list() {
      const { tasks, revision } = await store.list();

      return {
        tasks: tasks.map(({ description: _description, ...summary }) => summary),
        revision,
        trackerConfigured: tracker.isConfigured(),
      };
    },
    /**
     * Форма получает только проекты, которые прямо сейчас могут запускать задачи.
     * Ошибку инфраструктуры не скрываем за пустым списком доступных проектов.
     */
    async listProjects() {
      const projects: GrigdeskTaskProject[] = [];

      for (const entry of await projectsService.list()) {
        try {
          projects.push(await project(entry.id));
        } catch (error) {
          if (!(error instanceof GrigdeskTaskInputError)) {
            throw error;
          }
        }
      }

      return { projects };
    },
    /**
     * Клиент не задаёт номер, источник или ссылку на задачу.
     * Сервер валидирует поля и повторно проверяет проект под защитой ссылок.
     */
    async create(input: unknown) {
      if (!isRecord(input) || Object.keys(input).some((key) =>
        !['title', 'description', 'projectId', 'clientOrigin'].includes(key))
        || typeof input.title !== 'string' || !input.title.trim()
        || input.title.trim().length > TICKET_LIMITS.title || input.title.includes('\0')
        || typeof input.description !== 'string' || input.description.includes('\0')
        || input.description.length > TICKET_LIMITS.description || typeof input.projectId !== 'string') {
        throw new GrigdeskTaskInputError('Проверьте название, описание и проект');
      }

      const title = input.title.trim();
      const description = input.description;
      const projectId = input.projectId;
      const origin = clientOrigin(input.clientOrigin);

      return projectsService.withReferences(async () => {
        const selected = await project(projectId);

        return store.create({
          title,
          description,
          projectId: selected.id,
          projectTitle: selected.title,
          clientOrigin: origin,
        });
      });
    },
  };
}
