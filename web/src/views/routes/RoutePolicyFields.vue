<template>
  <fieldset class="route-policy-fields">
    <legend>Права и исполнение</legend>
    <label>Файловая политика
      <UiSelect data-test="policy-filesystem" :model-value="policy.filesystem"
                @update:model-value="changePolicy('filesystem', String($event ?? ''))">
        <option v-if="!filesystems.includes(policy.filesystem)" :value="policy.filesystem">
          {{ policy.filesystem }} (недоступно)
        </option>
        <option v-for="value in filesystems" :key="value" :value="value">{{ value }}</option>
      </UiSelect>
    </label>
    <label>Браузер
      <UiSelect data-test="policy-browser" :model-value="policy.browser ?? 'forbid'"
                @update:model-value="changePolicy('browser', String($event ?? ''))">
        <option value="forbid">Запрещён</option>
        <option value="allow">Разрешён</option>
      </UiSelect>
    </label>
    <label>Класс времени
      <UiSelect data-test="policy-timeout-class" :model-value="policy.timeoutClass ?? ''"
                @update:model-value="changePolicy('timeoutClass', String($event ?? ''))">
        <option v-if="policy.timeoutClass && !timeouts.includes(policy.timeoutClass)"
                :value="policy.timeoutClass">{{ policy.timeoutClass }} (недоступно)</option>
        <option v-for="value in timeouts" :key="value" :value="value">{{ value }}</option>
      </UiSelect>
    </label>
    <label>Класс бюджета
      <UiInput data-test="policy-budget-class" :model-value="policy.budgetClass ?? ''"
               @update:model-value="changePolicy('budgetClass', String($event ?? ''))" />
    </label>
    <label>Режим параллелизма
      <UiSelect data-test="fanout-mode" :model-value="fanout.mode"
                @update:model-value="changeFanout('mode', String($event ?? ''))">
        <option value="single">Один исполнитель</option>
        <option value="parallel">Параллельно</option>
      </UiSelect>
    </label>
    <label>Максимум исполнителей
      <UiNumberInput data-test="fanout-max" :min="1" :model-value="fanout.maxExecutors"
                     @update:model-value="changeFanout('maxExecutors', Number($event))" />
    </label>
    <label>При отказе параллелизма
      <UiSelect data-test="fanout-degrade" :model-value="fanout.degrade"
                @update:model-value="changeFanout('degrade', String($event ?? ''))">
        <option value="forbid">Запретить</option>
        <option value="allow-single">Разрешить один исполнитель</option>
      </UiSelect>
    </label>
    <p v-if="fanout.mode === 'parallel' && policy.filesystem !== 'state-only'" class="bad">
      parallel поддерживается только с state-only. Выберите один исполнитель или смените файловую политику.
    </p>
  </fieldset>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { RouteFanout, RoutePolicy } from '../../../../shared/pipeline/routeDefinition.ts';
import type { RouteEditorInfo } from '../../../../shared/pipeline/routesEditorContracts.ts';
import { UiInput, UiNumberInput, UiSelect } from '../../ui';

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
