import type { ProjectRepoInput } from '../../shared/runtime/projectsContracts';
import type { RouteRevision } from '../../shared/pipeline/routesContracts';
import type { FactoryGraphData } from '../../shared/pipeline/factoryGraphContracts';
import { projectsApi } from '../../web/src/shared/projectsApi';
import { routesApi } from '../../web/src/shared/routesApi';
import { api } from '../../web/src/shared/apiClient';

type IsUnchecked<Value> = 0 extends (1 & Value) ? true : false;
type Checked<Value extends false> = Value;

// Транспорт не имеет права раздавать доменные типы: он отдаёт ровно `unknown`,
// и форму подтверждает декодер раздела.
type IsExactlyUnknown<Value> = [unknown] extends [Value]
  ? ([Value] extends [unknown] ? true : false)
  : false;
type Exact<Value extends true> = Value;

export type TransportIsUnknown = Exact<IsExactlyUnknown<Awaited<ReturnType<typeof api.get>>>>;
export type ProjectsAreChecked = Checked<IsUnchecked<Awaited<ReturnType<typeof projectsApi.list>>>>;
export type RevisionsAreChecked = Checked<
  IsUnchecked<Awaited<ReturnType<typeof routesApi.revisions>>>
>;

/**
 * Эти примеры выполняет только компилятор. Каждое ожидаемое нарушение обязано
 * оставаться ошибкой: ослабление контракта сломает обязательный typecheck.
 */
async function checkPipelineContracts(
  revision: RouteRevision,
  graph: FactoryGraphData,
): Promise<void> {
  // @ts-expect-error Ответ сети — unknown: превращать его в модель обязан декодер.
  const rawRevisions: RouteRevision[] = await api.get('/api/routes/grigdesk/revisions');

  // @ts-expect-error Источник пути назначает сервер: клиент его не присылает.
  const badRepo: ProjectRepoInput = { key: 'be', dir: '/srv/be', from: 'grigdesk' };

  // @ts-expect-error Каталог повреждённой ревизии может отсутствовать целиком.
  revision.routes.length;

  // @ts-expect-error Схема опубликованного маршрута не обещает статусов: их даёт прогон.
  const statuses: Record<string, string> = graph.statuses;

  // @ts-expect-error Публикация несёт ожидаемый хеш: без него CAS невозможен.
  await routesApi.publish('grigdesk', 'publish');

  // @ts-expect-error Режим публикации закрыт перечислением.
  await routesApi.publish('grigdesk', 'deploy', null);

  void rawRevisions;
  void badRepo;
  void statuses;
}

void checkPipelineContracts;
