<template>
  <section class="native-settings" data-testid="native-settings">
    <header class="native-settings__heading">
      <div class="native-settings__intro">
        <h4>Дополнительные настройки</h4>
        <p class="native-settings__scope">Для чатов Cockpit · со следующего запуска</p>
      </div>
      <UiButton
        variant="ghost"
        :disabled="state.loading || state.saving"
        aria-label="Обновить список настроек"
        @click="store.load(providerId, true)"
      >
        Обновить
      </UiButton>
    </header>
    <UiInlineMessage v-if="state.loading">Проверяем настройки…</UiInlineMessage>
    <UiInlineMessage v-if="state.error" tone="danger">{{ state.error }}</UiInlineMessage>
    <UiInlineMessage v-if="state.catalog?.state === 'stale'" tone="warning">
      Не удалось обновить настройки. Сохранённый выбор можно сбросить.
    </UiInlineMessage>
    <UiInlineMessage v-else-if="state.catalog?.state === 'unavailable'" tone="warning">
      Настройки исполнителя сейчас недоступны.
    </UiInlineMessage>
    <div v-if="allFields.editableCount > 1 || query" class="native-settings__search">
      <UiField>
        <UiInput v-model="query" type="search" aria-label="Поиск настроек" placeholder="Найти параметр…" />
      </UiField>
      <span class="native-settings__count">
        {{ query.trim() ? 'Найдено' : 'Всего' }}: {{ fields.editableCount }}
      </span>
    </div>
    <p v-if="fields.editable.length" class="native-settings__hint">
      «Сбросить» возвращает значение исполнителя. Списки сохраняются отдельной кнопкой.
    </p>
    <p v-if="state.catalog && !state.loading && !fields.editable.length" class="native-settings__empty">
      {{ query.trim()
        ? 'Параметры не найдены. Попробуйте другое название.'
        : 'Дополнительных параметров для изменения сейчас нет.' }}
    </p>
    <div class="native-settings__fields">
      <ProviderSettingNode
        v-for="field in fields.editable"
        :key="field.id"
        :field="field"
        :draft="state.drafts[field.id]"
        :error="state.errors[field.id]"
        :busy="state.saving"
        :drafts="state.drafts"
        :errors="state.errors"
        :expand="Boolean(query.trim())"
        @draft="(id, value) => store.draft(providerId, id, value)"
        @set="(id, value) => store.save(providerId, id, value)"
        @unset="(id) => store.reset(providerId, id)"
      />
    </div>
    <div v-if="state.catalog?.inactiveOverrides.length" class="native-settings__inactive">
      <h5>Сохранённые параметры требуют внимания</h5>
      <div
        v-for="field in state.catalog.inactiveOverrides"
        :key="field.id"
        class="native-settings__inactive-row"
      >
        <div>
          <strong>{{ field.label }}</strong>
          <p>{{ field.reason }}</p>
        </div>
        <UiButton :disabled="state.saving" @click="store.reset(providerId, field.id)">Удалить выбор</UiButton>
      </div>
    </div>
    <p class="native-settings__feedback" role="status" aria-live="polite">
      {{ feedback }}
    </p>
  </section>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { UiButton, UiField, UiInlineMessage, UiInput } from '../../ui.ts';
import { useProviderSettingsStore } from '../../stores/providerSettings.ts';
import ProviderSettingNode from './ProviderSettingNode.vue';
import { nativeSettingsFields } from './nativeSettingsFields.ts';

const props = defineProps<{ providerId: string; active: boolean }>();

const store = useProviderSettingsStore();
const state = computed(() => store.panel(props.providerId));
const query = ref('');

// Недоступные ветки остаются в каталоге и проекции, но справочник пока не показывается.
// Сохранённый выбор со сбросом и незавершённый ввод сохраняют доступные человеку действия.
const allFields = computed(() => nativeSettingsFields(
  state.value.catalog?.fields ?? [],
  '',
  state.value.drafts,
  state.value.errors,
));
const fields = computed(() => nativeSettingsFields(
  state.value.catalog?.fields ?? [],
  query.value,
  state.value.drafts,
  state.value.errors,
));
const feedback = computed(() => {
  if (state.value.saving) {
    return 'Сохраняем…';
  }

  const unfinished = Object.keys(state.value.drafts).length > 0
    || Object.values(state.value.errors).some(Boolean);

  return unfinished ? '' : state.value.message;
});

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Панель монтируется также под v-show, поэтому только active разрешает discovery.
 * Один таймер принадлежит открытой панели и снимается при закрытии или уходе.
 */
function updateActivity(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }

  if (props.active) {
    void store.load(props.providerId);
    timer = setInterval(() => void store.load(props.providerId), 60_000);
  }
}

watch(() => [props.providerId, props.active], updateActivity, { immediate: true });
onUnmounted(() => {
  if (timer !== null) {
    clearInterval(timer);
  }
});
</script>

<style scoped>
.native-settings {
  display: grid;
  min-width: 0;
  gap: 12px;
  padding-top: 16px;
  border-top: 1px solid var(--line);
  container: native-settings / inline-size;
  overflow-wrap: anywhere;
}

.native-settings__heading,
.native-settings__search,
.native-settings__inactive-row {
  display: flex;
  flex-wrap: wrap;
  align-items: start;
  justify-content: space-between;
  gap: 8px 12px;
}

.native-settings h4,
.native-settings h5,
.native-settings p {
  margin: 0;
}

.native-settings h4 {
  font-size: 14px;
}

.native-settings__intro,
.native-settings__fields,
.native-settings__inactive {
  display: grid;
  min-width: 0;
  gap: 8px;
}

.native-settings__intro {
  flex: 1 1 180px;
  gap: 3px;
}

.native-settings__scope,
.native-settings__hint,
.native-settings__count,
.native-settings__inactive p {
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.5;
}

.native-settings__search > :first-child {
  flex: 1 1 180px;
}

.native-settings__count {
  align-self: center;
}

.native-settings__empty {
  padding-block: 12px;
  color: var(--ink-mid);
}

.native-settings__inactive {
  padding: 12px;
  border: 1px solid color-mix(in srgb, var(--warn) 35%, var(--line));
  border-radius: 10px;
}

.native-settings__inactive h5 {
  color: var(--warn);
  font-size: 12px;
}

.native-settings__feedback {
  min-height: 18px;
  color: var(--good);
  font-size: 12px;
}
</style>
