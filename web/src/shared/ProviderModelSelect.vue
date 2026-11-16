<template>
  <UiSelect
    ref="select"
    v-bind="$attrs"
    data-provider-model-select
    searchable
    group-navigation
    :model-value="modelValue"
    :compact="compact"
    :disabled="disabled"
    @update:model-value="emit('update:modelValue', String($event ?? ''))"
    @change="emit('change', $event)"
    @focus="emit('focus', $event)"
    @blur="emit('blur', $event)"
  >
    <slot />
    <template #value-leading>
      <ProviderIcon v-if="selected" :provider="selected.provider" :size="14"
                    :style="{ color: selected.provider.color }" />
    </template>
    <template #value="{ option, value }">
      <slot name="value" :option="option" :value="value">
        {{ option?.label || selected?.model.name || fallbackLabel || value }}
      </slot>
    </template>
    <template #group-leading="{ option }">
      <ProviderIcon v-if="entries.get(option.value)" :provider="entries.get(option.value)!.provider"
                    :size="16" :style="{ color: entries.get(option.value)!.provider.color }" />
    </template>
    <template #option-leading="{ option }">
      <ProviderIcon v-if="entries.get(option.value)" :provider="entries.get(option.value)!.provider"
                    :size="14" :style="{ color: entries.get(option.value)!.provider.color }" />
    </template>
    <template v-if="incomplete.length" #footer="{ close }">
      <UiButton v-for="provider in incomplete" :key="provider.id" variant="ghost" size="compact"
        data-model-provider-setup :data-provider-id="provider.id"
        @click="configure(close, provider.id)">
        {{ provider.name }} · {{ provider.readiness.label }}
      </UiButton>
    </template>
  </UiSelect>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';

import { UiButton, UiSelect, uiLocale, type UiSelectOptionSnapshot, type UiSelectValue } from '../ui.ts';
import type { ProviderModelEntry } from '../../../shared/chat/providersContracts.ts';
import ProviderIcon from './ProviderIcon.vue';
import { openSettings } from './settingsNavigation.ts';
import { providerChatReadiness } from '../features/providers/providerLocale.ts';
import {
  modelSelectValue,
  type ModelSelectProvider,
  type ModelSelectValueFormat,
} from './providerModelSelect.ts';

defineOptions({ inheritAttrs: false });

const props = withDefaults(defineProps<{
  providers: readonly ModelSelectProvider[];
  modelValue?: string;
  valueFormat?: ModelSelectValueFormat;
  fallbackLabel?: string;
  compact?: boolean;
  disabled?: boolean;
}>(), {
  modelValue: '',
  valueFormat: 'modelRef',
  fallbackLabel: '',
  compact: false,
  disabled: false,
});

defineSlots<{
  default(): unknown;
  value?(props: { option: UiSelectOptionSnapshot | undefined; value: UiSelectValue }): unknown;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: string];
  change: [event: Event];
  focus: [event: FocusEvent];
  blur: [event: FocusEvent];
}>();
const select = ref<InstanceType<typeof UiSelect> | null>(null);
const incomplete = computed(() => props.providers.flatMap((provider) => {
  const readiness = providerChatReadiness(provider, uiLocale);

  return readiness && !readiness.available && (provider.installed || provider.available)
    ? [{ ...provider, readiness }] : [];
}));
const entries = computed(() => {
  const result = new Map<string, {
    provider: ModelSelectProvider;
    model: ProviderModelEntry;
  }>();

  for (const provider of props.providers) {
    for (const model of provider.models ?? []) {
      const value = modelSelectValue(provider.id, model.id, props.valueFormat);

      if (!result.has(value)) {
        result.set(value, { provider, model });
      }
    }
  }

  return result;
});
const selected = computed(() => entries.value.get(props.modelValue));

/**
 * Настройка открывается поверх исходного экрана после закрытия списка.
 * Модель и память разговора до выбора человека остаются прежними.
 */
function configure(close: () => void, providerId?: string): void {
  close();
  openSettings({ pageId: 'agents.providers', entityId: providerId });
}

defineExpose({
  get el() {
    return select.value?.el ?? null;
  },
  get triggerEl() {
    return select.value?.triggerEl ?? null;
  },
  focus: (options?: FocusOptions) => select.value?.focus(options),
});
</script>
