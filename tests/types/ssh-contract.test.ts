import type { SshAuditEntry, SshFile, SshSession } from '../../shared/sshContracts.ts';
import { parseSshHostKeyCheck, parseSshSessions } from '../../shared/sshContracts.ts';
import { sshApi } from '../../web/src/shared/sshApi.ts';
import { closeSshSession, setSshAgentAccess, useSshStore } from '../../web/src/actions/ssh';

type IsUnchecked<Value> = 0 extends (1 & Value) ? true : false;
type Checked<Value extends false> = Value;

export type SessionIsChecked = Checked<IsUnchecked<SshSession>>;
export type FileIsChecked = Checked<IsUnchecked<SshFile>>;
export type AuditIsChecked = Checked<IsUnchecked<SshAuditEntry>>;
export type ApiSessionsIsChecked = Checked<IsUnchecked<Awaited<ReturnType<typeof sshApi.sessions>>>>;

/**
 * Примеры запускает только компилятор. Ключ хоста и доступ агента — рубежи доверия:
 * по ним человек отдаёт пароль root и открывает агенту чужую машину, и непроверенный
 * JSON не имеет права стать здесь ни статусом, ни разрешением.
 */
function checkContracts(input: unknown, store: ReturnType<typeof useSshStore>): void {
  // @ts-expect-error Непроверенный JSON не является списком сессий.
  const unchecked: SshSession[] = input;
  // @ts-expect-error Состояние ключа хоста закрыто перечислением.
  const status: ReturnType<typeof parseSshHostKeyCheck>['status'] = 'может быть';
  // @ts-expect-error Каталог и файл — объявленные значения, а не свободная строка.
  const kind: SshFile['type'] = 'symlink';
  // @ts-expect-error Решение по ключу называет challenge, а не соединение.
  sshApi.decideHostKey('challenge-1', 'может быть');
  // @ts-expect-error Доступ агента снимается и выдаётся булевым решением.
  setSshAgentAccess('session-a', 'yes');
  // @ts-expect-error Закрытие сессии называет сессию.
  closeSshSession();
  // @ts-expect-error Стор состояния сам в сеть не ходит.
  store.load();

  const sessions = parseSshSessions(input);

  // @ts-expect-error Список сессий может быть пустым.
  sessions[0].label.toUpperCase();

  void [unchecked, status, kind];
}

void checkContracts;
