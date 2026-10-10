<template>
  <UiDialog
    :title="chat ? 'Модель и эффорт' : 'Новый чат'"
    :confirm="intent ? 'Проверить действие' : chat ? 'Применить' : 'Создать чат'"
    :busy="busy"
    :disabled="!selected || (changesProvider && !reset)"
    @close="$emit('close')"
    @confirm="save"
  >
    <p v-if="catalog.busy" role="status">Загрузка моделей…</p>
    <UiError v-if="catalog.error" :text="catalog.error" @retry="catalog.load(true)" />
    <UiSelect v-model="choice" label="Модель" :options="models" :disabled="busy || Boolean(intent)" />
    <p v-if="selected && !selected.available" class="mobile-muted">
      Исполнитель сейчас недоступен. Перед отправкой проверьте подключение в Кокпите.
    </p>
    <UiSelect
      v-if="chat && selected?.efforts.length"
      v-model="effort"
      label="Эффорт"
      :options="efforts"
      :disabled="busy || Boolean(intent)"
    />
    <template v-if="changesProvider">
      <p>Исполнитель изменится. История останется, но память прежнего исполнителя будет сброшена.</p>
      <UiSwitch v-model="reset" :disabled="busy || Boolean(intent)">Сбросить память исполнителя</UiSwitch>
    </template>
    <p v-if="error" class="mobile-danger" role="alert">{{ error }}</p>
  </UiDialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import type { Chat, ChatModel } from '../api/contract.ts';
import { useChatMutation } from '../composables/useChatMutation.ts';
import { useChatControlsStore } from '../stores/chatControls.ts';
import { useLinkStore } from '../stores/link.ts';
import { UiDialog, UiError, UiSelect, UiSwitch } from '../ui.ts';

const props = defineProps<{ chat?: Chat['chat'] }>();
const emit = defineEmits<{ close: []; saved: [id: string] }>();
const catalog = useChatControlsStore();
const link = useLinkStore();
const { busy, error, intent, run } = useChatMutation();
const choice = ref('');
const effort = ref(props.chat?.effort || '');
const reset = ref(false);
const key = (model: ChatModel) => JSON.stringify([model.provider, model.id]);
const selected = computed(() => catalog.options?.models.find((model) => key(model) === choice.value));
const models = computed(() => [
  {
    value: '',
    label: 'Выберите модель',
    disabled: true,
  },
  ...(catalog.options?.models || []).map((model) => ({
    value: key(model),
    label: `${model.providerName} · ${model.name}`,
  })),
]);
const efforts = computed(() => [
  { value: '', label: 'Авто' },
  ...(selected.value?.efforts || []).map((value) => ({ value, label: value })),
]);
const previous = props.chat?.settings?.modelRef || props.chat?.modelRef;
const changesProvider = computed(() => Boolean(previous && selected.value
  && previous.provider !== selected.value.provider));

watch(() => catalog.options, (options) => {
  if (!choice.value && options) {
    const model = previous || options.defaultModelRef;

    choice.value = model ? JSON.stringify([model.provider, model.model]) : '';
  }
}, { immediate: true });
watch(choice, () => {
  reset.value = false;

  if (!selected.value?.efforts.includes(effort.value)) {
    effort.value = '';
  }
});

/**
 * Создание и смена модели завершаются только по подтверждённому результату сервера.
 * Ревизия берётся из снимка открытия формы, поэтому чужое изменение не затирается.
 */
async function save() {
  const model = selected.value;

  if (!model || (changesProvider.value && !reset.value)) {
    return;
  }

  const modelRef = { provider: model.provider, model: model.id };
  const result = await run((saved) => props.chat
    ? link.api!.configureChat(props.chat.id, {
      modelRef,
      effort: effort.value,
      reset: reset.value,
      actionToken: props.chat.actions.configure || '',
    }, saved)
    : link.api!.createChat(modelRef, saved));

  if (result) {
    emit('saved', result.id);
  }
}

void catalog.load(true);
</script>
