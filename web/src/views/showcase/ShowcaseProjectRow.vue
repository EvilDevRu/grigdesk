<template>
  <UiSelectableRow class="row" :data-state="project.state" @select="emit('open', project.id)">
    <span class="row__body">
      <span class="row__mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="m10 9 5 3-5 3z" />
        </svg>
      </span>
      <span class="row__copy">
        <span class="row__title-line">
          <strong class="row__title">{{ project.title }}</strong>
          <span class="row__state" :data-state="project.state">
            <i aria-hidden="true"></i>{{ STATE_TEXT[project.state] }}
          </span>
        </span>
        <span class="row__meta">{{ metaText }}</span>
        <span v-if="activeJob" class="row__job">
          {{ JOB_KIND[activeJob.kind] }} · {{ jobText(activeJob) }}
        </span>
      </span>
      <span class="row__chevron" aria-hidden="true">›</span>
    </span>

    <template #actions>
      <UiButton
        v-if="activeJob && isRunning(activeJob.state)"
        variant="ghost"
        @click="emit('cancel', activeJob.id)"
      >
        Отменить
      </UiButton>
      <UiButton variant="ghost" tone="danger" :loading="busy" @click="emit('remove', project.id)">
        Удалить
      </UiButton>
    </template>
  </UiSelectableRow>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import { UiButton, UiSelectableRow } from '../../ui';
import type {
  ShowcaseJob,
  ShowcaseProjectSummary,
} from '../../../../shared/plugins/showcase/showcaseContracts';

const props = defineProps<{
  project: ShowcaseProjectSummary;
  jobs: ShowcaseJob[];
  busy: boolean;
}>();

const emit = defineEmits<{
  open: [id: string];
  remove: [id: string];
  cancel: [jobId: string];
}>();

const STATE_TEXT: Record<ShowcaseProjectSummary['state'], string> = {
  draft: 'без сцен',
  ready: 'сцены готовы',
  building: 'идёт сборка',
  blocked: 'нужен человек',
  done: 'ролик собран',
};

const JOB_KIND: Record<ShowcaseJob['kind'], string> = {
  script: 'сценарий',
  voice: 'озвучка',
  record: 'запись',
  assemble: 'сборка',
};

const JOB_STATE: Record<ShowcaseJob['state'], string> = {
  queued: 'в очереди',
  running: 'идёт',
  awaiting_review: 'ждёт решения',
  cancelling: 'останавливается',
  succeeded: 'готово',
  failed: 'отказ',
  interrupted: 'оборвалось',
  cancelled: 'отменено',
};

const KIND_TEXT: Record<ShowcaseProjectSummary['ref']['kind'], string> = {
  project: 'проект',
  sandbox: 'песочница',
  task: 'задача',
};

const ACTIVE_STATES = new Set<ShowcaseJob['state']>([
  'queued', 'running', 'awaiting_review', 'cancelling',
]);

// В списке видно только живое задание: история удачных стадий человеку ни о чём
// не говорит, а отказ подробно читается в самом ролике.
const activeJob = computed(() => props.jobs.find((job) => ACTIVE_STATES.has(job.state)) ?? null);

/**
 * Вторая строка: где снято, сколько сцен, когда трогали. Готовность ролика уже
 * названа чипом состояния, поэтому здесь её нет.
 */
const metaText = computed(() => {
  const target = props.project.targetLabel
    || `${KIND_TEXT[props.project.ref.kind]} ${props.project.ref.id}`;
  const scenes = props.project.sceneCount ? `${scenesCount(props.project.sceneCount)}` : 'сцен нет';
  const updated = new Date(props.project.updatedAt).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

  return `${target} · ${scenes} · изменён ${updated}`;
});

/**
 * Число сцен со склонением: «3 сцена» в строке списка читалось бы как ошибка
 * самого раздела, а не как число.
 */
function scenesCount(count: number): string {
  const tail = count % 10;
  const teen = count % 100 >= 11 && count % 100 <= 14;

  if (tail === 1 && !teen) {
    return `${count} сцена`;
  }

  if (tail >= 2 && tail <= 4 && !teen) {
    return `${count} сцены`;
  }

  return `${count} сцен`;
}

function jobText(job: ShowcaseJob): string {
  return job.progress.label || JOB_STATE[job.state];
}

function isRunning(state: ShowcaseJob['state']): boolean {
  return state === 'queued' || state === 'running';
}
</script>

<style scoped>
.row {
  min-width: 0;
}

.row__body {
  display: flex;
  align-items: center;
  gap: 11px;
  min-width: 0;
  padding: 3px 0;
}

.row__mark {
  display: grid;
  flex: none;
  width: 34px;
  height: 34px;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--accent) 32%, var(--line));
  border-radius: 10px;
  background: color-mix(in srgb, var(--accent) 8%, var(--ground));
  color: var(--accent);
}

.row__mark svg {
  width: 17px;
  height: 17px;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.row__copy {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.row__title-line {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex-wrap: wrap;
}

.row__title {
  overflow: hidden;
  font-size: 14px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row__state {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 6px;
  padding: 1px 8px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--ground);
  color: var(--ink-mid);
  font-size: 10.5px;
  white-space: nowrap;
}

.row__state i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentcolor;
}

.row__state[data-state='ready'],
.row__state[data-state='done'] {
  border-color: color-mix(in srgb, var(--good) 34%, var(--line));
  color: var(--good);
}

.row__state[data-state='building'] {
  border-color: color-mix(in srgb, var(--accent) 36%, var(--line));
  color: var(--accent);
}

.row__state[data-state='blocked'] {
  border-color: color-mix(in srgb, var(--warn) 38%, var(--line));
  color: var(--warn);
}

.row__meta,
.row__job {
  overflow: hidden;
  color: var(--ink-mid);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row__job {
  color: var(--accent);
}

.row__chevron {
  flex: none;
  color: var(--ink-mid);
  font-size: 18px;
  line-height: 1;
}
</style>
