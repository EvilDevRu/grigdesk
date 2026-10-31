<template>
  <div
    ref="element"
    class="settings-field"
    data-ui-settings-field
    :data-layout="layout"
    :data-settings-field="JSON.stringify(address)"
    :data-revealed="revealed || undefined"
    :data-dirty="field?.dirty || undefined"
    :data-conflict="field?.conflict || undefined"
  >
    <UiField
      :label="metadata?.label"
      :hint="metadata?.description"
      :error="field?.error || field?.unavailable"
    >
      <slot />
    </UiField>
    <UiInlineMessage v-if="field?.conflict" tone="warning">{{ t('settings.theSettingWasChangedExternally') }}</UiInlineMessage>
    <div v-if="field?.conflict" class="settings-field-actions">
      <UiButton data-context="workspace-form-wrap" @click="resolve('take-current')">{{ t('settings.useCurrent') }}</UiButton>
      <UiButton data-context="workspace-form-wrap" @click="resolve('keep-mine')">{{ t('settings.keepMine') }}</UiButton>
    </div>
  </div>
</template>

<script setup lang="ts">
import { t } from '../../ui.ts';

import { computed, onMounted, onUpdated, ref, watch } from 'vue';
import { UiField, UiButton, UiInlineMessage } from '../../ui.ts';
import { equalFieldAddress } from '../../features/settings/catalog.ts';
import type { FieldAddress } from '../../features/settings/contracts.ts';
import { useSettingsStore } from '../../stores/settings.ts';

const props = withDefaults(defineProps<{
  address: FieldAddress;
  layout?: 'row' | 'stack';
}>(), { layout: 'row' });
const settings = useSettingsStore();
const element = ref<HTMLElement>();
const revealed = ref(false);
const metadata = computed(() => settings.fieldMetadata(props.address));
const resource = computed(() => settings.snapshot.resources.find((item) =>
  item.fields.some((field) => equalFieldAddress(field.address, props.address))));
const field = computed(() => resource.value?.fields.find((item) =>
  equalFieldAddress(item.address, props.address)));

/**
 * Само поле готово к фокусу и при ленивом импорте, и после загрузки каталога.
 * Сравнение сегментов адреса исключает коллизии точек и слешей динамических ключей.
 */
function reveal(): void {
  if (!element.value || !equalFieldAddress(props.address, settings.revealTarget)) {
    return;
  }

  element.value.scrollIntoView?.({ block: 'nearest' });
  element.value.querySelector<HTMLElement>('input, select, textarea, button, [tabindex="0"]')?.focus();
  revealed.value = true;
  settings.revealTarget = null;
}

function resolve(choice: 'take-current' | 'keep-mine'): void {
  if (resource.value && field.value) {
    settings.resolveConflict(resource.value.id, field.value.key, choice);
  }
}

onMounted(reveal);
onUpdated(reveal);
watch(() => settings.revealTarget, reveal, { flush: 'post' });
</script>

<style scoped>
.settings-field {
  display: grid;
  gap: 10px;
  scroll-margin-block: 16px;
}
.settings-field[data-dirty='true'], .settings-field[data-revealed='true'] {
  border-bottom-color: color-mix(in srgb, var(--accent) 65%, var(--line));
}
.settings-field[data-conflict='true'] {
  border-bottom-color: var(--warn);
}
.settings-field-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
</style>
