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
      > {{ t('core.trackerCancel') }} </UiButton>
      <UiButton variant="ghost" tone="danger" :loading="busy" @click="emit('remove', project.id)"> {{ t('core.taskDelete') }} </UiButton>
    </template>
  </UiSelectableRow>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import { UiButton, UiSelectableRow, t, uiLocale } from '../../ui';
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
  get draft() {
    return t('core.showcaseBezStsen');
  },
  get ready() {
    return t('core.showcaseStsenyGotovy');
  },
  get building() {
    return t('core.showcaseIdetSborka');
  },
  get blocked() {
    return t('core.showcaseNuzhenChelovek');
  },
  get done() {
    return t('core.showcaseRolikSobran');
  },
};

const JOB_KIND: Record<ShowcaseJob['kind'], string> = {
  get script() {
    return t('core.showcaseStsenariy');
  },
  get voice() {
    return t('core.showcaseOzvuchka');
  },
  get record() {
    return t('core.showcaseZapis');
  },
  get assemble() {
    return t('core.showcaseSborka');
  },
};

const JOB_STATE: Record<ShowcaseJob['state'], string> = {
  get queued() {
    return t('settings.queued');
  },
  get running() {
    return t('core.showcaseIdet');
  },
  get awaiting_review() {
    return t('core.showcaseZhdetResheniya');
  },
  get cancelling() {
    return t('core.showcaseOstanavlivaetsya');
  },
  get succeeded() {
    return t('settings.done2');
  },
  get failed() {
    return t('settings.remoteStepFailed');
  },
  get interrupted() {
    return t('core.showcaseOborvalos');
  },
  get cancelled() {
    return t('settings.cancelled');
  },
};

const KIND_TEXT: Record<ShowcaseProjectSummary['ref']['kind'], string> = {
  get project() {
    return t('core.showcaseProekt');
  },
  get sandbox() {
    return t('settings.sandbox');
  },
  get task() {
    return t('settings.diagnosticSourceTask');
  },
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
  const scenes = props.project.sceneCount
  ? `${scenesCount(props.project.sceneCount)}`
  : t('core.showcaseStsenNet');
  const updated = new Date(props.project.updatedAt).toLocaleString(uiLocale.value, {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

  return t('core.showcaseTargetScenesIzmenenUpdated', {
    target,
    scenes,
    updated,
  });
});

/**
 * Число сцен со склонением: «3 сцена» в строке списка читалось бы как ошибка
 * самого раздела, а не как число.
 */
function scenesCount(count: number): string {
  const tail = count % 10;
  const teen = count % 100 >= 11 && count % 100 <= 14;

  if (tail === 1 && !teen) {
    return t('core.showcaseCountStsena', { count: count });
  }

  if (tail >= 2 && tail <= 4 && !teen) {
    return t('core.showcaseCountStseny', { count: count });
  }

  return t('core.showcaseCountStsen', { count: count });
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
