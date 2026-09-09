import { sshApi } from '../../shared/sshApi.ts';
import type { SshConnection, SshConnectionInput } from '../../../../shared/sshContracts.ts';
import { useSshStore } from '../../stores/ssh.ts';
import { activateSshSession } from './sshTerminal.ts';

/**
 * Новый сервер или правка существующего. В список кладётся ответ сервера, а не то,
 * что набрал человек: порт и пробелы там уже приведены к хранимому виду.
 */
export async function saveSshConnection(
  connection: SshConnectionInput,
): Promise<SshConnection> {
  const store = useSshStore();
  const saved = await sshApi.saveConnection(connection);

  store.upsertConnection(saved);

  return saved;
}

/**
 * Ключ хоста до всякого пароля. Ответ говорит, знаком ли сервер, сменился ли его
 * ключ и какое решение требуется от человека.
 */
export async function probeSshHostKey(connectionId: string) {
  return sshApi.probeHostKey(connectionId);
}

/**
 * Решение человека по ключу. Challenge одноразовый и короткоживущий: доверие
 * относится к конкретной проверке, а не к адресу вообще.
 */
export async function decideSshHostKey(challengeId: string, decision: 'trust' | 'replace') {
  return sshApi.decideHostKey(challengeId, decision);
}

/**
 * Вход паролем. Сессию открывает сервер, а вкладка получает её отражение и сразу
 * встаёт на неё: канал терминала открывается только там, где адрес сокета известен —
 * в проверке без сети его нет, и тогда вкладка просто становится текущей.
 */
export async function connectSshSession(connectionId: string, password: string) {
  const store = useSshStore();
  const session = await sshApi.openSession(connectionId, password);

  store.upsertSession(session);

  if (sshApi.hasTerminalUrl()) {
    activateSshSession(session.id);
  } else {
    store.setActive(session.id);
  }

  return session;
}
