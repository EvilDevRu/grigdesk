<template>
  <section class="route-simulation">
    <h3>{{ t('core.routeProbnyyStsenariy') }}</h3>
    <p class="muted">{{ t('core.routeZadayteNablyudaemyeIshodyUzlov') }}</p>
    <div class="route-simulation__controls">
      <label>{{ t('core.routeNachatS') }} <UiSelect v-model="startTarget" data-test="simulation-start-target">
          <option value="bootstrap">{{ t('core.routeRazvedkaScout') }}</option>
          <option v-for="routeId in routeIds" :key="routeId" :value="routeId"> {{ t('core.routeMarshrut') }} {{ routeId }}
          </option>
        </UiSelect>
      </label>
      <UiCheckbox v-model="pinned">{{ t('core.routeZakreplennyyMarshrut') }}</UiCheckbox>
      <label v-if="startIsLoop">{{ t('core.routePotolokKrugov') }} <UiNumberInput v-model="loopMaxRounds" data-test="simulation-loop-max-rounds"
                       :min="1" :max="ROUTES_EDITOR_LIMITS.loopMaxRounds" />
      </label>
      <UiButton data-test="simulation-start" @click="start">{{ t('core.routeNachatZanovo') }}</UiButton>
    </div>
    <p v-if="simulation?.stale" class="bad" role="alert"> {{ t('core.routeStsenariyUstarelPoslePravki') }} </p>
    <p v-if="simulation?.error" class="bad" role="alert">{{ simulation.error }}</p>
    <template v-if="simulation">
      <p>{{ t('core.routeShag') }} {{ Math.min(simulation.stepIndex, stepLimit) }} {{ t('settings.from') }} {{ stepLimit }} {{ t('core.routeUzel') }} <strong>{{ simulation.cursor.nodeId }}</strong>
        <span v-if="simulation.cursor.routeId"> · {{ simulation.cursor.routeId }}</span>
        <span v-if="simulation.loopMaxRounds !== null"> {{ t('core.routePotolokKrugov2') }} {{ simulation.loopMaxRounds }}</span>
      </p>
      <p v-if="simulation.cursor.terminal">{{ t('core.routeStsenariyOstanovlenProdolzhenieVozmozhno') }}</p>
      <div class="route-simulation__controls">
        <label>{{ t('core.routeNablyudaemyyIshod') }} <UiSelect v-model="outcome" data-test="simulation-outcome">
            <option v-for="option in outcomes" :key="option" :value="option">
              {{ outcomeLabel(option) }}
            </option>
          </UiSelect>
        </label>
        <label v-if="failureOwners.length && effectiveOutcome === 'failed'">{{ t('core.routePrichinaOtkaza') }} <UiSelect v-model="failureOwner" data-test="simulation-failure-owner">
            <option value="">{{ t('core.routeBezUtochneniya') }}</option>
            <option v-for="owner in failureOwners" :key="owner" :value="owner">
              {{ failureOwnerLabel(owner) }}
            </option>
          </UiSelect>
        </label>
        <label v-if="escalationRoutes.length">{{ t('core.routeVybrannyyMarshrut') }} <UiSelect v-model="selectedRouteId" data-test="simulation-route">
            <option value="">{{ t('core.routeBezVybora') }}</option>
            <option v-for="routeId in escalationRoutes" :key="routeId" :value="routeId">
              {{ routeId }}
            </option>
          </UiSelect>
        </label>
        <UiButton data-test="simulation-step" :disabled="!canStep" @click="step"> {{ t('core.routeProveritShag') }} </UiButton>
      </div>
      <p v-if="escalationRoutes.length && !selectedRouteId" class="muted"> {{ t('core.routeVyberiteTselevoyMarshrutPered') }} </p>
      <div v-if="simulation.pendingHuman" class="route-simulation__decision">
        <p>{{ t('core.routeTrebuetsyaReshenieChelovekaZakreplennyy') }}</p>
        <UiButton data-test="simulation-approve" :disabled="simulation.busy || simulation.stale"
                  @click="emit('approve')">{{ t('core.routePodtverditVybor') }}</UiButton>
      </div>
      <div v-if="simulation.last" class="route-simulation__result">
        <p v-if="simulation.last.stop">{{ t('core.routeOstanovka') }} {{ stopLabel(simulation.last.stop) }}</p>
        <p v-if="simulation.last.reset?.length"> {{ t('core.routeSbrosUzlov') }} {{ simulation.last.reset.join(', ') }}
        </p>
        <p v-if="simulation.last.escalation?.length"> {{ t('core.routeDopustimyeMarshruty') }} {{ simulation.last.escalation.join(', ') }}
        </p>
        <ul v-if="simulation.last.issues.length">
          <li v-for="(issue, index) in simulation.last.issues" :key="index">
            {{ issue.message }}
          </li>
        </ul>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import {
  ROUTES_EDITOR_LIMITS, ROUTES_LOOP_DEFAULT_MAX_ROUNDS, routeSimulationStepLimit,
} from '../../../../shared/pipeline/routesEditorContracts.ts';
import type { RouteDraft } from '../../../../shared/pipeline/routesEditorContracts.ts';
import type { RouteSimulationObservation, RouteSimulationState } from '../../stores/routes.ts';
import { UiButton, UiCheckbox, UiNumberInput, UiSelect, t } from '../../ui';
import type { UiNumberValue } from '../../ui';
import { outcomeNames } from './routeLabels.ts';

const props = defineProps<{
  document: RouteDraft;
  simulation: RouteSimulationState | null;
}>();
const emit = defineEmits<{
  start: [
    scope: 'route' | 'bootstrap', routeId: string | null, pinned: boolean,
    loopMaxRounds: number | null,
  ];
  step: [observation: RouteSimulationObservation];
  approve: [];
}>();
const startTarget = ref('bootstrap');
const pinned = ref(false);
const loopMaxRounds = ref<UiNumberValue>(ROUTES_LOOP_DEFAULT_MAX_ROUNDS);
const outcome = ref('done');
const failureOwner = ref('');
const selectedRouteId = ref('');

const ownerNames: Record<string, string> = {
  get build() {
    return t('core.codeBranchBuildCommand');
  },
  get tests() {
    return t('core.routeTesty');
  },
  get environment() {
    return t('core.routeSreda');
  },
  get plan() {
    return t('core.routePlan');
  },
  get human() {
    return t('core.routeReshenieCheloveka');
  },
};
const stopNames: Record<string, string> = {
  get human() {
    return t('core.routeNuzhnoReshenieCheloveka');
  },
  get failed() {
    return t('settings.error');
  },
  get done() {
    return t('core.routeZaversheno');
  },
  get 'rewind-limit'() {
    return t('core.routeIscherpanLimitVozvratov');
  },
  get 'loop-ceiling'() {
    return t('core.routeIscherpanPotolokKrugovTsikla');
  },
};
const routeIds = computed(() => Object.keys(props.document.routes).sort());
const startIsLoop = computed(() => startTarget.value !== 'bootstrap'
  && Boolean(props.document.routes[startTarget.value]?.route.loop));
const stepLimit = computed(() => routeSimulationStepLimit(props.simulation?.loopMaxRounds));
const machine = computed(() => {
  const cursor = props.simulation?.cursor;

  if (!cursor) {
    return null;
  }

  return cursor.scope === 'bootstrap' ? props.document.bootstrap
    : props.document.routes[cursor.routeId ?? '']?.route ?? null;
});
const node = computed(() => machine.value?.nodes.find(
  (item) => item.id === props.simulation?.cursor.nodeId,
) ?? null);
const outcomes = computed(() => [
  ...Object.keys(node.value?.on ?? {}),
  ...(node.value?.executor === 'agent' ? ['noResult'] : []),
]);
const effectiveOutcome = computed(() => outcomes.value.includes(outcome.value)
  ? outcome.value : outcomes.value[0] ?? '');
const failureOwners = computed(() => Object.keys(node.value?.onFailure ?? {}));
const escalationRoutes = computed(() => {
  const action = effectiveOutcome.value === 'failed' && failureOwner.value
    ? node.value?.onFailure?.[failureOwner.value]
    : node.value?.on?.[effectiveOutcome.value];

  return action?.escalate?.routes ?? [];
});
const canStep = computed(() => Boolean(props.simulation && !props.simulation.busy
  && !props.simulation.stale && !props.simulation.pendingHuman
  && !props.simulation.cursor.terminal && props.simulation.stepIndex <= stepLimit.value
  && effectiveOutcome.value && (!escalationRoutes.value.length
    || escalationRoutes.value.includes(selectedRouteId.value))));

watch(() => props.simulation?.cursor.nodeId, () => {
  outcome.value = 'done';
  failureOwner.value = '';
  selectedRouteId.value = '';
});

/**
 * Запускает пробный проход выбранного маршрута или разведки.
 * Панель задаёт наблюдения, а исполнение остаётся чистой моделью движка.
 */
function start(): void {
  const rounds = typeof loopMaxRounds.value === 'number' ? loopMaxRounds.value : Number.NaN;

  emit('start', startTarget.value === 'bootstrap' ? 'bootstrap' : 'route',
    startTarget.value === 'bootstrap' ? null : startTarget.value, pinned.value,
    startIsLoop.value ? rounds : null);
}

function outcomeLabel(value: string): string {
  return outcomeNames[value] ?? value;
}

function failureOwnerLabel(value: string): string {
  return ownerNames[value] ?? value;
}

function stopLabel(value: string): string {
  return stopNames[value] ?? value;
}

/**
 * Передаёт исход текущего шага и выбранного владельца ошибки.
 * Панель задаёт наблюдения, а исполнение остаётся чистой моделью движка.
 */
function step(): void {
  if (!canStep.value) {
    return;
  }

  emit('step', {
    outcome: effectiveOutcome.value,
    failureOwner: effectiveOutcome.value === 'failed' && failureOwner.value
      ? failureOwner.value : null,
    selectedRouteId: escalationRoutes.value.length && selectedRouteId.value
      ? selectedRouteId.value : null,
    humanApproved: false,
  });
}
</script>

<style scoped>
.route-simulation { border: 1px solid var(--line); border-radius: 8px; padding: 12px; }
.route-simulation__controls { display: flex; flex-wrap: wrap; align-items: end; gap: 10px; }
.route-simulation__controls label { display: grid; gap: 5px; }
.route-simulation__decision { border: 1px solid var(--line); border-radius: 6px; padding: 10px; }
.bad { color: var(--bad); }
</style>
