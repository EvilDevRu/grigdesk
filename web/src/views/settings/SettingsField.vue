<template>
  <div
    ref="element"
    :data-settings-field="JSON.stringify(address)"
    :data-revealed="revealed || undefined"
  >
    <UiField
      :label="metadata?.label"
      :hint="metadata?.description"
      :error="field?.error || field?.unavailable"
    >
      <slot />
    </UiField>
    <p v-if="field?.conflict" role="status">Параметр изменён снаружи.</p>
    <div v-if="field?.conflict" class="settings-field-actions">
      <UiButton @click="resolve('take-current')">Взять текущее</UiButton>
      <UiButton @click="resolve('keep-mine')">Оставить моё</UiButton>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUpdated, ref, watch } from 'vue';
import { UiField, UiButton } from '../../ui.ts';
import { equalFieldAddress } from '../../features/settings/catalog.ts';
import type { FieldAddress } from '../../features/settings/contracts.ts';
import { useSettingsStore } from '../../stores/settings.ts';

const props = defineProps<{ address: FieldAddress }>();
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
.settings-field-actions { display: flex; flex-wrap: wrap; gap: 8px; }
</style>
