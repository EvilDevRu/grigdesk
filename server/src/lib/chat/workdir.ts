import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalizeChatWorkdir } from '../../../../shared/chat/chatWorkdir.ts';
import type { ChatWorkdir, WorkdirCapability } from '../../../../shared/chat/chatWorkdir.ts';
import { projectRepos, readProjectRecord, isProjectArchived, isProjectDeleted } from '../projects.ts';
import { listProjects } from '../profiles.ts';
import { parseSandboxRepositories } from '../sandboxEnv.ts';
import type { GrigDeskConfig } from '../../config.ts';
import type { ProjectsPrefsReader } from '../projects.ts';

export interface WorkdirValidation {
  error?: string;
  extraDirs: string[];
  rejected?: Array<{ path: string; reason: string; }>;
}

export type WorkdirValidator = (input: {
  config: unknown;
  cwd: string;
  extraDirs: string[];
}) => WorkdirValidation | Promise<WorkdirValidation>;

export interface ResolvedWorkdir {
  taskId: string | null;
  workdir: ChatWorkdir;
  provider: string;
  cwd: string;
  extraDirs: string[];
  source: string;
  label: string;
  copies: Array<{ key: string; path: string; }>;
  workspaceKey: string;
  warnings: string[];
}

export class ChatWorkdirError extends Error {
  code: string;
  statusCode: number;

  constructor(code: string, message: string, statusCode = 409) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * Каталог проверяется после realpath: симлинк не скрывает корень или весь home.
 * Проверка доступности не требует записи, поскольку чат может работать в режиме чтения.
 */
export async function validateWorkdirPath(input: string): Promise<string> {
  if (!path.isAbsolute(input) || /[\x00-\x1f]/u.test(input)) {
    throw new ChatWorkdirError('bad_workdir', 'Нужен абсолютный путь каталога.', 400);
  }

  try {
    const real = await fs.realpath(input);
    const home = await fs.realpath(os.homedir());

    if (real === path.parse(real).root || real === home) {
      throw new ChatWorkdirError('bad_workdir', 'Нельзя выбрать весь корень или домашний каталог.', 400);
    }
    if (!(await fs.stat(real)).isDirectory()) {
      throw new ChatWorkdirError('bad_workdir', 'Выбранный путь не является каталогом.', 400);
    }

    await fs.access(real, constants.R_OK | constants.X_OK);

    return real;
  } catch (error) {
    if (error instanceof ChatWorkdirError) {
      throw error;
    }

    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';

    throw new ChatWorkdirError(
      missing ? 'workdir_missing' : 'workdir_unavailable',
      `Каталог ${missing ? 'не найден' : 'недоступен'}: ${input}`,
    );
  }
}

/**
 * Capability разрешается одинаково в каталоге провайдеров и при запуске.
 * Отсутствующая либо сломанная декларация не обещает сохранение памяти при переходе.
 */
export async function resolveWorkdirCapability(adapter: {
  run?: unknown;
  workdir?: WorkdirCapability | ((config: unknown) => unknown);
} | null, config: unknown): Promise<WorkdirCapability | null> {
  if (!adapter || typeof adapter.run !== 'function') {
    return null;
  }

  try {
    const caps = (typeof adapter.workdir === 'function'
      ? await adapter.workdir(config)
      : adapter.workdir) as WorkdirCapability | undefined;

    return caps && ['resume', 'reseed'].includes(caps.switch) && ['single', 'multi'].includes(caps.roots)
      ? { switch: caps.switch, roots: caps.roots }
      : null;
  } catch {
    return null;
  }
}

/**
 * Источник выбирается одинаково для нового разговора и исторического чтения.
 * Рабочие копии задачи имеют приоритет над доверенным проектом и сохранённой папкой.
 */
export async function resolveWorkdirSource({ taskId, workdir, factoryState, trustedProject }: {
  taskId: string | null;
  workdir: ChatWorkdir;
  factoryState: { readEnv: (id: string) => Promise<unknown> };
  trustedProject: (id: string) => Promise<string | null>;
}) {
  let source: string = workdir.kind;
  let copies: ResolvedWorkdir['copies'] = [];
  let projectId = workdir.kind === 'project' ? workdir.projectId : '';
  let repoKey = workdir.kind === 'project' ? workdir.repoKey : null;

  if (taskId) {
    const env = await factoryState.readEnv(taskId);
    // Отсутствующий t<ID>.env адаптер представляет пустым объектом.
    // Непустой повреждённый реестр по-прежнему нельзя считать отсутствующим стендом.
    const absent = env !== null && typeof env === 'object'
      && !Array.isArray(env) && Object.keys(env).length === 0;
    const parsed = absent ? { kind: 'empty', repos: [] } : parseSandboxRepositories(env);

    if (parsed.kind === 'invalid') {
      throw new ChatWorkdirError('invalid_sandbox_env', 'Реестр рабочих копий задачи повреждён.');
    }

    copies = parsed.repos.map((repo) => ({ key: repo.name, path: repo.path }));

    if (copies.length) {
      source = 'task-copies';
    } else {
      const trusted = await trustedProject(taskId);

      if (trusted) {
        projectId = trusted;
        repoKey = null;
        source = 'task-project';
      }
    }
  }

  return {
    source,
    copies,
    projectId,
    repoKey,
  };
}

/**
 * Единый резолвер отделяет сохранённый выбор от реальных корней задачи/проекта.
 * Ни ошибка пути, ни ограничение single-root не разрешают расширить cwd до общего предка.
 */
export async function resolveChatWorkdir({
  taskId = null, workdir: value, provider, caps, validateWorkdir, config, prefs,
  factoryState, trustedProject, allowArchived = true, retainedProject,
}: {
  taskId?: string | null;
  workdir?: unknown;
  provider: string;
  caps: WorkdirCapability | null;
  validateWorkdir?: WorkdirValidator;
  config: GrigDeskConfig;
  prefs: ProjectsPrefsReader & { read?: () => { projects?: Record<string, unknown>; } | null; };
  factoryState: { readEnv: (id: string) => Promise<unknown>; };
  trustedProject: (id: string) => Promise<string | null>;
  allowArchived?: boolean;
  retainedProject?: {
    id: string;
    repos: import('../projects.ts').ProjectRepoRef[];
    defaultRepoKey: string | null;
  };
}): Promise<ResolvedWorkdir> {
  const workdir = normalizeChatWorkdir(value);

  if (!workdir) {
    throw new ChatWorkdirError('bad_workdir', 'Выбор рабочей папки повреждён.', 400);
  }

  let { source, copies, projectId, repoKey } = await resolveWorkdirSource({
    taskId,
    workdir,
    factoryState,
    trustedProject,
  });

  if (!copies.length && projectId) {
    const retained = retainedProject?.id === projectId ? retainedProject : null;
    const deleted = isProjectDeleted(prefs, projectId);
    const record = retained ?? readProjectRecord(prefs, projectId);
    const known = record || (await listProjects(config, prefs)).includes(projectId);

    if (!known || (deleted && !retained)) {
      throw new ChatWorkdirError('workdir_unknown_project', 'Проект рабочей папки больше не существует.');
    }
    if (!allowArchived && source !== 'task-project' && isProjectArchived(prefs, projectId)) {
      throw new ChatWorkdirError('workdir_archived_project', 'Для нового выбора нужен активный проект.');
    }

    const repos = retained?.repos ?? await projectRepos({
      config,
      prefs,
      id: projectId
    });

    if (!repos.length) {
      throw new ChatWorkdirError('workdir_no_repositories', 'В проекте не заданы репозитории.');
    }

    const key = repoKey ?? record?.defaultRepoKey ?? repos[0]!.key;
    const main = repos.find((repo) => repo.key === key);

    if (!main) {
      throw new ChatWorkdirError('workdir_unknown_repo', `Репозиторий ${key} отсутствует в проекте.`);
    }

    copies = [main, ...repos.filter((repo) => repo !== main)]
      .map((repo) => ({ key: repo.key, path: repo.dir }));
  }
  if (!copies.length) {
    copies = [{ key: workdir.kind, path: workdir.kind === 'path' ? workdir.path : config.rootDir }];
  }

  copies = await Promise.all(copies.map(async (copy) => ({
    ...copy,
    path: await validateWorkdirPath(copy.path),
  })));

  const cwd = copies[0]!.path;
  let extraDirs = [...new Set(copies.map((copy) => copy.path))].filter((dir) => dir !== cwd);
  const warnings: string[] = [];

  if (caps?.roots === 'single' && extraDirs.length) {
    warnings.push('Исполнитель пишет только в основной папке; для остальных требуется разрешение.');
  }
  if (validateWorkdir) {
    const validation = await validateWorkdir({
      config,
      cwd,
      extraDirs
    });

    if (validation.error) {
      throw new ChatWorkdirError('provider_workdir_denied', validation.error);
    }

    extraDirs = validation.extraDirs;
    warnings.push(...(validation.rejected || []).map((entry) => `${entry.path}: ${entry.reason}`));
  }

  const workspaceKey = createHash('sha256').update(JSON.stringify({
    version: 1,
    taskId,
    workdir,
    provider,
    caps,
    cwd,
    extraDirs,
    copies,
  })).digest('hex');

  return {
    taskId,
    workdir,
    provider,
    cwd,
    extraDirs,
    source,
    label: cwd,
    copies,
    workspaceKey,
    warnings
  };
}
