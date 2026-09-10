import type {
  ShowcaseJob,
  ShowcaseOverview,
  ShowcaseProject,
  ShowcaseTarget,
} from '../../shared/showcaseContracts';
import {
  cancelShowcaseJob,
  createShowcaseProject,
  deleteShowcaseProject,
  useShowcaseStore,
} from '../../web/src/actions/showcase';
import { showcaseApi } from '../../web/src/shared/showcaseApi';

type IsUnchecked<Value> = 0 extends (1 & Value) ? true : false;
type Checked<Value extends false> = Value;
type Store = ReturnType<typeof useShowcaseStore>;

// Контракт не должен терять проверку типов, проходя через общий JS-клиент API, слой
// операций раздела и Pinia.
export type ProjectIsChecked = Checked<IsUnchecked<ShowcaseProject>>;
export type StoreProjectIsChecked = Checked<IsUnchecked<Store['projects'][number]>>;
export type ApiOverviewIsChecked = Checked<IsUnchecked<Awaited<ReturnType<typeof showcaseApi.overview>>>>;

/**
 * Эти примеры выполняет только компилятор. Каждое ожидаемое нарушение обязано
 * остаться ошибкой: ослабление контракта сломает обязательный typecheck.
 */
function checkContracts(
  store: Store,
  input: unknown,
  overview: ShowcaseOverview,
  project: ShowcaseProject,
  job: ShowcaseJob,
  target: ShowcaseTarget,
): void {
  // @ts-expect-error Непроверенный JSON нельзя класть в состояние раздела.
  const unchecked: ShowcaseOverview = input;
  // @ts-expect-error Вид цели закрыт перечислением: показывать «что-нибудь» нельзя.
  const kind: ShowcaseProject['ref']['kind'] = 'anything';
  // @ts-expect-error Среда показа объявляется профилем, а не выдумывается клиентом.
  const environment: ShowcaseOverview['projects'][number]['state'] = 'almost-ready';
  // @ts-expect-error В состояние кладут проверенное задание, а не кадр из сети.
  store.applyJob(input);
  // @ts-expect-error Ролик заводится под конкретную цель: без неё показывать нечего.
  createShowcaseProject(store, { profile: 'demo-profile' });
  // @ts-expect-error Удаление адресуется идентификатором ролика, а не самим роликом.
  deleteShowcaseProject(store, project);
  // @ts-expect-error Отмена работает по заданию, а не по ролику.
  cancelShowcaseJob(store, { id: 'job' });
  // @ts-expect-error Цель resolve требует и ссылку, и профиль.
  showcaseApi.target({ kind: 'project', id: 'demo-profile' });
  // @ts-expect-error Список роликов бывает пустым.
  overview.projects[0].title.toUpperCase();

  // Готовая цель несёт область показа, заблокированная — причину. Обе ветки
  // обязаны различаться компилятором, иначе «нет стенда» покажется как «готово».
  if (target.status === 'ready') {
    target.scope.targetLabel.toUpperCase();
    // @ts-expect-error У готовой цели нет причины отказа.
    target.reason.toUpperCase();
  } else {
    target.reason.toUpperCase();
    // @ts-expect-error У заблокированной цели нет области показа.
    target.scope.profile.toUpperCase();
  }

  if (job.state === 'running') {
    job.progress.label.toUpperCase();
    // @ts-expect-error Незавершённое задание не имеет времени завершения.
    job.finishedAt.toUpperCase();
  }

  void unchecked;
  void kind;
  void environment;
}

void checkContracts;
