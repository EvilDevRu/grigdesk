<template>
  <section class="project" aria-labelledby="showcase-project-title">
    <header class="project__head">
      <div class="project__intro">
        <h2 id="showcase-project-title">{{ project.title }}</h2>
        <p class="project__target">{{ targetText }}</p>
      </div>
      <UiButton variant="ghost" @click="emit('close')">К списку</UiButton>
    </header>

    <UiInlineMessage v-if="blockedReason" tone="warning">
      {{ blockedReason }}
      <template v-if="nextAction"> — {{ nextAction }}</template>
    </UiInlineMessage>

    <!-- Одна кнопка на весь конвейер: человек смотрит ролик, а не управляет
         стадиями. Запись, озвучка и сборка сами считают, что им делать, и свежие
         клипы второй раз не снимаются. -->
    <div class="project__toolbar">
      <UiButton
        variant="solid"
        tone="accent"
        :disabled="!canBuild"
        :loading="busy || Boolean(buildStage)"
        @click="emit('build')"
      >
        {{ project.latestFinal ? 'Перегенерировать ролик' : 'Собрать ролик' }}
      </UiButton>
      <span class="project__note">{{ buildStage || readinessText }}</span>
    </div>

    <ul v-if="visibleJobs.length" class="project__jobs">
      <li v-for="job in visibleJobs" :key="job.id">
        <span class="project__job-dot" :data-state="job.state" aria-hidden="true"></span>
        <strong>{{ JOB_KIND[job.kind] }}</strong>
        <span>{{ job.progress.label || JOB_STATE[job.state] }}</span>
        <span v-if="job.progress.total" class="project__job-count">
          {{ job.progress.index }} из {{ job.progress.total }}
        </span>
        <span v-if="job.error" class="project__job-error">{{ job.error }}</span>
        <UiButton
          v-if="job.state === 'queued' || job.state === 'running'"
          variant="ghost"
          @click="emit('cancel', job.id)"
        >
          Отменить
        </UiButton>
      </li>
    </ul>

    <!-- Готовый ролик и работа над ним стоят рядом: человек смотрит запись и тут же
         правит текст, которым она озвучена, и голос, которым она говорит. -->
    <div class="project__stage">
      <div class="project__stage-main">
        <section v-if="project.latestFinal" class="project__final" aria-labelledby="showcase-final-title">
          <div class="project__block-head">
            <h3 id="showcase-final-title">Готовый ролик</h3>
            <span v-if="!project.latestFinal.current" class="project__stale">предыдущая сборка</span>
          </div>
          <UiVideo :src="finalUrl" label="Готовый ролик" />
          <div class="project__downloads">
            <UiActionLink :href="finalUrl" download="showcase.mp4">Скачать mp4</UiActionLink>
            <UiActionLink v-if="subtitlesUrl" :href="subtitlesUrl" download="showcase.srt">
              Скачать субтитры
            </UiActionLink>
          </div>
        </section>

        <section v-else class="project__final project__final--empty" aria-labelledby="showcase-final-title">
          <div class="project__block-head">
            <h3 id="showcase-final-title">Готовый ролик</h3>
          </div>
          <div class="project__placeholder">
            <span class="project__placeholder-mark" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
                <rect x="3" y="5" width="18" height="14" rx="2" />
                <path d="m10 9 5 3-5 3z" />
              </svg>
            </span>
            <div>
              <strong>Ролика ещё нет</strong>
              <p>
                Проверьте сцены и голос справа и нажмите «Собрать ролик»: запись экранов,
                озвучка и сборка займут несколько минут.
              </p>
            </div>
          </div>
        </section>

        <!-- Данные стенда нужны, только если профиль объявил рецепт подготовки. Без
             него остаётся одна отметка «данные обновлены» — она старит записи всех
             сцен, и прятать её нельзя, но и выпячивать незачем. -->
        <section v-if="seed?.available" class="project__data" aria-labelledby="showcase-data-title">
          <div class="project__block-head">
            <h3 id="showcase-data-title">Данные стенда</h3>
            <span class="project__note">{{ dataRevisionText }}</span>
          </div>
          <p class="project__note">
            Профиль объявил рецепт подготовки. Он меняет данные стенда, поэтому
            запускается только по подтверждению.
          </p>
          <div class="project__data-actions">
            <UiButton variant="ghost" :loading="busy" @click="emit('seed', seed.recipeFingerprint)">
              Подготовить данные
            </UiButton>
            <UiButton variant="ghost" :loading="busy" @click="emit('data-updated')">
              Данные обновлены
            </UiButton>
          </div>
        </section>

        <div v-else class="project__data-line">
          <span class="project__note">
            {{ seed?.reason || 'Подготовка данных для этой цели недоступна.' }}
            Изменили данные стенда сами — отметьте это, и сцены снимутся заново.
          </span>
          <UiButton variant="ghost" :loading="busy" @click="emit('data-updated')">
            Данные обновлены
          </UiButton>
        </div>
      </div>

      <div class="project__stage-side">
        <slot name="voice" />

        <section class="project__scenes" aria-labelledby="showcase-scenes-title">
          <div class="project__block-head">
            <h3 id="showcase-scenes-title">Сцены</h3>
            <span class="project__note">{{ project.scenes.length }} из {{ maxScenes }}</span>
          </div>

          <p v-if="!project.scenes.length" class="project__note">
            Сцен ещё нет. Каждая сцена начинается со своего экрана и не зависит от соседних.
          </p>

          <ShowcaseSceneEditor
            v-for="(scene, index) in orderedScenes"
            :key="scene.id"
            :scene="scene"
            :audio-url="audioUrlOf(scene)"
            :busy="busy"
            :checks="scene.checks"
            :first="index === 0"
            :last="index === orderedScenes.length - 1"
            @save="emit('save-scene', $event)"
            @remove="emit('remove-scene', $event)"
            @move="emit('move-scene', $event)"
            @audio="emit('scene-audio', $event)"
          />

          <form class="project__add" @submit.prevent="addScene">
            <UiField label="Экран новой сцены">
              <UiSelect v-model="newScreenId" :disabled="busy || !screens.length">
                <option v-if="!screens.length" value="">профиль не объявил экранов</option>
                <option v-for="screen in screens" :key="screen.id" :value="screen.id">
                  {{ screen.title }}
                </option>
              </UiSelect>
            </UiField>
            <UiField label="Текст озвучки">
              <UiInput v-model="newNarration" :disabled="busy" placeholder="Открываем обзор задач." />
            </UiField>
            <UiButton type="submit" variant="ghost" :aria-disabled="!canAdd">Добавить сцену</UiButton>
          </form>
        </section>

        <section class="project__brief" aria-labelledby="showcase-brief-title">
          <div class="project__block-head">
            <h3 id="showcase-brief-title">План ролика</h3>
            <span class="project__note">что показать зрителю</span>
          </div>

          <ol v-if="project.brief.length" class="project__brief-list">
            <li v-for="(point, index) in project.brief" :key="index">{{ point }}</li>
          </ol>
          <p v-else class="project__note">
            План собирается по тексту связанной задачи и изменениям в репозиториях стенда.
          </p>

          <div class="project__brief-actions">
            <UiButton variant="ghost" :loading="busy" @click="emit('analyze')">
              Разобрать заново
            </UiButton>
          </div>
        </section>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import {
  UiActionLink,
  UiButton,
  UiField,
  UiInlineMessage,
  UiInput,
  UiSelect,
  UiVideo,
} from '../../ui';
import type { ShowcaseJob, ShowcaseProject, ShowcaseScene } from '../../../../shared/showcaseContracts';
import type { SeedStatus } from '../../actions/showcase';
import ShowcaseSceneEditor from './ShowcaseSceneEditor.vue';

interface SceneTextPayload {
  id: string;
  narration: string;
  caption: string;
  subtitleText: string;
}

const props = defineProps<{
  project: ShowcaseProject;
  seed: SeedStatus | null;
  jobs: ShowcaseJob[];
  busy: boolean;
  // Стадия сквозной сборки: пока она идёт, кнопка занята, а человек читает, что
  // именно сейчас происходит, — задания приходят позже и не покрывают паузы между.
  buildStage: string;
  maxScenes: number;
  artifactUrl: (artifactId: string) => string;
}>();

const emit = defineEmits<{
  close: [];
  build: [];
  analyze: [];
  seed: [recipeFingerprint: string];
  'data-updated': [];
  cancel: [jobId: string];
  'add-scene': [payload: { screenId: string; narration: string }];
  'save-scene': [payload: SceneTextPayload];
  'remove-scene': [id: string];
  'move-scene': [payload: { id: string; delta: number }];
  'scene-audio': [payload: { id: string; file: File }];
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

const ACTIVE_STATES = new Set<ShowcaseJob['state']>([
  'queued', 'running', 'awaiting_review', 'cancelling',
]);

const newScreenId = ref('');
const newNarration = ref('');

const screens = computed(() => (
  props.project.target.status === 'ready' ? props.project.target.scope.screens : []
));

const orderedScenes = computed(() => (
  [...props.project.scenes].sort((left, right) => left.order - right.order)
));

// На экране только живые задания и последний отказ: история успешных стадий
// человеку ни о чём не говорит, а отказ — говорит, почему ролика нет.
const visibleJobs = computed(() => {
  const active = props.jobs.filter((job) => ACTIVE_STATES.has(job.state));
  const latest = [...props.jobs]
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
  const failed = latest && (latest.state === 'failed' || latest.state === 'interrupted')
    ? [latest]
    : [];

  return [...active, ...failed.filter((job) => !active.includes(job))];
});

const targetText = computed(() => {
  if (props.project.target.status !== 'ready') {
    return 'цель показа недоступна';
  }

  const scope = props.project.target.scope;
  const environment = scope.environment === 'isolated-demo' ? 'демо-копия' : 'только чтение';

  return `${scope.targetLabel} · профиль ${scope.profile} · ${environment}`;
});

const blockedReason = computed(() => (
  props.project.target.status === 'blocked' ? props.project.target.reason : ''
));

const nextAction = computed(() => (
  props.project.target.status === 'blocked' ? props.project.target.nextAction?.hint ?? '' : ''
));

// Собрать можно, когда есть что снимать: цель жива, запись разрешена и в ролике
// хотя бы одна сцена. Свежесть отдельных клипов здесь не проверяется — стадии
// сами пропускают то, что уже готово, и кнопка не гаснет посреди конвейера.
const canBuild = computed(() => (
  !props.busy
  && !props.buildStage
  && props.project.scenes.length > 0
  && props.project.target.status === 'ready'
  && props.project.target.scope.capabilities.includes('record')
));

const readinessText = computed(() => {
  if (!props.project.scenes.length) {
    return 'Добавьте хотя бы одну сцену.';
  }

  const stale = props.project.scenes.filter((scene) => scene.stale).length;
  const withoutAudio = props.project.scenes.filter((scene) => !scene.audio).length;

  if (withoutAudio) {
    return `Без звука: ${withoutAudio} сцен(ы). Сборка озвучит их сама.`;
  }

  return stale ? `Нужна запись: ${stale} сцен(ы).` : 'Все сцены готовы к сборке.';
});

// Ревизия данных показывается словами: по ней человек понимает, почему записи
// сцен вдруг устарели все разом.
const dataRevisionText = computed(() => (
  props.project.target.status === 'ready'
    ? `версия данных: ${props.project.target.scope.dataRevision}`
    : ''
));

const finalUrl = computed(() => (
  props.project.latestFinal ? props.artifactUrl(props.project.latestFinal.video.id) : ''
));

const subtitlesUrl = computed(() => (
  props.project.latestFinal?.subtitles
    ? props.artifactUrl(props.project.latestFinal.subtitles.id)
    : ''
));

const canAdd = computed(() => Boolean(newScreenId.value) && !props.busy);

// Единственный объявленный экран подставляется сам: выбор ради одного варианта
// только добавляет шаг.
watch(screens, (list) => {
  if (!newScreenId.value) {
    newScreenId.value = list[0]?.id ?? '';
  }
}, { immediate: true });

function audioUrlOf(scene: ShowcaseScene): string {
  return scene.audio ? props.artifactUrl(scene.audio.id) : '';
}

function addScene() {
  if (!canAdd.value) {
    return;
  }

  emit('add-scene', {
    screenId: newScreenId.value,
    narration: newNarration.value,
  });
  newNarration.value = '';
}
</script>

<style scoped>
.project {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}

.project__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 19px 20px;
  border: 1px solid var(--line);
  border-radius: 15px;
  background:
    radial-gradient(
      circle at 88% 10%,
      color-mix(in srgb, var(--accent) 10%, transparent),
      transparent 27%
    ),
    linear-gradient(180deg, color-mix(in srgb, var(--surface) 96%, #fff), var(--surface));
  box-shadow: inset 0 1px 0 #ffffff08;
}

.project__intro h2 {
  margin: 0 0 6px;
  font-size: 20px;
  line-height: 1.25;
  letter-spacing: -0.025em;
  overflow-wrap: anywhere;
}

.project__target,
.project__note,
.project__stale {
  margin: 0;
  color: var(--ink-mid);
  font-size: 12.5px;
  line-height: 1.45;
}

.project__target {
  display: block;
  max-width: 720px;
}

.project__stale {
  padding: 2px 8px;
  border: 1px solid color-mix(in srgb, var(--warn) 38%, var(--line));
  border-radius: 999px;
  background: color-mix(in srgb, var(--warn) 6%, var(--ground));
  color: var(--warn);
  font-size: 10.5px;
}

.project__toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 13px 14px;
  border: 1px solid color-mix(in srgb, var(--accent) 32%, var(--line));
  border-radius: 12px;
  background: color-mix(in srgb, var(--accent) 5%, var(--surface));
}

.project__toolbar .project__note {
  margin-left: auto;
}

.project__jobs {
  display: grid;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.project__jobs li {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  min-width: 0;
  flex-wrap: wrap;
  padding: 9px 11px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: color-mix(in srgb, var(--ground) 52%, transparent);
}

.project__job-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent, #3b82f6);
  flex: none;
}

.project__job-dot[data-state='failed'],
.project__job-dot[data-state='interrupted'] {
  background: var(--bad);
}

.project__job-dot[data-state='succeeded'] {
  background: var(--good);
}

.project__job-count,
.project__job-error {
  color: var(--ink-mid);
}

.project__stage {
  display: grid;
  grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}

.project__stage-main,
.project__stage-side {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}

.project__data,
.project__brief,
.project__final,
.project__scenes {
  display: flex;
  flex-direction: column;
  gap: 13px;
  min-width: 0;
  padding: 18px;
  border: 1px solid var(--line);
  border-radius: 15px;
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--surface) 96%, #fff) 0%,
    var(--surface) 100%
  );
  box-shadow: inset 0 1px 0 #ffffff08;
}

.project__block-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--line);
}

.project__block-head h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 660;
  letter-spacing: -0.01em;
}

.project__placeholder {
  display: flex;
  align-items: center;
  gap: 13px;
  min-height: 150px;
  padding: 20px;
  border: 1px dashed var(--line-2);
  border-radius: 13px;
  background: color-mix(in srgb, var(--surface-2) 28%, transparent);
}

.project__placeholder-mark {
  display: grid;
  flex: none;
  width: 40px;
  height: 40px;
  place-items: center;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--surface-2);
  color: var(--ink-mid);
}

.project__placeholder-mark svg {
  width: 19px;
  height: 19px;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.project__placeholder strong {
  font-size: 14px;
}

.project__placeholder p {
  max-width: 460px;
  margin: 5px 0 0;
  color: var(--ink-mid);
  font-size: 13px;
  line-height: 1.5;
}

.project__downloads,
.project__data-actions,
.project__brief-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.project__data-line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  padding: 4px 6px;
}

.project__brief-list {
  margin: 0;
  padding-left: 20px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13.5px;
}

.project__brief-list li {
  padding-left: 3px;
  line-height: 1.5;
}

.project__add {
  display: grid;
  gap: 10px;
  padding-top: 12px;
  border-top: 1px solid var(--line);
}

@media (max-width: 980px) {
  .project__stage {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 640px) {
  .project__head {
    flex-direction: column;
  }

  .project__toolbar .project__note {
    margin-left: 0;
  }
}
</style>
