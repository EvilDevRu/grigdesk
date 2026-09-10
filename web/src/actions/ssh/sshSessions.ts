import { sshApi } from '../../shared/sshApi.ts';
import { useSshStore } from '../../stores/ssh.ts';
import { detachSshTerminal } from './sshTerminal.ts';

/**
 * Явное закрытие сессии человеком. Сначала отпускается канал текущей вкладки, иначе
 * сокет закрытой сессии остался бы висеть до ответа сервера.
 */
export async function closeSshSession(id: string): Promise<void> {
  const store = useSshStore();

  if (store.activeId === id) {
    detachSshTerminal();
  }

  await sshApi.closeSession(id);
  store.dropSession(id);
}

/**
 * Доступ агента к сессии. Потерянная сессия отвечает машинным кодом вместо записи —
 * тогда список не трогаем: строка останется прежней до ближайшего снимка, а
 * подставлять в неё отказ значило бы показать несуществующую сессию.
 */
export async function setSshAgentAccess(id: string, allowed: boolean): Promise<void> {
  const store = useSshStore();
  const result = await sshApi.setAgentAccess(id, allowed);

  if (result.session) {
    store.patchSession(id, result.session);
  }
}
