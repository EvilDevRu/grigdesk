import { createSandboxService } from '../../server/src/lib/sandboxes/service.ts';
import { readSandboxJournalRecord, readSandboxStage } from '../../server/src/lib/sandboxes/registry.ts';

type IsUnchecked<Value> = 0 extends (1 & Value) ? true : false;
type Checked<Value extends false> = Value;
type Service = ReturnType<typeof createSandboxService>;
type Overview = Awaited<ReturnType<Service['overview']>>;

export type OverviewIsChecked = Checked<IsUnchecked<Overview['sandboxes'][number]>>;
export type JobIsChecked = Checked<IsUnchecked<Overview['jobs'][number]>>;

/**
 * Отрицательные примеры выполняет только компилятор: подъём стенда обязан остаться
 * действием с явным профилем и явным номером, а журнал этапов и запись кокпита —
 * значениями, которых может не быть.
 */
async function checkServerContracts(service: Service, stateDir: string): Promise<void> {
  // @ts-expect-error Профиль обязателен: стенд поднимает скрипт конкретного профиля.
  await service.raise({ task: '990000' });
  // @ts-expect-error «Без задачи» выражается null, а не отсутствием поля.
  await service.raise({ profile: 'demo-profile' });
  // @ts-expect-error Снос принимает номер строкой — тем же, каким его знает реестр.
  await service.dismantle({ task: 990000 });

  const overview = await service.overview();

  // @ts-expect-error Список стендов бывает пустым, а порт — не выданным.
  overview.sandboxes[0].fePort.toFixed();
  // @ts-expect-error Владелец стенда ограничен контрактом.
  const owner: Overview['sandboxes'][number]['owner'] = 'unknown';

  const stage = await readSandboxStage(stateDir, '990000');

  // @ts-expect-error Журнала этапов может не быть вовсе.
  stage.index.toFixed();

  const record = await readSandboxJournalRecord(stateDir, '990000');

  // @ts-expect-error Записи журнала может не быть, а повреждённая читается как null.
  record.state.toUpperCase();

  void owner;
}

void checkServerContracts;
