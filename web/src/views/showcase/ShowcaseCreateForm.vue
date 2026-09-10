<template>
  <form class="showcase-create" @submit.prevent="submit">
    <div class="showcase-create__row">
      <UiField label="Профиль показа" :hint="profileHint">
        <UiSelect v-model="profile" :disabled="busy || !profiles.length">
          <option v-if="!profiles.length" value="">нет профилей с объявленным показом</option>
          <option
            v-for="item in profiles"
            :key="item.id"
            :value="item.id"
            :disabled="!item.ready"
          >
            {{ item.ready ? item.id : `${item.id} — ${item.reason}` }}
          </option>
        </UiSelect>
      </UiField>

      <UiField
        v-if="kind !== 'project'"
        label="Номер стенда"
        :hint="taskHint"
        :error="taskError"
      >
        <UiInput
          v-model.trim="task"
          :disabled="busy"
          inputmode="numeric"
          placeholder="например, 990001"
        />
      </UiField>
    </div>

    <UiField label="Что показываем" hint="Стенд снимается только у поднятой песочницы.">
      <UiSegmentedControl v-model="kind" :options="KIND_OPTIONS" :disabled="busy" />
    </UiField>

    <UiField label="Название ролика" hint="Можно оставить пустым — название задаётся позже.">
      <UiInput v-model="title" :disabled="busy" placeholder="Новый ролик" />
    </UiField>

    <div class="showcase-create__footer">
      <p class="showcase-create__note">
        Ролик заводится сразу с проверкой цели: если стенда нет или профиль не объявил
        экраны, карточка скажет об этом до первой записи.
      </p>
      <UiButton
        type="submit"
        variant="solid"
        tone="accent"
        :loading="busy"
        :aria-disabled="!canSubmit"
      >
        Завести ролик
      </UiButton>
    </div>
  </form>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import {
  UiButton,
  UiField,
  UiInput,
  UiSegmentedControl,
  UiSelect,
} from '../../ui';
import type { ShowcaseTargetProfile } from '../../../../shared/showcaseContracts';

type TargetKind = 'project' | 'sandbox' | 'task';

const props = defineProps<{
  profiles: ShowcaseTargetProfile[];
  busy: boolean;
}>();

interface CreatePayload {
  kind: TargetKind;
  id: string;
  profile: string;
  title: string;
}

const emit = defineEmits<{
  create: [payload: CreatePayload];
}>();

const KIND_OPTIONS = [
  { value: 'project' as TargetKind, label: 'Проект' },
  { value: 'sandbox' as TargetKind, label: 'Песочница' },
  { value: 'task' as TargetKind, label: 'Задача' },
];

const TASK_RE = /^[1-9][0-9]{0,18}$/;

const profile = ref('');
const kind = ref<TargetKind>('project');
const task = ref('');
const title = ref('');

const profileHint = computed(() => (
  props.profiles.some((item) => item.ready)
    ? 'Адреса, экраны и вход берутся из объявления профиля.'
    : 'Ни один профиль не объявил показ: нужны showcase/target.json и showcase/screens.json.'
));

const taskHint = computed(() => (
  kind.value === 'task'
    ? 'Номер задачи B24: у неё должен быть поднятый стенд.'
    : 'Тот же номер, что и в разделе «Песочницы».'
));

// Пустое поле — это ещё не ошибка: человек только открыл форму. Ошибкой становится
// набранное значение, которое сервер всё равно отклонит.
const taskError = computed(() => (
  !task.value || TASK_RE.test(task.value) ? '' : 'Номер стенда — целое число.'
));

const canSubmit = computed(() => {
  if (props.busy || !profile.value) {
    return false;
  }

  return kind.value === 'project' || TASK_RE.test(task.value);
});

// Первый годный профиль подставляется сам: в типичной установке он один, и выбор
// ради единственного варианта только мешает.
watch(() => props.profiles, (list) => {
  if (!profile.value) {
    profile.value = list.find((item) => item.ready)?.id ?? '';
  }
}, { immediate: true });

/**
 * Отправка формы. Для показа проекта целью служит сам профиль, для стенда — его
 * номер: разными их делает не форма, а то, откуда сервер возьмёт адрес показа.
 */
function submit() {
  if (!canSubmit.value) {
    return;
  }

  emit('create', {
    kind: kind.value,
    id: kind.value === 'project' ? profile.value : task.value,
    profile: profile.value,
    title: title.value,
  });
  title.value = '';
}
</script>

<style scoped>
.showcase-create {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.showcase-create__row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.showcase-create__row > * {
  flex: 1 1 220px;
  min-width: 0;
}

.showcase-create__footer {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.showcase-create__note {
  margin: 0;
  flex: 1 1 320px;
  min-width: 0;
  color: var(--muted, #9aa4b2);
  font-size: 13px;
  line-height: 1.5;
}
</style>
