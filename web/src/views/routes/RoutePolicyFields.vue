<template>
  <fieldset class="route-policy-fields">
    <legend>{{ t('core.routePravaIIspolnenie') }}</legend>
    <label>{{ t('core.routeFaylovayaPolitika') }} <UiSelect data-test="policy-filesystem" :model-value="policy.filesystem"
                @update:model-value="changePolicy('filesystem', String($event ?? ''))">
        <option v-if="!filesystems.includes(policy.filesystem)" :value="policy.filesystem">
          {{ policy.filesystem }} {{ t('core.routeNedostupno') }} </option>
        <option v-for="value in filesystems" :key="value" :value="value">{{ value }}</option>
      </UiSelect>
    </label>
    <label>{{ t('core.browserTitle') }} <UiSelect data-test="policy-browser" :model-value="policy.browser ?? 'forbid'"
                @update:model-value="changePolicy('browser', String($event ?? ''))">
        <option value="forbid">{{ t('core.routeZapreschen') }}</option>
        <option value="allow">{{ t('core.routeRazreshen') }}</option>
      </UiSelect>
    </label>
    <label>{{ t('core.routeKlassVremeni') }} <UiSelect data-test="policy-timeout-class" :model-value="policy.timeoutClass ?? ''"
                @update:model-value="changePolicy('timeoutClass', String($event ?? ''))">
        <option v-if="policy.timeoutClass && !timeouts.includes(policy.timeoutClass)"
                :value="policy.timeoutClass">{{ policy.timeoutClass }} {{ t('core.routeNedostupno') }}</option>
        <option v-for="value in timeouts" :key="value" :value="value">{{ value }}</option>
      </UiSelect>
    </label>
    <label>{{ t('core.routeKlassByudzheta') }} <UiInput data-test="policy-budget-class" :model-value="policy.budgetClass ?? ''"
               @update:model-value="changePolicy('budgetClass', String($event ?? ''))" />
    </label>
    <label>{{ t('core.routeRezhimParallelizma') }} <UiSelect data-test="fanout-mode" :model-value="fanout.mode"
                @update:model-value="changeFanout('mode', String($event ?? ''))">
        <option value="single">{{ t('core.routeOdinIspolnitel') }}</option>
        <option value="parallel">{{ t('core.routeParallelno') }}</option>
      </UiSelect>
    </label>
    <label>{{ t('core.routeMaksimumIspolniteley') }} <UiNumberInput data-test="fanout-max" :min="1" :model-value="fanout.maxExecutors"
                     @update:model-value="changeFanout('maxExecutors', Number($event))" />
    </label>
    <label>{{ t('core.routePriOtkazeParallelizma') }} <UiSelect data-test="fanout-degrade" :model-value="fanout.degrade"
                @update:model-value="changeFanout('degrade', String($event ?? ''))">
        <option value="forbid">{{ t('core.routeZapretit') }}</option>
        <option value="allow-single">{{ t('core.routeRazreshitOdinIspolnitel') }}</option>
      </UiSelect>
    </label>
    <p v-if="fanout.mode === 'parallel' && policy.filesystem !== 'state-only'" class="bad"> {{ t('core.routeParallelPodderzhivaetsyaTolkoS') }} </p>
  </fieldset>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { RouteFanout, RoutePolicy } from '../../../../shared/pipeline/routeDefinition.ts';
import type { RouteEditorInfo } from '../../../../shared/pipeline/routesEditorContracts.ts';
import { UiInput, UiNumberInput, UiSelect, t } from '../../ui';

const props = defineProps<{
  policy: RoutePolicy;
  fanout: RouteFanout;
  capabilities: RouteEditorInfo['capabilities'] | null;
}>();
const emit = defineEmits<{
  'update:policy': [policy: RoutePolicy];
  'update:fanout': [fanout: RouteFanout];
}>();
const filesystems = computed(() => props.capabilities?.filesystem ?? [
  'state-only', 'workspace-write', 'transactional-write',
]);
const timeouts = computed(() => props.capabilities?.timeoutClasses ?? [
  'planning', 'standard', 'review', 'delivery', 'check', 'test', 'build', 'diagnostic', 'browser',
]);

function changePolicy(key: keyof RoutePolicy, value: string): void {
  emit('update:policy', { ...props.policy, [key]: value });
}

function changeFanout(key: keyof RouteFanout, value: string | number): void {
  if (key === 'maxExecutors' && (!Number.isInteger(value) || Number(value) < 1)) {
    return;
  }

  emit('update:fanout', { ...props.fanout, [key]: value });
}
</script>

<style scoped>
.route-policy-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 8px; border: 1px solid var(--line); }
.route-policy-fields legend { font-weight: 600; }
.route-policy-fields label { display: grid; gap: 4px; }
</style>
