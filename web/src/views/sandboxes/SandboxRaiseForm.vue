<template>
  <form class="sandbox-raise" @submit.prevent="submit">
    <div class="sandbox-raise__row">
      <UiField label="Профиль" :error="profileError">
        <UiSelect v-model="profile" :disabled="!options.length">
          <option v-if="!options.length" value="">нет профилей с песочницей</option>
          <option v-for="item in options" :key="item.id" :value="item.id">{{ item.id }}</option>
        </UiSelect>
      </UiField>

      <UiField
        label="Номер задачи"
        :hint="taskHint"
        :error="taskError"
      >
        <UiInput
          v-model.trim="task"
          :disabled="withoutTask"
          inputmode="numeric"
          :placeholder="taskPlaceholder"
        />
      </UiField>
    </div>

    <label class="sandbox-raise__toggle">
      <UiSwitch v-model="withoutTask" />
      <span>
        Без задачи — служебный номер из диапазона
        {{ range.from }}–{{ range.to }}
      </span>
    </label>

    <div class="sandbox-raise__footer">
      <p class="sandbox-raise__note">
        Подъём занимает слот стенда и обычно 12–15 минут: скрипт профиля создаёт worktree,
        контейнеры и свои схемы данных. Вкладку можно закрыть — процесс идёт своим ходом.
      </p>
      <UiButton
        type="submit"
        variant="solid"
        tone="accent"
        :loading="busy"
        :aria-disabled="!canSubmit"
      >
        Поднять песочницу
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
import { SANDBOX_TASK_RE } from '../../../../shared/sandboxContracts';
import type { SandboxProfile } from '../../../../shared/sandboxContracts';

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
  ? 'Номер выдаст кокпит: он не пересекается с номерами задач портала.'
  : 'Стенд получит имя этой задачи, и позже её можно пустить по конвейеру на готовый стенд.'));

// Выключенное поле не должно звать вводить номер: подсказка внутри него говорит,
// что номер сейчас выдаёт сам кокпит.
const taskPlaceholder = computed(() => (withoutTask.value ? 'выдаст кокпит' : 'например 1234'));

const profileError = computed(() => (props.options.length
  ? ''
  : 'Ни один профиль не объявил up.sh и down.sh.'));

const canSubmit = computed(() => Boolean(profile.value) && !props.busy);

// Первый доступный профиль подставляется сам: чаще всего он на машине один.
watch(() => props.options, (options) => {
  if (!profile.value && options.length) {
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
  gap: 14px;
}

.sandbox-raise__row {
  display: grid;
  grid-template-columns: minmax(180px, 260px) minmax(180px, 1fr);
  align-items: start;
  gap: 14px;
}

.sandbox-raise__toggle {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--ink-mid);
  font-size: 13px;
  cursor: pointer;
}

.sandbox-raise__footer {
  display: flex;
  align-items: center;
  gap: 16px;
  padding-top: 12px;
  border-top: 1px solid var(--line);
}

.sandbox-raise__note {
  flex: 1;
  min-width: 0;
  margin: 0;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.5;
}

@media (max-width: 640px) {
  .sandbox-raise__row {
    grid-template-columns: 1fr;
  }

  .sandbox-raise__footer {
    flex-direction: column;
    align-items: stretch;
  }
}
</style>
