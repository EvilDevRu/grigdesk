import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { OnboardingError, decodeOnboardingDraft } from '../../../../shared/runtime/onboardingContracts.ts';
import type {
  OnboardingDocument, OnboardingSession, OnboardingState,
} from '../../../../shared/runtime/onboardingContracts.ts';
import type { ProjectInput } from '../../../../shared/runtime/projectsContracts.ts';
import type { PrefsStore } from '../prefsStore.ts';
import { isProjectDeleted } from '../projects.ts';
import { listFactoryProfiles, listProjects } from '../profiles.ts';
import type { ProjectsService } from '../../modules/projects/service.ts';
import { inspectRepository } from './repositories.ts';
import { OnboardingStore } from './store.ts';

export interface OnboardingOptions {
  config: { dataStateDir: string; profilesDir: string };
  prefs: PrefsStore;
  projectsService: ProjectsService;
  broadcast?: (event: string, data: unknown) => void;
}

/**
 * Ответы являются снимком исходной настройки, а не новым паспортом или профилем.
 * Даже при отказе после создания проекта их можно продолжить в следующих частях.
 */
function remember(state: OnboardingDocument, session: OnboardingSession, complete = false): void {
  if (!session.projectSaved || session.projectRevision === null) {
    return;
  }

  state.answersByProject[session.projectId] = {
    projectId: session.projectId,
    projectRevision: session.projectRevision,
    repositories: structuredClone(session.draft.repositories),
    workspace: { ...session.draft.workspace },
    aiSkipped: session.aiSkipped,
    complete,
  };
}

/**
 * Сервис владеет переходами; существующий ProjectsService по-прежнему пишет паспорт.
 * Lock хранилища сериализует клиентов, а intent связывает две атомарные записи.
 */
export function createOnboardingService(options: OnboardingOptions) {
  const { config, prefs, projectsService } = options;
  const store = new OnboardingStore(config.dataStateDir);

  /**
   * Допуск читает только идентификаторы, включая архив и исключая tombstones.
   * Недоступный реестр или каталог не считаются пустой установкой.
   */
  async function projectIds(): Promise<string[]> {
    prefs.readForWrite();
    await listFactoryProfiles(config.profilesDir, { strict: true });

    return listProjects(config, prefs);
  }

  /**
   * Первый проход продолжается после собственного паспорта, ручной — только по кнопке.
   * Присутствие постороннего проекта прекращает автоматическое приглашение.
   */
  async function snapshot(state: OnboardingDocument): Promise<OnboardingState> {
    const ids = await projectIds();
    const session = state.active;
    const shouldOpen = session?.status === 'active'
      ? session.origin === 'auto' && ids.every((id) => session.projectSaved && id === session.projectId)
      : !state.autoOpenDisabled && ids.length === 0;

    return { ...state, shouldOpen };
  }

  /**
   * Событие следует за записью и не превращает её успех в ошибку транспорта.
   * Подписчики перечитывают полный снимок через единственную общую шину.
   */
  function announce(revision: number): void {
    try {
      options.broadcast?.('onboarding-changed', { revision });
    } catch {
      // Запись уже состоялась; отказ подписчика не отменяет её.
      // Следующее чтение вернёт подтверждённую ревизию.
    }
  }

  /**
   * SessionId защищает от перехода по ответам уже завершённого прохода.
   * Ревизию отдельно проверяет хранилище перед любым изменением.
   */
  function current(state: OnboardingDocument, id: string): OnboardingSession {
    if (!state.active || state.active.id !== id) {
      throw new OnboardingError('session_conflict', 409);
    }

    return state.active;
  }

  /**
   * Сохранение intent предшествует созданию обычного проекта и фиксирует все поля.
   * При повторе допустим только точный собственный паспорт, чужой не перезаписывается.
   */
  async function commitProject(
    state: OnboardingDocument,
    session: OnboardingSession,
    save: () => Promise<void>,
  ): Promise<void> {
    if (!session.projectIntent) {
      const { draft } = session;

      if (!draft.title.trim()) {
        throw new OnboardingError('invalid_project');
      }

      for (const repo of draft.repositories) {
        const result = await inspectRepository(repo.source);

        if (!result.branches.some((branch) => branch.name === repo.baseBranch && branch.compatible)) {
          throw new OnboardingError('invalid_branch');
        }
      }

      const existing = new Set(await projectIds());
      const folder = path.basename(draft.repositories[0]!.source).toLowerCase();
      const base = (/^[a-z][a-z0-9_-]*$/.test(folder) ? folder : 'project').slice(0, 32);
      let id = base;
      let suffix = 2;

      while (existing.has(id) || isProjectDeleted(prefs, id)) {
        id = `${base}-${suffix++}`;
      }

      session.projectId = id;
      session.projectIntent = {
        id,
        title: draft.title.trim(),
        description: '',
        tags: [],
        repos: draft.repositories.map((repo) => ({ key: repo.name, dir: repo.source })),
        defaultRepoKey: draft.repositories[0]!.name,
      };
      await save();
    }

    const intent = session.projectIntent;
    let project;

    try {
      project = await projectsService.read(session.projectId);
    } catch (error) {
      if ((error as { status?: number }).status !== 404) {
        throw error;
      }
    }

    if (project) {
      const actual: ProjectInput = {
        id: project.id,
        title: project.title,
        description: project.description,
        tags: project.tags,
        repos: project.repos.map(({ key, dir }) => ({ key, dir })),
        defaultRepoKey: project.defaultRepoKey,
      };

      if (project.archivedAt || project.profile.present
        || JSON.stringify(actual) !== JSON.stringify(intent)) {
        throw new OnboardingError('project_conflict', 409);
      }
    } else {
      project = await projectsService.create(intent);
    }

    session.projectSaved = true;
    session.projectRevision = project.revision;
    session.step = 'workspace';
    remember(state, session);
    await save();
  }

  return {
    async getState(): Promise<OnboardingState> {
      return snapshot(await store.read());
    },

    /**
     * Автоматический start повторяет допуск под lock и никогда не продолжает manual.
     * Ручной start возвращает тот же active, сохраняя происхождение и ответы.
     */
    async start(expected: number, mode: 'auto' | 'manual'): Promise<OnboardingState> {
      let open = false;
      const state = await store.transact(expected, async (value, save) => {
        if (mode === 'auto' && !(await snapshot(value)).shouldOpen) {
          return;
        }

        open = true;

        if (value.active?.status === 'active') {
          return;
        }

        value.active = {
          id: randomUUID(),
          origin: mode,
          projectId: `project-${randomUUID().replaceAll('-', '').slice(0, 12)}`,
          status: 'active',
          step: 'ai',
          aiSkipped: false,
          projectSaved: false,
          projectRevision: null,
          projectIntent: null,
          draft: {
            title: '',
            repositories: [{
              name: 'repo1',
              source: '',
              baseBranch: null,
            }],
            workspace: { mode: 'isolated' },
          },
        };
        await save();
        announce(value.revision);
      });

      return { ...await snapshot(state), open };
    },

    /**
     * После создания паспорта меняется только режим будущих задач.
     * Сохранённый intent запрещает менять поля до завершения безопасного повтора.
     */
    async saveDraft(expected: number, id: string, input: unknown): Promise<OnboardingState> {
      const draft = decodeOnboardingDraft(input);
      const state = await store.transact(expected, async (value, save) => {
        const session = current(value, id);
        const before = { title: session.draft.title, repositories: session.draft.repositories };
        const after = { title: draft.title, repositories: draft.repositories };

        if (session.status !== 'active' || (session.projectIntent
          && (!session.projectSaved || JSON.stringify(before) !== JSON.stringify(after)))) {
          throw new OnboardingError('project_locked', 409);
        }

        session.draft = draft;
        remember(value, session);
        await save();
        announce(value.revision);
      });

      return snapshot(state);
    },

    /**
     * Шаги меняются только после подтверждённой записи; Git перепроверяется при commit.
     * Просмотр режима до создания проекта не разрешает завершить пустой проход.
     * Итог завершает лишь эту часть мастера, не создавая работающий профиль.
     */
    async advance(
      expected: number,
      id: string,
      skipAi?: boolean,
      previewWorkspace?: boolean,
    ): Promise<OnboardingState> {
      const state = await store.transact(expected, async (value, save) => {
        const session = current(value, id);

        if (session.status !== 'active' || (skipAi !== undefined && session.step !== 'ai')
          || (previewWorkspace !== undefined && session.step !== 'project')) {
          throw new OnboardingError('invalid_transition');
        }

        if (session.step === 'project') {
          if (session.projectSaved || (previewWorkspace === true && !session.projectIntent)) {
            session.step = 'workspace';
            await save();
          } else {
            await commitProject(value, session, save);
          }
        } else {
          if (session.step === 'ai') {
            session.aiSkipped = skipAi === true;
            session.step = 'project';
            remember(value, session);
          } else if (session.step === 'workspace') {
            if (!session.projectSaved) {
              throw new OnboardingError('invalid_project');
            }

            session.step = 'summary';
            session.status = 'completed';
            value.autoOpenDisabled = true;
            remember(value, session, true);
          } else {
            throw new OnboardingError('invalid_transition');
          }

          await save();
        }

        announce(value.revision);
      });

      return snapshot(state);
    },

    /**
     * Возврат сохраняет ответы и созданный паспорт, не повторяя создание проекта.
     * Итог можно открыть заново для выбора режима; пропущенный проход не возобновляется.
     */
    async back(expected: number, id: string): Promise<OnboardingState> {
      const state = await store.transact(expected, async (value, save) => {
        const session = current(value, id);

        if (session.status === 'dismissed' || session.step === 'ai'
          || (session.status === 'completed' && session.step !== 'summary')) {
          throw new OnboardingError('invalid_transition');
        }

        session.step = session.step === 'summary' ? 'workspace'
          : session.step === 'workspace' ? 'project' : 'ai';
        session.status = 'active';
        remember(value, session);
        await save();
        announce(value.revision);
      });

      return snapshot(state);
    },

    /**
     * Отказ устойчив для всей установки и сохраняет уже созданное обычным проектом.
     * Ответы остаются доступны следующей части настройки и другому устройству.
     */
    async dismiss(expected: number, id: string): Promise<OnboardingState> {
      const state = await store.transact(expected, async (value, save) => {
        const session = current(value, id);

        remember(value, session, session.status === 'completed');
        session.status = 'dismissed';
        value.autoOpenDisabled = true;
        await save();
        announce(value.revision);
      });

      return snapshot(state);
    },
  };
}
