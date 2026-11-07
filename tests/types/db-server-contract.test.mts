import { evaluateAutoRead } from '../../server/src/lib/db/autoRead.ts';
import { normalizeDbResult } from '../../server/src/lib/db/result.ts';
import type { DbBroker } from '../../server/src/lib/db/broker.ts';
import type { PublicDbSession } from '../../server/src/lib/db/sessionManager.ts';
import type { DbModuleOptions } from '../../server/src/modules/db/index.ts';

type IsUnchecked<Value> = 0 extends (1 & Value) ? true : false;
type Checked<Value extends false> = Value;

export type ResultIsChecked = Checked<IsUnchecked<Awaited<ReturnType<typeof normalizeDbResult>>>>;
export type VerdictIsChecked = Checked<IsUnchecked<ReturnType<typeof evaluateAutoRead>>>;
export type SessionIsChecked = Checked<IsUnchecked<PublicDbSession>>;
export type ServiceIsChecked = Checked<IsUnchecked<DbModuleOptions['service']>>;

/**
 * Границу надзорного раздела держат две вещи: ограниченный ответ базы и решение об
 * авто-чтении. Ни одна не должна принимать чужую форму от соседнего JavaScript —
 * иначе кусок ответа выдаст себя за весь, а отказ превратится в разрешение.
 */
async function checkServerContracts(broker: DbBroker): Promise<void> {
  // @ts-expect-error Область работы агенту навязывает сервер, а не его аргументы.
  await broker.invoke({ projectId: 42 }, { action: 'list' });

  const limited = await normalizeDbResult([{ id: 1 }], { maxRows: 10, maxBytes: 1024 });

  // @ts-expect-error Ограниченный ответ отдаёт строки полем, а не сам является списком.
  limited.length.toFixed();
  // @ts-expect-error Полного счёта у прерванного запроса нет.
  limited.totalRows.toFixed();

  const verdict = evaluateAutoRead({ settings: { enabled: false } });

  // @ts-expect-error Разрешённое чтение причины не имеет.
  verdict.reason.code.toUpperCase();
}

void checkServerContracts;
