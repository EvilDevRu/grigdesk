<template>
  <form class="sandbox-raise" @submit.prevent="submit">
    <div class="sandbox-raise__row">
      <UiField :label="t('core.sandboxProfil2')" :error="profileError"
               :help="t('core.sandboxRaiseFormTheProfileDefinesTheProjectAnd')">
        <UiSelect v-model="profile" :disabled="!options.length || busy">
          <option v-if="!options.length" value="">{{ t('core.sandboxNetProfileySPesochnitsey') }}</option>
          <option v-for="item in options" :key="item.id" :value="item.id">{{ item.id }}</option>
        </UiSelect>
      </UiField>

      <UiField
        :label="t('core.sandboxNomerZadachi')"
        :error="taskError"
        :help="t('core.sandboxRaiseFormEnterTheTaskNumberFromThe')"
      >
        <UiInput
          v-model.trim="task"
          :disabled="withoutTask || busy"
          inputmode="numeric"
          :placeholder="taskPlaceholder"
        />
      </UiField>
    </div>

    <UiSwitch v-model="withoutTask" :disabled="busy">{{ t('core.sandboxBezPrivyazkiKZadache') }}</UiSwitch>
    <p class="sandbox-raise__note">{{ taskHint }}</p>

    <div class="sandbox-raise__footer">
      <p class="sandbox-raise__note"> {{ t('core.sandboxPodgotovkaZanimaet1215') }} </p>
      <UiButton
        type="submit"
        variant="solid"
        tone="accent"
        data-context="workspace-form"
        :loading="busy"
        :aria-disabled="!canSubmit"
      > {{ t('core.sandboxPodnyatStend2') }} </UiButton>
    </div>
  </form>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { UiButton, UiField, UiInput, UiSelect, UiSwitch, t } from '../../ui';
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
  ? t('core.sandboxGrigdeskVyberetSvobodnyySluzhebnyy', { from: props.range.from, to: props.range.to })
  : t('core.sandboxStendPoluchitImyaEtoy')));

// Выключенное поле не должно звать вводить номер: подсказка внутри него говорит,
// что номер сейчас выдаёт сам GrigDesk.
const taskPlaceholder =
  computed(() => (withoutTask.value ? t('core.sandboxVydastGrigdesk') : t('core.sandboxNaprimer1234')));

const profileError = computed(() => (props.options.length
  ? ''
  : t('core.sandboxNetProfileyDlyaSozdaniya')));

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
    taskError.value = t('core.sandboxNuzhenNomerZadachiTseloe');

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
