import { errorMessage } from '../../../../shared/lib/errors.ts';

import { dbApi } from '../../shared/dbApi.ts';
import { useDbStore } from '../../stores/db.ts';

/**
 * Свежий снимок раздела: движки, профили, сессии, лента запросов и журнал одним
 * заходом. Пять ответов собираются вместе, потому что порознь они рассказывают
 * противоречивую историю — сессию уже закрытого профиля, например.
 */
export async function loadDb(): Promise<void> {
  const store = useDbStore();

  store.setLoading(true);
  store.setError('');

  try {
    const [engines, profiles, sessions, queries, audit] = await Promise.all([
      dbApi.engines(),
      dbApi.profiles(),
      dbApi.sessions(),
      dbApi.queries(),
      dbApi.audit(),
    ]);

    store.setSnapshot({
      engines,
      profiles,
      sessions,
      queries,
      audit: audit.items,
    });
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

  store.setProjectsLoading(true);
  store.setProjectsError('');

  try {
    store.setProjects(await dbApi.projects());
  } catch (error) {
    store.setProjectsError(errorMessage(error, 'Не удалось загрузить проекты'));
  } finally {
    store.setProjectsLoading(false);
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
  const page = await dbApi.audit();

  store.setAudit(page.items);
}

/**
 * Открытые SSH-сессии. Их выбирает человек, когда профиль идёт через туннель:
 * сервер не подставляет сессию сам — иначе база открылась бы не через ту машину.
 */
export async function loadDbSshSessions(): Promise<void> {
  const store = useDbStore();

  store.setSshSessions(await dbApi.sshSessions());
}
