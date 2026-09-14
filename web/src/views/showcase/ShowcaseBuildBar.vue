<template>
  <section class="build" :data-running="running ? 'yes' : 'no'" aria-label="Сборка ролика">
    <template v-if="running">
      <div class="build__running" role="status" aria-live="polite">
        <UiSpinner decorative />
        <div class="build__copy">
          <strong>{{ stageTitle }}</strong>
          <span class="build__detail">{{ stageDetail }}</span>
        </div>
        <UiButton v-if="canCancelRun" variant="ghost" @click="emit('cancel-build', activeRun!.id)">
          Отменить
        </UiButton>
        <UiButton
          v-else-if="activeJob && isCancellable(activeJob.state)"
          variant="ghost"
          @click="emit('cancel-job', activeJob.id)"
        >
          Отменить
        </UiButton>
      </div>
      <UiProgress
        label="Ход сборки ролика"
        :value="progressValue"
        :max="progressMax"
        :indeterminate="!progressMax"
      />
    </template>

    <template v-else>
      <div class="build__idle">
        <UiButton
          variant="solid"
          tone="accent"
          :disabled="!canBuild"
          :loading="busy"
          @click="emit('build')"
        >
          {{ project.latestFinal ? 'Пересобрать ролик' : 'Собрать ролик' }}
        </UiButton>
        <span class="build__note">{{ readinessText }}</span>
      </div>

      <UiInlineMessage
        v-if="runProblem"
        :tone="runProblem.tone"
        data-role="build-failure"
      >
        <strong>{{ runProblem.title }}</strong>
        {{ runProblem.message }}
      </UiInlineMessage>
      <UiInlineMessage v-else-if="latestJobFailure" tone="danger" data-role="build-failure">
        <strong>
          {{ JOB_KIND[latestJobFailure.kind] }} — {{ JOB_STATE[latestJobFailure.state] }}.
        </strong>
        {{ latestJobFailure.error || describeJob(latestJobFailure) }}
      </UiInlineMessage>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import { UiButton, UiInlineMessage, UiProgress, UiSpinner } from '../../ui';
import { sceneChains } from '../../../../shared/showcaseChains';
import { SHOWCASE_BUILD_STAGES } from '../../../../shared/showcaseContracts';
import type {
  ShowcaseBuildRun,
  ShowcaseBuildStage,
  ShowcaseJob,
  ShowcaseProject,
} from '../../../../shared/showcaseContracts';

const props = defineProps<{
  project: ShowcaseProject;
  jobs: ShowcaseJob[];
  buildRun: ShowcaseBuildRun | null;
  busy: boolean;
  // Несохранённые правки сцен: собирать поверх них значило бы снять старый текст.
  unsavedCount: number;
}>();

const emit = defineEmits<{
  build: [];
  'cancel-build': [runId: string];
  'cancel-job': [jobId: string];
}>();

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

const JOB_TITLE: Record<ShowcaseJob['kind'], string> = {
  script: 'Составляю сценарий',
  voice: 'Озвучиваю сцены',
  record: 'Записываю сцены',
  assemble: 'Собираю ролик',
};

const STAGE_TITLE: Record<ShowcaseBuildStage, string> = {
  preflight: 'Проверяю готовность',
  'script-if-empty': 'Составляю сценарий',
  bindings: 'Связываю речь и действия',
  'voice-and-alignment': 'Готовлю озвучку',
  'record-if-needed': 'Записываю сцены',
  'timeline-and-assemble': 'Собираю ролик',
  validate: 'Проверяю готовый ролик',
  done: 'Ролик готов',
};

const STAGE_DETAIL: Record<ShowcaseBuildStage, string> = {
  preflight: 'проверяю цель и входные данные',
  'script-if-empty': 'готовлю план и сцены',
  bindings: 'строю точные смысловые связи',
  'voice-and-alignment': 'синтезирую и выравниваю речь',
  'record-if-needed': 'снимаю только устаревшие сцены',
  'timeline-and-assemble': 'свожу видео, звук и субтитры',
  validate: 'сверяю итоговые файлы и шкалу времени',
  done: 'все стадии завершены',
};

const ACTIVE_RUN_STATES = new Set<ShowcaseBuildRun['state']>([
  'queued', 'running', 'cancelling',
]);
const ACTIVE_JOB_STATES = new Set<ShowcaseJob['state']>([
  'queued', 'running', 'awaiting_review', 'cancelling',
]);

const activeRun = computed(() => (
  props.buildRun && ACTIVE_RUN_STATES.has(props.buildRun.state) ? props.buildRun : null
));

const runChildJob = computed(() => {
  const run = activeRun.value;

  if (!run) {
    return null;
  }

  const child = [...run.children].reverse().find((item) => item.stage === run.stage);

  return child ? props.jobs.find((job) => job.id === child.jobId) ?? null : null;
});

const activeJob = computed(() => runChildJob.value ?? (
  props.jobs.find((job) => ACTIVE_JOB_STATES.has(job.state)) ?? null
));

const running = computed(() => Boolean(activeRun.value) || Boolean(activeJob.value));

const canCancelRun = computed(() => Boolean(
  activeRun.value
  && !activeRun.value.cancelRequested
  && (activeRun.value.state === 'queued' || activeRun.value.state === 'running'),
));

const stageTitle = computed(() => {
  if (activeRun.value) {
    return activeRun.value.state === 'cancelling'
      ? 'Останавливаю сборку'
      : STAGE_TITLE[activeRun.value.stage];
  }

  return activeJob.value ? JOB_TITLE[activeJob.value.kind] : 'Готовлю сборку';
});

const stageDetail = computed(() => {
  const job = activeJob.value;

  if (job) {
    const counter = job.progress.total
      ? `сцена ${job.progress.index} из ${job.progress.total}`
      : '';
    const label = job.progress.label || JOB_STATE[job.state];

    return [counter, label].filter(Boolean).join(' · ');
  }

  return activeRun.value
    ? STAGE_DETAIL[activeRun.value.stage]
    : 'жду следующую стадию';
});

const stageProgress = computed(() => {
  const stage = activeRun.value?.stage;

  return stage ? SHOWCASE_BUILD_STAGES.indexOf(stage) + 1 : 0;
});

const progressMax = computed(() => (
  activeJob.value?.progress.total || (activeRun.value ? SHOWCASE_BUILD_STAGES.length : 0)
));

const progressValue = computed(() => (
  activeJob.value?.progress.total ? activeJob.value.progress.index : stageProgress.value
));

const runProblem = computed(() => {
  const run = props.buildRun;

  if (!run || run.state === 'succeeded' || ACTIVE_RUN_STATES.has(run.state)) {
    return null;
  }

  if (run.state === 'cancelled') {
    return {
      tone: 'warning' as const,
      title: 'Сборка отменена.',
      message: run.error?.message || 'Можно запустить её снова после проверки сцен.',
    };
  }

  return {
    tone: run.state === 'awaiting_review' ? 'warning' as const : 'danger' as const,
    title: run.state === 'awaiting_review'
      ? 'Сборка ждёт исправления.'
      : run.state === 'interrupted'
        ? 'Сборка оборвалась.'
        : 'Сборка остановлена.',
    message: run.error?.message || 'Причина не названа. Повторите после проверки проекта.',
  };
});

const latestJobFailure = computed(() => {
  const latest = [...props.jobs]
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];

  return latest && (latest.state === 'failed' || latest.state === 'interrupted') ? latest : null;
});

const canBuild = computed(() => (
  !props.busy
  && props.project.target.status === 'ready'
  && props.project.target.scope.capabilities.includes('record')
));

const readinessText = computed(() => {
  if (props.project.target.status !== 'ready') {
    return 'Цель показа недоступна — записывать нечего.';
  }

  if (props.unsavedCount) {
    return `Есть несохранённые правки: ${props.unsavedCount} сцен(ы). Сборка сохранит их сама.`;
  }

  if (!props.project.scenes.length) {
    return 'Сценарий ещё не создан — сборка подготовит план и сцены сама.';
  }

  const stale = sceneChains(props.project.scenes)
    .filter((chain) => chain.some((scene) => scene.stale))
    .reduce((sum, chain) => sum + chain.length, 0);
  const withoutAudio = props.project.scenes.filter((scene) => !scene.audio).length;

  if (withoutAudio) {
    return `Без звука: ${withoutAudio} сцен(ы). Сборка озвучит их сама.`;
  }

  if (stale) {
    return `Нужна запись: ${stale} сцен(ы). Остальные не переснимаются.`;
  }

  return props.project.latestFinal?.current
    ? 'Ролик собран из текущих сцен.'
    : 'Все сцены готовы к сборке.';
});

function isCancellable(state: ShowcaseJob['state']): boolean {
  return state === 'queued' || state === 'running';
}

function describeJob(job: ShowcaseJob): string {
  return job.state === 'interrupted'
    ? 'Задание оборвалось — повторите сборку.'
    : job.progress.label || 'Причина не названа.';
}
</script>

<style scoped>
.build {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  padding: 13px 14px;
  border: 1px solid color-mix(in srgb, var(--accent) 32%, var(--line));
  border-radius: 12px;
  background: color-mix(in srgb, var(--accent) 5%, var(--surface));
}

.build__idle,
.build__running {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  flex-wrap: wrap;
}

.build__note {
  margin-left: auto;
  color: var(--ink-mid);
  font-size: 12.5px;
  line-height: 1.45;
}

.build__copy {
  display: flex;
  flex: 1 1 240px;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.build__detail {
  color: var(--ink-mid);
  font-size: 12.5px;
}

@media (max-width: 640px) {
  .build__note {
    margin-left: 0;
  }
}
</style>
