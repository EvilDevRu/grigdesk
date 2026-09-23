import type { AgentCard, AgentDraft } from '../../shared/agentsContracts';
import type { ProjectRepoInput } from '../../shared/projectsContracts';
import type { RouteRevision } from '../../shared/routesContracts';
import type { FactoryGraphData } from '../../shared/factoryGraphContracts';
import { agentsApi } from '../../web/src/shared/agentsApi';
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
export type AgentsAreChecked = Checked<IsUnchecked<Awaited<ReturnType<typeof agentsApi.list>>>>;
export type ProjectsAreChecked = Checked<IsUnchecked<Awaited<ReturnType<typeof projectsApi.list>>>>;
export type RevisionsAreChecked = Checked<
  IsUnchecked<Awaited<ReturnType<typeof routesApi.revisions>>>
>;

/**
 * Эти примеры выполняет только компилятор. Каждое ожидаемое нарушение обязано
 * оставаться ошибкой: ослабление контракта сломает обязательный typecheck.
 */
async function checkPipelineContracts(
  agent: AgentCard,
  revision: RouteRevision,
  graph: FactoryGraphData,
): Promise<void> {
  // @ts-expect-error Ответ сети — unknown: превращать его в модель обязан декодер.
  const rawAgents: AgentCard[] = await api.get('/api/agents');

  // @ts-expect-error Времена карточки — числа, а не строки формы.
  const badTimeout: AgentDraft = { ...agent, timeout: '900' };

  // @ts-expect-error Источник пути назначает сервер: клиент его не присылает.
  const badRepo: ProjectRepoInput = { key: 'be', dir: '/srv/be', from: 'cockpit' };

  // @ts-expect-error Каталог повреждённой ревизии может отсутствовать целиком.
  revision.routes.length;

  // @ts-expect-error Схема опубликованного маршрута не обещает статусов: их даёт прогон.
  const statuses: Record<string, string> = graph.statuses;

  // @ts-expect-error Публикация несёт ожидаемый хеш: без него CAS невозможен.
  await routesApi.publish('cockpit', 'publish');

  // @ts-expect-error Режим публикации закрыт перечислением.
  await routesApi.publish('cockpit', 'deploy', null);

  void rawAgents;
  void badTimeout;
  void badRepo;
  void statuses;
}

void checkPipelineContracts;
