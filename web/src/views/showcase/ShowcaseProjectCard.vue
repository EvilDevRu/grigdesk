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

    <div class="project__toolbar">
      <UiButton
        variant="solid"
        tone="accent"
        :disabled="!canRecord"
        :loading="busy"
        @click="emit('record')"
      >
        Записать сцены
      </UiButton>
      <UiButton variant="ghost" :disabled="!canSynthesize" :loading="busy" @click="emit('voice')">
        Озвучить сцены
      </UiButton>
      <UiButton variant="ghost" :disabled="!canAssemble" :loading="busy" @click="emit('assemble')">
        Собрать ролик
      </UiButton>
      <span class="project__note">{{ readinessText }}</span>
    </div>

    <ul v-if="jobs.length" class="project__jobs">
      <li v-for="job in jobs" :key="job.id">
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

    <section class="project__data" aria-labelledby="showcase-data-title">
      <div class="project__block-head">
        <h3 id="showcase-data-title">Данные стенда</h3>
        <span class="project__note">{{ dataRevisionText }}</span>
      </div>

      <p class="project__note">
        {{ seed?.available
          ? 'Профиль объявил рецепт подготовки. Он меняет данные стенда, поэтому запускается только по подтверждению.'
          : (seed?.reason || 'Подготовка данных для этой цели недоступна: показываем то, что уже есть.') }}
      </p>

      <div class="project__data-actions">
        <UiButton
          v-if="seed?.available"
          variant="ghost"
          :loading="busy"
          @click="emit('seed', seed.recipeFingerprint)"
        >
          Подготовить данные
        </UiButton>
        <UiButton variant="ghost" :loading="busy" @click="emit('data-updated')">
          Данные обновлены
        </UiButton>
      </div>
    </section>

    <section class="project__brief" aria-labelledby="showcase-brief-title">
      <div class="project__block-head">
        <h3 id="showcase-brief-title">Бриф</h3>
        <span class="project__note">Что показать зрителю</span>
      </div>

      <ol v-if="project.brief.length" class="project__brief-list">
        <li v-for="(point, index) in project.brief" :key="index">{{ point }}</li>
      </ol>
      <p v-else class="project__note">
        Модель может предложить план по тексту задачи и изменениям в репозиториях стенда.
        Текст задачи остаётся данными: адреса, экраны и действия он не задаёт.
      </p>

      <UiField label="Текст задачи для модели" hint="Вставьте постановку или её суть.">
        <UiTextarea v-model="taskText" :disabled="busy" rows="3" />
      </UiField>

      <div class="project__brief-actions">
        <UiButton variant="ghost" :loading="busy" @click="emit('brief', taskText)">
          Предложить бриф
        </UiButton>
        <UiButton
          variant="ghost"
          :aria-disabled="!project.brief.length"
          :loading="busy"
          @click="emit('script', taskText)"
        >
          Предложить сцены
        </UiButton>
      </div>
    </section>

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
        <UiField label="Экран новой сцены" hint="Список приходит из объявления профиля.">
          <UiSelect v-model="newScreenId" :disabled="busy || !screens.length">
            <option v-if="!screens.length" value="">профиль не объявил экранов</option>
            <option v-for="screen in screens" :key="screen.id" :value="screen.id">
              {{ screen.title }}
            </option>
          </UiSelect>
        </UiField>
        <UiField label="Что говорит голос">
          <UiInput v-model="newNarration" :disabled="busy" placeholder="Открываем обзор задач." />
        </UiField>
        <UiButton type="submit" variant="ghost" :aria-disabled="!canAdd">Добавить сцену</UiButton>
      </form>
    </section>
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
  UiTextarea,
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
  maxScenes: number;
  artifactUrl: (artifactId: string) => string;
}>();

const emit = defineEmits<{
  close: [];
  record: [];
  brief: [taskText: string];
  seed: [recipeFingerprint: string];
  'data-updated': [];
  script: [taskText: string];
  voice: [];
  assemble: [];
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

const taskText = ref('');
const newScreenId = ref('');
const newNarration = ref('');

const screens = computed(() => (
  props.project.target.status === 'ready' ? props.project.target.scope.screens : []
));

const orderedScenes = computed(() => (
  [...props.project.scenes].sort((left, right) => left.order - right.order)
));

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

const canRecord = computed(() => (
  !props.busy
  && props.project.target.status === 'ready'
  && props.project.target.scope.capabilities.includes('record')
  && props.project.scenes.some((scene) => scene.stale)
));

// Озвучивать есть что, только если у сцены источник — синтез и её звук устарел:
// загруженную человеком запись движок не переозвучивает.
const canSynthesize = computed(() => (
  !props.busy
  && props.project.scenes.some((scene) => (
    scene.audioSource.kind === 'tts' && (!scene.audio || scene.stale)
  ))
));

// Собирать можно, только когда у каждой сцены свежие клип и звук: смесь двух
// редакций выглядела бы готовым роликом, но показывала бы не то, что написано.
const canAssemble = computed(() => (
  !props.busy
  && props.project.scenes.length > 0
  && props.project.scenes.every((scene) => !scene.stale && scene.audio && scene.clip)
));

const readinessText = computed(() => {
  if (!props.project.scenes.length) {
    return 'Добавьте хотя бы одну сцену.';
  }

  const stale = props.project.scenes.filter((scene) => scene.stale).length;
  const withoutAudio = props.project.scenes.filter((scene) => !scene.audio).length;

  if (withoutAudio) {
    return `Без звука: ${withoutAudio} сцен(ы).`;
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
  gap: 16px;
  min-width: 0;
}

.project__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.project__intro h2 {
  margin: 0 0 4px;
  font-size: 18px;
  overflow-wrap: anywhere;
}

.project__target,
.project__note,
.project__stale {
  margin: 0;
  color: var(--muted, #9aa4b2);
  font-size: 13px;
}

.project__toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.project__jobs {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.project__jobs li {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  min-width: 0;
  flex-wrap: wrap;
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
  background: var(--danger, #d05353);
}

.project__job-dot[data-state='succeeded'] {
  background: var(--ok, #4c9a5a);
}

.project__job-count,
.project__job-error {
  color: var(--muted, #9aa4b2);
}

.project__data-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.project__brief-list {
  margin: 0;
  padding-left: 20px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 14px;
}

.project__brief-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.project__data,
.project__brief,
.project__final,
.project__scenes {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

.project__block-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.project__block-head h3 {
  margin: 0;
  font-size: 15px;
}

.project__downloads {
  display: flex;
  gap: 12px;
}

.project__add {
  display: flex;
  align-items: flex-end;
  gap: 12px;
  flex-wrap: wrap;
  padding: 14px;
  border: 1px dashed var(--border, #2a2f3a);
  border-radius: 10px;
}

.project__add > *:not(:last-child) {
  flex: 1 1 220px;
  min-width: 0;
}
</style>
