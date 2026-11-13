import { runtimeOf } from './sshRuntime.ts';
import { errorMessage } from '../../../../shared/lib/errors.ts';

import { sshApi } from '../../shared/sshApi.ts';
import { useSshStore } from '../../stores/ssh.ts';
import { detachSshTerminal } from './sshTerminal.ts';
import { localeTranslator } from '../../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from '../../shared/uiLocalePort.ts';

const translateUi = localeTranslator(uiLocalePort);


/**
 * Свежий снимок раздела: серверы, живые сессии и журнал одним заходом. Если активной
 * вкладки среди сессий больше нет — сокет отпускается: сессию завершил сервер или
 * другое окно, и держать открытым канал к исчезнувшей сессии незачем.
 */
export async function loadSsh(): Promise<void> {
  const store = useSshStore();

  store.setLoading(true);
  store.setError('');

  try {
    const [connections, sessions, audit] = await Promise.all([
      sshApi.connections(),
      sshApi.sessions(),
      sshApi.audit(),
    ]);

    store.setSnapshot({
      connections,
      sessions,
      audit: audit.items,
    });

    if (store.activeId && !sessions.some((item) => item.id === store.activeId)) {
      detachSshTerminal();
    }
  } catch (error) {
    store.setError(errorMessage(error, translateUi('core.loadSshCouldNotLoadSSH')));
  } finally {
    store.setLoading(false);
  }
}

/**
 * Каталог проектов для формы нового сервера. Читается отдельно от снимка намеренно:
 * повреждённый профиль проекта не должен прятать уже открытые сессии.
 */
export async function loadSshProjects(): Promise<void> {
  const store = useSshStore();
  const runtime = runtimeOf(store);
  const request = ++runtime.projectsRequest;

  store.setProjectsLoading(true);
  store.setProjectsError('');

  try {
    const projects = await sshApi.projects();

    if (request === runtime.projectsRequest) {
      store.setProjects(projects);
    }
  } catch (error) {
    if (request !== runtime.projectsRequest) {
      return;
    }

    store.setProjectsError(errorMessage(error, translateUi('core.loadDbCouldNotLoadProjects')));
  } finally {
    if (request === runtime.projectsRequest) {
      store.setProjectsLoading(false);
    }
  }
}

/**
 * Журнал команд агента после события сервера: перечитывается только он. Отдельная
 * запись не повод перечитывать весь раздел — сессии и серверы от неё не меняются.
 */
export async function reloadSshAudit(): Promise<void> {
  const store = useSshStore();

  try {
    const page = await sshApi.audit();

    store.setAudit(page.items);
  } catch {
    // журнал не приехал: прошлый список остаётся на экране
  }
}
