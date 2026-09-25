import { ROUTES_EDITOR_LIMITS } from '../../../../shared/routesEditorContracts.ts';
import { failureText } from '../../shared/apiClient.ts';
import { useRoutesStore } from '../../stores/routes.ts';
import type { RouteSimulationObservation } from '../../stores/routes.ts';
import { runtimeOf } from './routesRuntime.ts';

/** Создаёт локальный курсор только от сохранённой ревизии полного каталога. */
/**
 * Создаёт пробный проход по маршруту или bootstrap.
 * Симуляция читает снимок каталога и не выполняет агентские команды.
 */
export function startRouteSimulation(
  scope: 'route' | 'bootstrap', routeId: string | null, pinned: boolean,
): void {
  const store = useRoutesStore();
  const draft = store.serverSnapshot;

  store.simulationError = '';

  if (!store.opened?.draftId || !draft || store.dirty || store.saving || store.conflict
    || store.jsonBuffer?.dirty) {
    store.simulationError = 'Сначала сохраните черновик и разрешите конфликт записи.';

    return;
  }

  const machine = scope === 'bootstrap' ? draft.bootstrap
    : routeId ? draft.routes[routeId]?.route : null;

  if (!machine?.entry) {
    store.simulationError = 'Выберите маршрут с начальным узлом.';

    return;
  }

  store.simulation = {
    cursor: {
      scope,
      routeId: scope === 'bootstrap' ? null : routeId,
      nodeId: machine.entry,
      terminal: false
    },
    counters: {
      noResult: {},
      productFailure: {},
      rewinds: {}
    },
    draftRevision: draft.revision,
    generation: store.editGeneration,
    stepIndex: 1,
    pinned,
    busy: false,
    error: '',
    stale: false,
    pendingHuman: null,
    last: null,
  };
}

/** Отправляет одно наблюдение движку и не продвигает устаревший сценарий. */
/**
 * Передаёт наблюдаемый исход и получает следующий шаг пробного прохода.
 * Симуляция читает снимок каталога и не выполняет агентские команды.
 */
export async function stepRouteSimulation(observation: RouteSimulationObservation): Promise<void> {
  const store = useRoutesStore();
  const state = store.simulation;
  const opened = store.opened;

  if (!state || !opened?.draftId || state.busy) {
    return;
  }
  if (state.cursor.terminal) {
    state.error = 'Сценарий остановлен. Начните новый.';

    return;
  }
  if (state.stepIndex > ROUTES_EDITOR_LIMITS.simulationSteps) {
    state.error = 'Достигнут предел 200 шагов. Начните новый сценарий.';

    return;
  }
  if (state.stale || state.generation !== store.editGeneration
    || state.draftRevision !== store.serverSnapshot?.revision
    || store.dirty || store.saving || store.conflict || store.jsonBuffer?.dirty) {
    state.stale = true;
    state.error = 'Черновик изменился. Начните сценарий заново после сохранения.';

    return;
  }

  const runtime = runtimeOf(store);
  const identity = runtime.openRequest;

  state.busy = true;
  state.error = '';

  try {
    const result = await runtime.api.stepDraftSimulation(opened.profile, opened.draftId, {
      expectedRevision: state.draftRevision,
      cursor: state.cursor,
      counters: state.counters,
      ...observation,
      pinned: state.pinned,
      stepIndex: state.stepIndex,
    });

    if (identity !== runtime.openRequest || store.simulation !== state) {
      return;
    }
    if (state.generation !== store.editGeneration
      || state.draftRevision !== store.serverSnapshot?.revision) {
      state.stale = true;

      return;
    }

    state.last = result;

    if (!result.ok || !result.cursor || !result.counters) {
      state.error = result.issues.map((issue) => issue.message).join(' · ')
        || 'Движок отклонил шаг сценария.';

      return;
    }

    state.cursor = result.cursor;
    state.counters = result.counters;
    state.pendingHuman = result.requiresHuman ? observation : null;
    state.stepIndex += 1;
  } catch (error) {
    if (identity === runtime.openRequest && store.simulation === state) {
      state.error = failureText(error, 'Не удалось выполнить пробный шаг.');
    }
  } finally {
    if (identity === runtime.openRequest && store.simulation === state) {
      state.busy = false;
    }
  }
}

/** Продолжает только ожидающее явного выбора ветвление. */
/**
 * Продолжает остановленную на решении человека симуляцию.
 * Симуляция читает снимок каталога и не выполняет агентские команды.
 */
export async function approveRouteSimulation(): Promise<void> {
  const observation = useRoutesStore().simulation?.pendingHuman;

  if (!observation) {
    return;
  }

  await stepRouteSimulation({ ...observation, humanApproved: true });
}

/**
 * Удаляет локальное состояние и ошибку пробного прохода.
 * Симуляция читает снимок каталога и не выполняет агентские команды.
 */
export function resetRouteSimulation(): void {
  const store = useRoutesStore();

  store.simulation = null;
  store.simulationError = '';
}
