import type {
  SandboxEntry,
  SandboxJob,
  SandboxOverview,
} from '../../shared/sandboxContracts';
import { dismantleSandbox, raiseSandbox, useSandboxesStore } from '../../web/src/actions/sandboxes';
import { sandboxApi } from '../../web/src/shared/sandboxApi';

type IsUnchecked<Value> = 0 extends (1 & Value) ? true : false;
type Checked<Value extends false> = Value;
type Store = ReturnType<typeof useSandboxesStore>;

// Контракт не должен терять проверку типов, проходя через общий JS-клиент API, слой
// операций раздела и Pinia.
export type EntryIsChecked = Checked<IsUnchecked<SandboxEntry>>;
export type StoreEntryIsChecked = Checked<IsUnchecked<Store['sandboxes'][number]>>;
export type ApiOverviewIsChecked = Checked<IsUnchecked<Awaited<ReturnType<typeof sandboxApi.overview>>>>;

/**
 * Эти примеры выполняет только компилятор. Каждое ожидаемое нарушение обязано
 * остаться ошибкой: ослабление контракта сломает обязательный typecheck.
 */
function checkContracts(
  store: Store,
  input: unknown,
  overview: SandboxOverview,
  entry: SandboxEntry,
  job: SandboxJob,
): void {
  // @ts-expect-error Непроверенный JSON нельзя класть в состояние раздела.
  const unchecked: SandboxOverview = input;
  // @ts-expect-error Владелец стенда ограничен контрактом.
  const owner: SandboxEntry['owner'] = 'unknown';
  // @ts-expect-error Номер стенда — строка реестра, а не число.
  dismantleSandbox(990000);
  // @ts-expect-error «Без задачи» выражается null, а не отсутствием аргумента.
  raiseSandbox('demo-profile');
  // @ts-expect-error В состояние кладут проверенное задание, а не кадр из сети.
  store.applyJob(input);
  // @ts-expect-error Подъём требует профиля: стенд поднимает конкретный скрипт.
  sandboxApi.raise({ task: '990000' });
  // @ts-expect-error Порт может быть не выдан, пока стенд поднимается.
  entry.fePort.toFixed();
  // @ts-expect-error Отдельная проверка FE отсутствует в ответах старого сервера.
  entry.feAlive.valueOf();
  // @ts-expect-error Список стендов бывает пустым.
  overview.sandboxes[0].task.toUpperCase();

  if (job.state === 'running') {
    job.label.toUpperCase();
    // @ts-expect-error Незавершённое задание не имеет времени завершения.
    job.finishedAt.toUpperCase();
  }

  void unchecked;
  void owner;
}

void checkContracts;
