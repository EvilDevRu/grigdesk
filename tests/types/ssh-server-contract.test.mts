import { limitSshOutput } from '../../server/src/lib/ssh/output.ts';
import { evaluateDirectCommand } from '../../server/src/lib/executors/_directSshPolicy.ts';
import type { SshSessionManager } from '../../server/src/lib/ssh/sessionManager.ts';
import type { SshBroker } from '../../server/src/lib/ssh/broker.ts';
import type { SshModuleOptions } from '../../server/src/modules/ssh/index.ts';

type IsUnchecked<Value> = 0 extends (1 & Value) ? true : false;
type Checked<Value extends false> = Value;

export type OutputIsChecked = Checked<IsUnchecked<ReturnType<typeof limitSshOutput>>>;
export type VerdictIsChecked = Checked<IsUnchecked<ReturnType<typeof evaluateDirectCommand>>>;
export type ServiceIsChecked = Checked<IsUnchecked<SshModuleOptions['service']>>;

/**
 * Вердикт рубежа прямого SSH — объявленное значение, а не свободная строка: соседний
 * JavaScript не должен уметь придумать четвёртый исход, который никто не обрабатывает.
 */
async function checkServerContracts(
  sessions: SshSessionManager,
  broker: SshBroker,
): Promise<void> {
  // @ts-expect-error Исход политики закрыт перечислением.
  const verdict: ReturnType<typeof evaluateDirectCommand>['verdict'] = 'наверное';
  // @ts-expect-error Открытие сессии называет соединение и пароль.
  await sessions.open({ password: 'secret' });
  // @ts-expect-error Доступ агента меняется булевым решением.
  await sessions.setAgentAccess('session-a', 'yes');
  // @ts-expect-error Область работы агенту навязывает сервер, а не его аргументы.
  await broker.invoke({ projectId: 42 }, { action: 'list' });

  const limited = limitSshOutput('вывод', 16);

  // @ts-expect-error Ограниченный вывод отдаёт текст полем, а не сам является строкой.
  limited.toUpperCase();

  void verdict;
}

void checkServerContracts;
