<template>
  <section class="build" :data-running="running ? 'yes' : 'no'" :aria-label="t('core.showcaseSborkaRolika')">
    <template v-if="running">
      <div class="build__running" role="status" aria-live="polite">
        <UiSpinner decorative />
        <div class="build__copy">
          <strong>{{ stageTitle }}</strong>
          <span class="build__detail">{{ stageDetail }}</span>
        </div>
        <UiButton v-if="canCancelRun" variant="ghost" @click="emit('cancel-build', activeRun!.id)"> {{ t('core.trackerCancel') }} </UiButton>
        <UiButton
          v-else-if="activeJob && isCancellable(activeJob.state)"
          variant="ghost"
          @click="emit('cancel-job', activeJob.id)"
        > {{ t('core.trackerCancel') }} </UiButton>
      </div>
      <UiProgress
        :label="t('core.showcaseHodSborkiRolika')"
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
          {{ project.latestFinal ? t('core.showcasePeresobratRolik') : t('core.showcaseSobratRolik') }}
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
      <UiInlineMessage
        v-else-if="latestJobProblem"
        :tone="latestJobProblem.state === 'awaiting_review' ? 'warning' : 'danger'"
        data-role="build-failure"
      >
        <strong>
          {{ JOB_KIND[latestJobProblem.kind] }} — {{ JOB_STATE[latestJobProblem.state] }}.
        </strong>
        {{ latestJobProblem.error || describeJob(latestJobProblem) }}
      </UiInlineMessage>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import { UiButton, UiInlineMessage, UiProgress, UiSpinner, t } from '../../ui';
import { sceneChains } from '../../../../shared/plugins/showcase/showcaseChains';
import { SHOWCASE_BUILD_STAGES } from '../../../../shared/plugins/showcase/showcaseContracts';
import type {
  ShowcaseBuildRun,
  ShowcaseBuildStage,
  ShowcaseJob,
  ShowcaseProject,
} from '../../../../shared/plugins/showcase/showcaseContracts';

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

const JOB_TITLE: Record<ShowcaseJob['kind'], string> = {
  get script() {
    return t('core.showcaseSostavlyayuStsenariy');
  },
  get voice() {
    return t('core.showcaseOzvuchivayuStseny');
  },
  get record() {
    return t('core.showcaseZapisyvayuStseny');
  },
  get assemble() {
    return t('core.showcaseSobirayuRolik');
  },
};

const STAGE_TITLE: Record<ShowcaseBuildStage, string> = {
  get preflight() {
    return t('core.showcaseProveryayuGotovnost');
  },
  get 'script-if-empty'() {
    return t('core.showcaseProveryayuStsenariy');
  },
  get bindings() {
    return t('core.showcaseSvyazyvayuRechIDeystviya');
  },
  get 'voice-and-alignment'() {
    return t('core.showcaseGotovlyuOzvuchku');
  },
  get 'record-if-needed'() {
    return t('core.showcaseZapisyvayuStseny');
  },
  get 'timeline-and-assemble'() {
    return t('core.showcaseSobirayuRolik');
  },
  get validate() {
    return t('core.showcaseProveryayuGotovyyRolik');
  },
  get done() {
    return t('core.showcaseRolikGotov');
  },
};

const STAGE_DETAIL: Record<ShowcaseBuildStage, string> = {
  get preflight() {
    return t('core.showcaseProveryayuTselIVhodnye');
  },
  get 'script-if-empty'() {
    return t('core.showcaseProveryayuDeystviyaNaStende');
  },
  get bindings() {
    return t('core.showcaseStroyuTochnyeSmyslovyeSvyazi');
  },
  get 'voice-and-alignment'() {
    return t('core.showcaseSinteziruyuIVyravnivayuRech');
  },
  get 'record-if-needed'() {
    return t('core.showcaseSnimayuTolkoUstarevshieStseny');
  },
  get 'timeline-and-assemble'() {
    return t('core.showcaseSvozhuVideoZvukI');
  },
  get validate() {
    return t('core.showcaseSveryayuItogovyeFaylyI');
  },
  get done() {
    return t('core.showcaseVseStadiiZaversheny');
  },
};

const ACTIVE_RUN_STATES = new Set<ShowcaseBuildRun['state']>([
  'queued', 'running', 'cancelling',
]);
// `awaiting_review` — остановка на человеке, для сервера она терминальна: задание из
// неё не выходит, а продолжение создаёт новую попытку. Считать её ходом значило бы
// крутить спиннер «Собираю ролик» без конца, прятать причину и кнопку сборки —
// человек спрашивал «собирается или повис?», а ответ лежал в скрытом сообщении.
const ACTIVE_JOB_STATES = new Set<ShowcaseJob['state']>([
  'queued', 'running', 'cancelling',
]);
const PROBLEM_JOB_STATES = new Set<ShowcaseJob['state']>([
  'failed', 'interrupted', 'awaiting_review',
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
      ? t('core.showcaseOstanavlivayuSborku')
      : STAGE_TITLE[activeRun.value.stage];
  }

  return activeJob.value ? JOB_TITLE[activeJob.value.kind] : t('core.showcaseGotovlyuSborku');
});

const stageDetail = computed(() => {
  const job = activeJob.value;

  if (job) {
    const counter = job.progress.total
      ? t('core.showcaseStsenaIndexIzTotal', { index: job.progress.index, total: job.progress.total })
      : '';
    const label = job.progress.label || JOB_STATE[job.state];

    return [counter, label].filter(Boolean).join(' · ');
  }

  return activeRun.value
    ? STAGE_DETAIL[activeRun.value.stage]
    : t('core.showcaseZhduSleduyuschuyuStadiyu');
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

// Момент рождения нынешнего сценария: «Разобрать заново» заменяет сцены целиком и
// записывает решение о сценарии. Остановка или отказ, случившиеся раньше, относятся
// к прежним сценам — их карточка читалась как новая ошибка сразу после разбора.
const scenarioSince = computed(() => (
  props.project.decisions
    .filter((item) => item.kind === 'script')
    .map((item) => item.decidedAt)
    .sort()
    .at(-1) ?? ''
));

// Сравнивается момент ОСТАНОВКИ, а не старта: полная сборка пустого ролика сама
// рождает сценарий своей первой стадией, и по старту она «старше» собственного
// сценария — её остановка на монтаже пряталась как отчёт о прежних сценах.
const beforeScenario = (stoppedAt: string | null, startedAt: string): boolean => (
  Boolean(scenarioSince.value) && (stoppedAt ?? startedAt) < scenarioSince.value
);

const runProblem = computed(() => {
  const run = props.buildRun;

  if (
    !run
    || run.state === 'succeeded'
    || ACTIVE_RUN_STATES.has(run.state)
    || beforeScenario(run.finishedAt, run.startedAt)
  ) {
    return null;
  }

  if (run.state === 'cancelled') {
    return {
      tone: 'warning' as const,
      title: t('core.showcaseSborkaOtmenena'),
      message: run.error?.message || t('core.showcaseMozhnoZapustitEeSnova'),
    };
  }

  return {
    tone: run.state === 'awaiting_review' ? 'warning' as const : 'danger' as const,
    title: run.state === 'awaiting_review'
      ? t('core.showcaseSborkaZhdetIspravleniya')
      : run.state === 'interrupted'
        ? t('core.showcaseSborkaOborvalas')
        : t('core.showcaseSborkaOstanovlena'),
    message: run.error?.message || t('core.showcasePrichinaNeNazvanaPovtorite'),
  };
});

// Задание без полного запуска (прежние ручки стадий) о своей остановке отчитывается
// само: и отказ, и ожидание человека показываются у кнопки сборки.
const latestJobProblem = computed(() => {
  const latest = [...props.jobs]
    .filter((job) => !beforeScenario(job.finishedAt, job.startedAt))
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];

  return latest && PROBLEM_JOB_STATES.has(latest.state) ? latest : null;
});

const canBuild = computed(() => (
  !props.busy
  && props.project.target.status === 'ready'
  && props.project.target.scope.capabilities.includes('record')
));

const readinessText = computed(() => {
  if (props.project.target.status !== 'ready') {
    return t('core.showcaseTselPokazaNedostupnaZapisyvat');
  }

  if (props.unsavedCount) {
    return t('core.showcaseEstNesohranennyePravkiUnsavedcount', { unsavedCount: props.unsavedCount });
  }

  if (!props.project.scenes.length) {
    return t('core.showcaseStsenariyEscheNeSozdan');
  }

  const stale = sceneChains(props.project.scenes)
    .filter((chain) => chain.some((scene) => scene.stale))
    .reduce((sum, chain) => sum + chain.length, 0);
  const withoutAudio = props.project.scenes.filter((scene) => !scene.audio).length;

  if (withoutAudio) {
    return t('core.showcaseBezZvukaWithoutaudioStsen', { withoutAudio: withoutAudio });
  }

  if (stale) {
    return t('core.showcaseNuzhnaZapisStaleStsen', { stale: stale });
  }

  return props.project.latestFinal?.current
    ? t('core.showcaseRolikSobranIzTekuschih')
    : t('core.showcaseVseStsenyGotovyK');
});

function isCancellable(state: ShowcaseJob['state']): boolean {
  return state === 'queued' || state === 'running';
}

function describeJob(job: ShowcaseJob): string {
  return job.state === 'interrupted'
    ? t('core.showcaseZadanieOborvalosPovtoriteSborku')
    : job.progress.label || t('core.showcasePrichinaNeNazvana');
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
