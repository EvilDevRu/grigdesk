<template>
  <fieldset class="route-retry-fields">
    <legend>Повторы</legend>
    <label>Без результата
      <UiNumberInput data-test="retry-no-result" :min="0" :model-value="retry.noResult"
                     @update:model-value="changeCount('noResult', Number($event))" />
    </label>
    <label>Ошибка результата
      <UiNumberInput data-test="retry-product-failure" :min="0" :model-value="retry.productFailure"
                     @update:model-value="changeCount('productFailure', Number($event))" />
    </label>
    <label>Попытки провайдера
      <UiNumberInput data-test="retry-provider-attempts" :min="0"
                     :model-value="retry.providerFailure.attempts"
                     @update:model-value="changeProvider('attempts', Number($event))" />
    </label>
    <label>Стратегия провайдера
      <UiSelect data-test="retry-provider-strategy" :model-value="retry.providerFailure.strategy"
                @update:model-value="changeProvider('strategy', String($event ?? ''))">
        <option v-if="!strategies.includes(retry.providerFailure.strategy)"
                :value="retry.providerFailure.strategy">
          {{ retry.providerFailure.strategy }} (недоступно)
        </option>
        <option v-for="value in strategies" :key="value" :value="value">{{ value }}</option>
      </UiSelect>
    </label>
    <p v-if="retry.providerFailure.strategy === 'same-runner'" class="bad">
      same-runner не поддерживается движком маршрутов. Выберите runner-failover или none.
    </p>
  </fieldset>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { RouteRetry } from '../../../../shared/pipeline/routeDefinition.ts';
import type { RouteEditorInfo } from '../../../../shared/pipeline/routesEditorContracts.ts';
import { UiNumberInput, UiSelect } from '../../ui';

const props = defineProps<{
  retry: RouteRetry;
  capabilities: RouteEditorInfo['capabilities'] | null;
}>();
const emit = defineEmits<{ 'update:retry': [retry: RouteRetry] }>();
const strategies = computed(() => props.capabilities?.retryStrategies ?? [
  'none', 'runner-failover',
]);

function changeCount(key: 'noResult' | 'productFailure', value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    return;
  }

  emit('update:retry', { ...props.retry, [key]: value });
}

function changeProvider(key: 'attempts' | 'strategy', value: number | string): void {
  if (key === 'attempts' && (!Number.isInteger(value) || Number(value) < 0)) {
    return;
  }

  emit('update:retry', { ...props.retry,
    providerFailure: { ...props.retry.providerFailure, [key]: value } });
}
</script>

<style scoped>
.route-retry-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 8px; border: 1px solid var(--line); }
.route-retry-fields legend { font-weight: 600; }
.route-retry-fields label { display: grid; gap: 4px; }
</style>
