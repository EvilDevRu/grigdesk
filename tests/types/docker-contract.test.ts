import type {
  DockerActionResult,
  DockerContainer,
  DockerContainerAction,
  DockerHealth,
  DockerLogMessage,
  DockerOverview,
  DockerPruneItem,
  DockerStatsMessage,
} from '../../shared/dockerContracts';
import { useDockerStore } from '../../web/src/stores/docker';
import { dockerApi } from '../../web/src/shared/dockerApi';

type IsUnchecked<Value> = 0 extends (1 & Value) ? true : false;
type Checked<Value extends false> = Value;
type Store = ReturnType<typeof useDockerStore>;

// Контракты не должны терять проверку типов при прохождении через JS-клиент API и Pinia.
export type ContainerIsChecked = Checked<IsUnchecked<DockerContainer>>;
export type StoreContainerIsChecked = Checked<IsUnchecked<Store['containers'][number]>>;
export type ApiOverviewIsChecked = Checked<IsUnchecked<Awaited<ReturnType<typeof dockerApi.overview>>>>;

/**
 * Эти примеры выполняет только компилятор. Каждое ожидаемое нарушение должно
 * оставаться ошибкой: ослабление контракта сломает обязательный typecheck.
 */
function checkContracts(
  store: Store,
  input: unknown,
  overview: DockerOverview,
  health: DockerHealth,
  log: DockerLogMessage,
  stats: DockerStatsMessage,
  result: DockerActionResult,
  prune: DockerPruneItem,
): void {
  // @ts-expect-error Непроверенный JSON нельзя передавать в состояние обзора.
  const unchecked: DockerOverview = input;
  // @ts-expect-error Размер памяти не является строкой для отображения.
  const memory: number = '12 МБ';
  // @ts-expect-error Действие ограничено контрактом Docker.
  const action: DockerContainerAction = 'destroy';
  // @ts-expect-error Store принимает только известное действие.
  store.containerAction('container', 'destroy');
  // @ts-expect-error Только очистка поддерживаемых целей.
  dockerApi.prune({ targets: ['everything'] });
  // @ts-expect-error Контейнер может быть без compose-проекта, а список — пустым.
  overview.containers[0].compose.project.toLowerCase();

  if (!health.available) {
    health.message.toLowerCase();
    // @ts-expect-error При недоступном демоне версия неизвестна.
    health.version.toLowerCase();
  }

  if (log.t === 'log') {
    log.lines.forEach((line) => line.text.toLowerCase());
  } else {
    // @ts-expect-error Сообщение конца потока или ошибки не содержит строк лога.
    log.lines.map(String);
  }

  if (stats.t === 'stats') {
    // @ts-expect-error Отдельный контейнер может отсутствовать в срезе статистики.
    stats.items.missing.cpuPercent.toFixed(1);
  }

  if (!result.ok) {
    result.message.toLowerCase();
  } else {
    // @ts-expect-error Успешное действие не содержит сообщения об ошибке.
    result.message.toLowerCase();
  }

  if ('error' in prune) {
    prune.error.toLowerCase();
  }

  void [unchecked, memory, action];
}

void checkContracts;
