<template>
  <UiDialog :open="open" :title="t('core.trackerSettings')" :busy="saving" :dismissible="!saving"
            :description="t('core.trackerSettingsIntro')" data-role="tracker-settings" data-ui-workspace
            initial-focus="#tracker-external" @update:open="emit('update:open', $event)">
    <template #title>
      <div class="tracker-settings__heading">
        <span class="tracker-settings__title">{{ t('core.trackerSettings') }}</span>
        <UiIconButton :label="t('core.close')" :disabled="saving" @click="emit('update:open', false)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
               stroke-linecap="round" aria-hidden="true">
            <path d="m6 6 12 12M18 6 6 18" />
          </svg>
        </UiIconButton>
      </div>
    </template>

    <div class="tracker-settings">
      <div class="tracker-settings__fields">
        <UiField id="tracker-external" :label="t('core.trackerExternal')"
                 :hint="t('core.trackerExternalHint')">
          <UiSelect v-model="externalId" :disabled="saving">
            <option value="">{{ t('core.trackerNone') }}</option>
            <option v-for="driver in externalDrivers" :key="driver.id" :value="driver.id">
              {{ driver.name }}{{ driver.reason ? ` — ${driver.reason}` : '' }}
            </option>
          </UiSelect>
        </UiField>
        <template v-for="(field, key) in selected?.schema ?? {}" :key="key">
          <UiField v-if="fieldVisible(field)" :label="fieldLabel(field.label, key)">
            <UiCheckbox v-if="field.type === 'boolean'" v-model="values[key]" :disabled="saving" />
            <UiSelect v-else-if="field.type === 'select'" :model-value="String(values[key] ?? '')"
                      :disabled="saving" @update:model-value="values[key] = $event ?? ''">
              <option value="" disabled>{{ t('core.trackerChooseOption') }}</option>
              <option v-for="option in field.options" :key="option.value" :value="option.value">
                {{ fieldLabel(option.label, option.value) }}
              </option>
            </UiSelect>
            <UiInput v-else :model-value="String(values[key] ?? '')"
                     :type="field.secret ? 'password' : 'text'"
                     @update:model-value="
                       values[key] = field.type === 'number' ? Number($event) : ($event ?? '')
                     "
                     :disabled="saving" autocomplete="off" />
          </UiField>
        </template>
      </div>

      <div class="tracker-settings__install">
        <div class="tracker-settings__copy">
          <h3>{{ t('core.trackerMoreIntegrations') }}</h3>
          <p>{{ t('core.trackerInstallHint') }}</p>
        </div>
        <UiButton :disabled="saving" @click="installOpen = true">
          <template #leading>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
                 stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 3v12m-5-5 5 5 5-5M5 16v4h14v-4" />
            </svg>
          </template>
          {{ t('core.trackerInstall') }}
        </UiButton>
      </div>

      <UiInlineMessage v-if="error" tone="danger">{{ error }}</UiInlineMessage>
      <UiInlineMessage v-else-if="saved" tone="success" role="status">
        {{ t('core.trackerSaved') }}
      </UiInlineMessage>
      <TrackerInstallDialog v-if="installOpen" v-model:open="installOpen" />
    </div>

    <template #footer>
      <UiFormActions class="tracker-settings__actions">
        <UiButton variant="ghost" :disabled="saving" @click="emit('update:open', false)">
          {{ t('core.close') }}
        </UiButton>
        <UiButton variant="solid" tone="accent" :loading="saving" :disabled="saving" @click="save">
          {{ t('core.trackerSave') }}
        </UiButton>
      </UiFormActions>
    </template>
  </UiDialog>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';

import type { TrackerLabel, TrackerSettingsField } from '../../../../shared/trackers/contracts.ts';
import { useTrackersStore } from '../../stores/trackers.ts';
import { api, failureText } from '../../shared/apiClient.ts';
import {
  t, resolveUiText, messageRef, UiButton, UiCheckbox, UiDialog, UiField, UiFormActions,
  UiIconButton, UiInlineMessage, UiInput, UiSelect,
} from '../../ui.ts';
import TrackerInstallDialog from './TrackerInstallDialog.vue';

defineProps<{ open: boolean }>();

const emit = defineEmits<{ 'update:open': [open: boolean] }>();
const trackers = useTrackersStore();
const externalId = ref('');
const revision = ref(0);
const savedValues = ref<Record<string, Record<string, unknown>>>({});
const values = ref<Record<string, string | boolean | number>>({});
const error = ref('');
const saving = ref(false);
const saved = ref(false);
const installOpen = ref(false);

const externalDrivers = computed(() =>
  trackers.catalog?.drivers.filter((driver) => driver.id !== 'own' && !driver.deleted) ?? [],
);
const selected = computed(() => externalDrivers.value.find((driver) => driver.id === externalId.value));

watch([externalId, values], () => {
  saved.value = false;
}, { deep: true });

/**
 * Подпись схемы переводится только при явном descriptor ключа.
 * Строка данных и запасное имя поля остаются буквальным текстом.
 */
function fieldLabel(value: TrackerLabel | undefined, fallback: string | number): string {
  if (typeof value === 'string') {
    return value;
  }

  return value ? 'text' in value ? value.text
    : resolveUiText(messageRef(value.key, value.params)) : String(fallback);
}

function fieldVisible(field: TrackerSettingsField): boolean {
  return !field.visibleIf || values.value[field.visibleIf.field] === field.visibleIf.equals;
}

watch(externalId, (id) => {
  values.value = Object.fromEntries(Object.entries(selected.value?.schema ?? {}).map(([key, field]) => [
    key,
    field.secret ? '' : savedValues.value[id]?.[key] ?? (field.type === 'boolean' ? false : ''),
  ])) as typeof values.value;
});

watch(() => trackers.catalog, (catalog) => {
  if (catalog?.drivers.some((driver) => driver.id === externalId.value && driver.deleted)) {
    externalId.value = catalog.externalId ?? '';
    revision.value = catalog.revision;
  }
});

/**
 * Диалог читает выбор с сервера и никогда не заполняет поле пароля секретом.
 * Ошибка загрузки оставляет форму видимой и не выдаёт локальное значение за сохранённое.
 */
async function load() {
  try {
    await trackers.load(true);

    const settings = await api.get('/api/trackers/settings') as {
      externalId: string | null;
      revision: number;
      settings: Record<string, Record<string, unknown>>;
    };

    savedValues.value = settings.settings;
    revision.value = settings.revision;
    externalId.value = settings.externalId ?? '';
  } catch (cause) {
    error.value = failureText(cause);
  }
}

/**
 * Сервер сравнивает ревизию перед сохранением выбора и реквизитов.
 * Неуспешная запись сохраняет введённые значения для исправления и повторной проверки.
 */
async function save() {
  if (saving.value) {
    return;
  }

  saving.value = true;
  saved.value = false;
  error.value = '';

  try {
    const visibleValues = Object.fromEntries(Object.entries(selected.value?.schema ?? {})
      .filter(([, field]) => fieldVisible(field))
      .map(([key]) => [key, values.value[key]]));
    const result = await trackers.saveSettings({
      externalId: externalId.value || null,
      settings: externalId.value ? { [externalId.value]: visibleValues } : {},
      expectedRevision: revision.value,
    }) as { revision: number };

    revision.value = result.revision;
    saved.value = true;
  } catch (cause) {
    error.value = failureText(cause);
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.tracker-settings {
  display: grid;
  gap: 22px;
  min-width: 0;
  overflow-wrap: anywhere;
}

.tracker-settings__heading {
  display: flex;
  align-items: center;
  gap: 16px;
  width: 100%;
}

.tracker-settings__title {
  flex: 1;
  min-width: 0;
}

.tracker-settings__copy {
  min-width: 0;
}

.tracker-settings__copy h3 {
  margin: 0;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
}

.tracker-settings__copy p {
  margin: 3px 0 0;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.5;
}

.tracker-settings__fields {
  display: grid;
  gap: 16px;
}

.tracker-settings__install {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding-top: 18px;
  border-top: 1px solid var(--line);
}

.tracker-settings__actions {
  width: 100%;
}

@media (max-width: 600px) {
  .tracker-settings__install {
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
  }
}
</style>
