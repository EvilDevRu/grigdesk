<template>
  <form class="sandbox-raise" @submit.prevent="submit">
    <div class="sandbox-raise__row">
      <UiField label="Профиль" :error="profileError"
               help="Профиль определяет проект и способ подготовки стенда: код, контейнеры и базы данных.">
        <UiSelect v-model="profile" :disabled="!options.length || busy">
          <option v-if="!options.length" value="">нет профилей с песочницей</option>
          <option v-for="item in options" :key="item.id" :value="item.id">{{ item.id }}</option>
        </UiSelect>
      </UiField>

      <UiField
        label="Номер задачи"
        :error="taskError"
        help="Укажите номер задачи из портала. Позже её можно запустить по конвейеру на этом же стенде."
      >
        <UiInput
          v-model.trim="task"
          :disabled="withoutTask || busy"
          inputmode="numeric"
          :placeholder="taskPlaceholder"
        />
      </UiField>
    </div>

    <UiSwitch v-model="withoutTask" :disabled="busy">Без привязки к задаче</UiSwitch>
    <p class="sandbox-raise__note">{{ taskHint }}</p>

    <div class="sandbox-raise__footer">
      <p class="sandbox-raise__note">
        Подготовка занимает 12–15 минут и один слот стенда. Вкладку можно закрыть.
      </p>
      <UiButton
        type="submit"
        variant="solid"
        tone="accent"
        data-context="workspace-form"
        :loading="busy"
        :aria-disabled="!canSubmit"
      >
        Поднять стенд
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
  UiSelect,
  UiSwitch,
} from '../../ui';
import { SANDBOX_TASK_RE } from '../../../../shared/plugins/sandboxes/sandboxContracts';
import type { SandboxProfile } from '../../../../shared/plugins/sandboxes/sandboxContracts';

const props = defineProps<{
  options: SandboxProfile[];
  range: {
    from: number;
    to: number;
  };
  busy: boolean;
}>();

const emit = defineEmits<{
  raise: [payload: {
    profile: string;
    task: string | null;
  }];
}>();

const profile = ref('');
const task = ref('');
const withoutTask = ref(true);
const taskError = ref('');

const taskHint = computed(() => (withoutTask.value
  ? `GrigDesk выберет свободный служебный номер: ${props.range.from}–${props.range.to}.`
  : 'Стенд получит имя этой задачи, и позже её можно пустить по конвейеру на готовый стенд.'));

// Выключенное поле не должно звать вводить номер: подсказка внутри него говорит,
// что номер сейчас выдаёт сам GrigDesk.
const taskPlaceholder = computed(() => (withoutTask.value ? 'выдаст GrigDesk' : 'например 1234'));

const profileError = computed(() => (props.options.length
  ? ''
  : 'Нет профилей для создания песочницы. В профиле нужны скрипты up.sh и down.sh.'));

const canSubmit = computed(() => props.options.some((option) => option.id === profile.value) && !props.busy);

// Первый доступный профиль подставляется при начальной загрузке.
// После исчезновения выбора соседний профиль выбирает только человек.
let initialProfileApplied = false;

watch(() => props.options, (options) => {
  if (profile.value && !options.some((option) => option.id === profile.value)) {
    profile.value = '';

    return;
  }

  if (!profile.value && options.length && !initialProfileApplied) {
    initialProfileApplied = true;
    profile.value = options[0]?.id || '';
  }
}, { immediate: true });

watch(withoutTask, () => {
  taskError.value = '';
});

/**
 * Номер проверяется до отправки: сервер откажет тем же правилом, но человеку
 * важнее увидеть причину рядом с полем, чем в общей полосе ошибки раздела.
 */
function submit() {
  if (!canSubmit.value) {
    return;
  }

  if (withoutTask.value) {
    emit('raise', { profile: profile.value, task: null });

    return;
  }

  if (!SANDBOX_TASK_RE.test(task.value)) {
    taskError.value = 'Нужен номер задачи — целое число.';

    return;
  }

  taskError.value = '';
  emit('raise', { profile: profile.value, task: task.value });
}
</script>

<style scoped>
.sandbox-raise {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  max-width: 760px;
  container: sandbox-raise / inline-size;
}

.sandbox-raise__row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  align-items: start;
  gap: 12px;
}

.sandbox-raise__footer {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px 16px;
  padding-top: 8px;
  border-top: 1px solid var(--line);
}

.sandbox-raise__note {
  min-width: 0;
  margin: 0;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.5;
}

@container sandbox-raise (max-width: 520px) {
  .sandbox-raise__row {
    grid-template-columns: 1fr;
  }

  .sandbox-raise__footer {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
