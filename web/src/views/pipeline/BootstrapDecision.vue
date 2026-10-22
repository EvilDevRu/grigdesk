<template>
  <section class="sect" data-role="pipeline-bootstrap-decision">
    <div class="secth">Вопрос разведки SCOUT</div>
    <p>{{ stop.reason }}</p>
    <ul v-if="stop.verdict?.findings?.length">
      <li v-for="finding in stop.verdict.findings" :key="finding.id">{{ finding.summary }}</li>
    </ul>
    <p v-if="recorded" role="status">Ответ сохранён. Следующий SCOUT получит его целиком.</p>
    <template v-else>
      <label for="bootstrap-answer">Твоё решение</label>
      <UiTextarea
        id="bootstrap-answer"
        v-model="answer"
        data-role="pipeline-bootstrap-answer"
        rows="6"
        :disabled="busy"
        placeholder="Ответь на вопросы и укажи, какой вариант выбрать"
      />
    </template>
    <p v-if="error" role="alert">{{ error }}</p>
    <UiButton
      data-role="pipeline-bootstrap-submit"
      :loading="busy"
      :disabled="busy || running || (!recorded && !answer.trim())"
      @click="submit"
    >
      {{ recorded ? 'Продолжить после ответа' : 'Сохранить ответ и продолжить' }}
    </UiButton>
  </section>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import type { PropType } from 'vue';

import { isRecord } from '../../../../shared/lib/objects.ts';
import { errorMessage } from '../../../../shared/lib/errors.ts';
import { api } from '../../shared/apiClient.ts';
import { UiButton, UiTextarea } from '../../ui';

interface BootstrapStopView {
  reason: string;
  visitId: string;
  recordHash: string;
  state?: string;
  decision?: { recordHash?: string } | null;
  verdict?: { findings?: Array<{ id: string; summary: string }> } | null;
}

const props = defineProps({
  task: [String, Number],
  profile: String,
  attempt: String,
  stop: { type: Object as PropType<BootstrapStopView>, required: true },
  running: Boolean,
});

const emit = defineEmits<{ changed: [] }>();

const answer = ref('');
const recorded = ref(false);
const busy = ref(false);
const error = ref('');
let generation = 0;

/**
 * Ответ фиксируется коротким CAS, затем отдельно запускается resume exact attempt.
 * Отказ продолжения сохраняет подтверждение решения и предлагает повторить только запуск.
 */
async function submit() {
  if (busy.value || props.running || (!recorded.value && !answer.value.trim())) {
    return;
  }

  const identity = { profile: props.profile, attempt: props.attempt };
  const task = props.task;
  const stop = props.stop;
  const request = generation;

  busy.value = true;
  error.value = '';

  try {
    if (!recorded.value) {
      const result = await api.post(`/api/tasks/${task}/bootstrap-answer`, {
        ...identity,
        phase: 'bootstrap',
        node: 'scout',
        visitId: stop.visitId,
        stopHash: stop.recordHash,
        answer: answer.value,
      });

      if (request !== generation) {
        return;
      }

      if (!isRecord(result) || !result.ok || !isRecord(result.decision)
          || result.decision.visitId !== stop.visitId || result.decision.stopHash !== stop.recordHash) {
        throw new Error('Сохранение ответа не подтверждено — обнови карточку.');
      }

      recorded.value = true;
    }

    await api.post(`/api/tasks/${task}/resume`, identity);
    emit('changed');
  } catch (cause) {
    if (request !== generation) {
      return;
    }

    const message = errorMessage(cause, 'Не удалось выполнить запрос');

    error.value = recorded.value
      ? `Ответ сохранён, продолжение не запустилось: ${message}`
      : `Ответ не принят: ${message}`;
  } finally {
    busy.value = false;
  }
}

watch(() => [props.task, props.profile, props.attempt, props.stop.recordHash], () => {
  generation += 1;
  answer.value = '';
  error.value = '';
  recorded.value = props.stop.state === 'answered' || Boolean(props.stop.decision);
}, { immediate: true });

// Решение может прийти через обновление графа из другой вкладки для того же stop.
// Оно меняет доступное действие, не сбрасывая identity текущего HTTP-запроса.
watch(() => props.stop.decision?.recordHash, (hash) => {
  if (hash) {
    recorded.value = true;
    error.value = '';
  }
});

onBeforeUnmount(() => {
  generation += 1;
});
</script>
