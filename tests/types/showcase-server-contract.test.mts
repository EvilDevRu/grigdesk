import { createShowcaseService } from '../../server/src/lib/showcase/service.ts';
import { createShowcaseStore } from '../../server/src/lib/showcase/store.ts';
import { toPublicJob } from '../../server/src/lib/showcase/jobs.ts';
import { toPublicScope } from '../../server/src/lib/showcase/targets.ts';

type IsUnchecked<Value> = 0 extends (1 & Value) ? true : false;
type Checked<Value extends false> = Value;
type Service = ReturnType<typeof createShowcaseService>;
type Store = ReturnType<typeof createShowcaseStore>;
type Overview = Awaited<ReturnType<Service['overview']>>;

export type OverviewIsChecked = Checked<IsUnchecked<Overview['projects'][number]>>;
export type JobIsChecked = Checked<IsUnchecked<Overview['jobs'][number]>>;

/**
 * Отрицательные примеры выполняет только компилятор. Проверяется главное: ролик
 * заводится под объявленную цель, правка приходит со своей редакцией, а публичные
 * проекции не отдают наружу то, ради чего они и сделаны, — адрес записи, состояние
 * входа и identity процесса задания.
 */
async function checkServerContracts(service: Service, store: Store, id: string): Promise<void> {
  // @ts-expect-error Цель обязательна: показывать без адреса и экранов нечего.
  await service.createProject({ profile: 'demo-profile' });
  // @ts-expect-error Профиль обязателен: адреса и карту экранов объявляет он.
  await service.createProject({ ref: { kind: 'project', id: 'demo-profile' } });
  // @ts-expect-error Вид цели закрыт перечислением.
  await service.createProject({ ref: { kind: 'anything', id: '1' }, profile: 'demo-profile' });
  // @ts-expect-error Правка идёт со своей ожидаемой редакцией, иначе затрёт чужую.
  await service.renameProject(id, 'Новое название');

  const overview = await service.overview();

  // @ts-expect-error Список роликов бывает пустым.
  overview.projects[0].title.toUpperCase();
  // @ts-expect-error Состояние ролика ограничено контрактом.
  const state: Overview['projects'][number]['state'] = 'almost';

  const project = await store.readProject(id);

  if (project.target.status === 'ready') {
    project.target.scope.profile.toUpperCase();
    // @ts-expect-error Адрес серверной записи наружу не отдаётся.
    project.target.scope.recordUrl.toUpperCase();
    // @ts-expect-error Разрешённые origins остаются на сервере.
    project.target.scope.allowedOrigins.join('');
  }

  // @ts-expect-error Публичная область собирается из внутренней, а не из чего попало.
  toPublicScope({ profile: 'demo-profile' });

  const job = service.jobs.read('0123456789abcdef');
  const publicJob = toPublicJob(job);

  // @ts-expect-error Ключ повтора и хеши входов остаются на сервере.
  publicJob.idempotencyKey.toUpperCase();
  // @ts-expect-error Identity процесса задания наружу не уходит.
  publicJob.identity.pid?.toFixed();
  // @ts-expect-error Незавершённое задание не имеет времени завершения.
  publicJob.finishedAt.toUpperCase();

  void state;
}

void checkServerContracts;
