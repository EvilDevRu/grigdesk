import { createDockerClient } from '../../server/src/lib/docker/client.ts';
import { createDockerService } from '../../server/src/lib/docker/service.ts';

type IsUnchecked<Value> = 0 extends (1 & Value) ? true : false;
type Checked<Value extends false> = Value;
type Client = ReturnType<typeof createDockerClient>;
type Service = ReturnType<typeof createDockerService>;
type Overview = Awaited<ReturnType<Service['overview']>>;

export type ClientJsonIsChecked = Checked<IsUnchecked<Awaited<ReturnType<Client['get']>>>>;
export type ServiceContainerIsChecked = Checked<IsUnchecked<Overview['containers'][number]>>;

/**
 * Транспорт возвращает непроверенный JSON, а сервис — проверенный контракт.
 * Эти отрицательные примеры запрещают ослаблять границу при будущих изменениях.
 */
async function checkServerContracts(client: Client, service: Service): Promise<void> {
  const response = await client.get('/version');

  // @ts-expect-error Ответ транспорта ещё не прошёл проверку формы Engine JSON.
  response.Version.toLowerCase();
  // @ts-expect-error Вызывающий не может назначить произвольный тип сетевому JSON.
  client.get<{ Version: string }>('/version');
  // @ts-expect-error Параметры запроса не являются готовой строкой query.
  client.get('/containers/json', 'all=true');
  // @ts-expect-error Разрешение exec — логический флаг, а не строка из окружения.
  createDockerService({ settings: () => ({ allowExec: 'true' }) });

  const overview = await service.overview();

  // @ts-expect-error Список может быть пустым, а контейнер — без compose-проекта.
  overview.containers[0].compose.project.toLowerCase();

  const health = await service.health();

  if (!health.available) {
    health.message.toLowerCase();
    // @ts-expect-error Недоступный демон не обещает сведения о версии.
    health.version.toLowerCase();
  }
}

void checkServerContracts;
