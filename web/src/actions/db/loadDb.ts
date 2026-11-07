import { runtimeOf } from './dbRuntime.ts';
import { errorMessage } from '../../../../shared/lib/errors.ts';

import { dbApi } from '../../shared/dbApi.ts';
import { useDbStore } from '../../stores/db.ts';

/**
 * Согласованный снимок движков, профилей, сессий и ленты загружается вместе.
 * Отказ журнала виден отдельно и не скрывает исправные подключения и консоль.
 */
export async function loadDb(): Promise<void> {
  const store = useDbStore();

  store.setLoading(true);
  store.setError('');

  try {
    const [[engines, profiles, sessions, queries], [audit]] = await Promise.all([
      Promise.all([dbApi.engineSnapshot(), dbApi.profiles(), dbApi.sessions(), dbApi.queries()]),
      Promise.allSettled([dbApi.audit()]),
    ]);

    store.setSnapshot({
      engines: engines.engines,
      engineErrors: engines.errors,
      engineInstalls: engines.installs,
      installHealth: engines.installHealth,
      profiles,
      sessions,
      queries,
      audit: audit.status === 'fulfilled' ? audit.value.items : store.audit,
      auditSkippedRecords: audit.status === 'fulfilled'
        ? audit.value.skippedRecords ?? 0 : store.auditSkippedRecords,
    });

    if (audit.status === 'rejected') {
      store.setAuditError(errorMessage(audit.reason, 'Не удалось загрузить журнал баз'));
    }
  } catch (error) {
    store.setError(errorMessage(error, 'Не удалось загрузить базы'));
  } finally {
    store.setLoading(false);
  }
}

/**
 * Каталог проектов для формы нового профиля. Читается отдельно от снимка намеренно:
 * повреждённый профиль проекта не должен прятать уже открытые сессии.
 */
export async function loadDbProjects(): Promise<void> {
  const store = useDbStore();
  const runtime = runtimeOf(store);
  const request = ++runtime.projectsRequest;

  store.setProjectsLoading(true);
  store.setProjectsError('');

  try {
    const projects = await dbApi.projects();

    if (request === runtime.projectsRequest) {
      store.setProjects(projects);
    }
  } catch (error) {
    if (request !== runtime.projectsRequest) {
      return;
    }

    store.setProjectsError(errorMessage(error, 'Не удалось загрузить проекты'));
  } finally {
    if (request === runtime.projectsRequest) {
      store.setProjectsLoading(false);
    }
  }
}

/**
 * Лента запросов после события сервера. Перечитывается только она: запрос идёт
 * минутами, и дёргать из-за него весь раздел незачем.
 */
export async function refreshDbQueries(): Promise<void> {
  const store = useDbStore();

  store.setQueries(await dbApi.queries());
}

/**
 * Журнал после события сервера. Он растёт и от действий агента, и от чужой
 * вкладки, поэтому перечитывается событием, а не по нажатию человека.
 */
export async function refreshDbAudit(): Promise<void> {
  const store = useDbStore();

  try {
    const page = await dbApi.audit();

    store.setAudit(page.items, page.skippedRecords ?? 0);
  } catch (error) {
    store.setAuditError(errorMessage(error, 'Не удалось загрузить журнал баз'));
  }
}

/**
 * Открытые SSH-сессии. Их выбирает человек, когда профиль идёт через туннель:
 * сервер не подставляет сессию сам — иначе база открылась бы не через ту машину.
 */
export async function loadDbSshSessions(): Promise<void> {
  const store = useDbStore();

  store.setSshSessions(await dbApi.sshSessions());
}
