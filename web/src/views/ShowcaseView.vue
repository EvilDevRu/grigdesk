<template>
  <section
    class="showcase"
    :class="{ 'showcase--project': store.opened }"
    aria-labelledby="showcase-title"
  >
    <header class="showcase__hero">
      <div class="showcase__hero-copy">
        <p class="showcase__eyebrow">Показ готовой работы</p>
        <h1 id="showcase-title">Презентации</h1>
        <p>
          Короткий ролик о готовой задаче: выберите стенд, проверьте сценарий и голос —
          и получите mp4 с озвучкой и субтитрами.
        </p>
      </div>

      <UiButton
        class="showcase__refresh"
        variant="ghost"
        :loading="store.loading"
        @click="loadShowcase(store)"
      >
        Обновить
      </UiButton>
    </header>

    <UiInlineMessage v-if="store.error" tone="danger">{{ store.error }}</UiInlineMessage>

    <!-- Полоса шагов ведёт человека по одному пути: стенд → разбор → ролик. Шаг не
         выбирается произвольно, он следует за состоянием ролика на сервере, поэтому
         переживает и F5, и возврат к списку. -->
    <div class="showcase__steps">
      <UiTabs v-model="step" class="showcase__steps-tabs" label="Шаги подготовки ролика">
        <UiTab
          id="showcase-step-target"
          class="showcase__step"
          value="target"
          controls="showcase-step-panel"
        >
          {{ store.opened ? '✓ Стенд' : '1 · Стенд' }}
        </UiTab>
        <UiTab
          id="showcase-step-analyze"
          class="showcase__step"
          value="analyze"
          controls="showcase-step-panel"
          :disabled="!store.opened"
        >
          {{ hasScript ? '✓ Разбор' : '2 · Разбор' }}
        </UiTab>
        <UiTab
          id="showcase-step-film"
          class="showcase__step"
          value="film"
          controls="showcase-step-panel"
          :disabled="!hasScript"
        >
          3 · Ролик
        </UiTab>
      </UiTabs>
    </div>

    <section
      v-if="store.opened && step === 'analyze'"
      id="showcase-step-panel"
      class="showcase__panel"
      role="tabpanel"
      aria-labelledby="showcase-step-analyze"
    >
      <header class="showcase__section-head">
        <div>
          <p class="showcase__section-kicker">Разбор</p>
          <h2>{{ store.opened.title }}</h2>
          <p>Читаю связанную задачу и изменения в репозиториях стенда.</p>
        </div>
      </header>

      <div v-if="analyzing" class="showcase__progress" role="status" aria-live="polite">
        <UiSpinner decorative />
        <div>
          <strong>Собираю план ролика</strong>
          <p>Модель предлагает бриф и сцены — это занимает до пары минут.</p>
        </div>
      </div>
      <div v-else class="showcase__progress" role="status">
        <div>
          <strong>{{ hasScript ? 'План готов' : 'План пока пустой' }}</strong>
          <p v-if="hasScript">Сцен: {{ store.opened.scenes.length }}. Дальше — сам ролик.</p>
          <p v-else>Разбор не дал сцен. Можно повторить: постановка и diff читаются заново.</p>
        </div>
        <UiButton variant="ghost" :loading="analyzing" @click="analyze">Разобрать заново</UiButton>
        <UiButton
          v-if="hasScript"
          variant="solid"
          tone="accent"
          @click="step = 'film'"
        >
          К ролику
        </UiButton>
      </div>
    </section>

    <ShowcaseProjectCard
      v-else-if="store.opened"
      id="showcase-step-panel"
      :project="store.opened"
      :seed="seed"
      :jobs="store.jobsOf(store.opened.id)"
      :busy="store.isBusy(store.opened.id)"
      :build-stage="buildStage"
      :max-scenes="store.limits.maxScenes"
      :artifact-url="artifactUrl"
      @close="close"
      @build="build"
      @analyze="analyze"
      @seed="prepareData"
      @data-updated="markDataUpdated"
      @cancel="cancel"
      @add-scene="addScene"
      @save-scene="saveScene"
      @remove-scene="removeScene"
      @move-scene="moveScene"
      @scene-audio="uploadAudio"
    >
      <template #voice>
        <ShowcaseVoicePanel
          mode="choice"
          :catalog="store.voices"
          :busy="store.voiceBusy || store.isBusy(store.opened.id)"
          :voice-ref="projectVoiceRef"
          :pace="projectPace"
          :preview-url="previewUrl"
          @install="installVoice"
          @cancel="cancelVoiceInstall"
          @change="changeVoice"
        />
      </template>
    </ShowcaseProjectCard>

    <template v-else>
      <section class="showcase__panel" aria-labelledby="showcase-create-title">
        <header class="showcase__section-head">
          <span class="showcase__section-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
              <rect x="3" y="5" width="18" height="14" rx="2" />
              <path d="M12 9v6 M9 12h6" />
            </svg>
          </span>
          <div>
            <p class="showcase__section-kicker">Новый выпуск</p>
            <h2 id="showcase-create-title">Завести ролик</h2>
            <p>Цель и доступность стенда проверятся до первой записи.</p>
          </div>
        </header>

        <ShowcaseCreateForm
          :targets="store.targets"
          :busy="creating"
          :loaded="store.loaded"
          :loading="store.loading"
          :error="store.error"
          @create="create"
        />
      </section>

      <section class="showcase__block" aria-labelledby="showcase-list-title">
        <div class="showcase__block-head">
          <div>
            <p class="showcase__section-kicker">Библиотека</p>
            <h2 id="showcase-list-title">Ролики</h2>
          </div>
          <span v-if="store.projects.length" class="showcase__count">
            {{ store.projects.length }}
          </span>
        </div>

        <div v-if="!store.projects.length" class="showcase__empty">
          <span class="showcase__empty-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
              <rect x="3" y="5" width="18" height="14" rx="2" />
              <path d="m10 9 5 3-5 3z" />
            </svg>
          </span>
          <div>
            <strong>{{ store.loaded ? 'Роликов ещё нет' : 'Читаем состояние…' }}</strong>
            <p v-if="store.loaded">
              Первый ролик появится здесь вместе с целью, сценами и ходом сборки.
            </p>
          </div>
        </div>
        <div v-else class="showcase__list">
          <ShowcaseCard
            v-for="project in store.projects"
            :key="project.id"
            :project="project"
            :jobs="store.jobsOf(project.id)"
            :busy="store.isBusy(project.id)"
            @open="open"
            @remove="remove"
            @cancel="cancel"
          />
        </div>
      </section>
    </template>

    <div
      v-if="!store.opened"
      class="showcase__services"
      :class="{ 'showcase__services--single': voiceReady }"
    >
      <ShowcaseVoicePanel
        v-if="!voiceReady"
        mode="setup"
        :catalog="store.voices"
        :busy="store.voiceBusy"
        @install="installVoice"
        @cancel="cancelVoiceInstall"
      />

      <!-- Готовность проверяется сама при открытии: кнопка «Проверить» просила
           человека делать то, что сервер знает и без него. Пункты про цель и сеть
           здесь не показываются — цели на этом шаге ещё нет. -->
      <section class="showcase__health" aria-labelledby="showcase-doctor-title">
        <header class="showcase__health-head">
          <div>
            <p class="showcase__section-kicker">Окружение</p>
            <h2 id="showcase-doctor-title">Готовность к записи</h2>
          </div>
          <span
            class="showcase__health-state"
            :data-state="doctorState.tone"
            role="status"
            aria-live="polite"
          >
            <i aria-hidden="true"></i>{{ doctorState.label }}
          </span>
        </header>

        <p v-if="!doctorOperations.length" class="showcase__note">
          {{ checking ? 'Проверяем браузер, ffmpeg и голос…' : 'Проверка ещё не выполнялась.' }}
        </p>
        <ul v-else class="showcase__doctor">
          <li v-for="operation in doctorOperations" :key="operation.id">
            <span
              class="showcase__doctor-dot"
              :data-status="operation.status"
              aria-hidden="true"
            />
            <div class="showcase__doctor-copy">
              <strong>{{ operation.title }}</strong>
              <span class="showcase__doctor-reason">{{ operation.reason }}</span>
            </div>
          </li>
        </ul>

        <div class="showcase__health-action">
          <UiButton variant="ghost" :loading="checking" @click="check">Проверить снова</UiButton>
        </div>
      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';

import { UiButton, UiInlineMessage, UiSpinner, UiTab, UiTabs, confirmDialog } from '../ui';
import {
  addShowcaseScene,
  analyzeShowcase,
  buildShowcaseFilm,
  setShowcaseVoice,
  cancelShowcaseJob,
  cancelShowcaseVoiceInstall,
  closeShowcaseProject,
  createShowcaseProject,
  deleteShowcaseProject,
  importShowcaseAudio,
  installShowcaseVoice,
  loadSeedStatus,
  loadShowcase,
  loadShowcaseVoices,
  markShowcaseDataUpdated,
  openShowcaseProject,
  prepareShowcaseData,
  removeShowcaseScene,
  reorderShowcaseScenes,
  updateShowcaseScene,
  useShowcaseStore,
  watchShowcase,
} from '../actions/showcase';
import { showcaseApi, showcaseErrorMessage } from '../shared/showcaseApi';
import type { SeedStatus, ShowcaseVoiceChoice } from '../actions/showcase';
import type {
  ShowcaseDoctor,
  ShowcaseSelectableTargetRef,
  ShowcaseTargetRef,
} from '../../../shared/showcaseContracts';
import ShowcaseCard from './showcase/ShowcaseCard.vue';
import ShowcaseCreateForm from './showcase/ShowcaseCreateForm.vue';
import ShowcaseProjectCard from './showcase/ShowcaseProjectCard.vue';
import ShowcaseVoicePanel from './showcase/ShowcaseVoicePanel.vue';

const store = useShowcaseStore();
const creating = ref(false);
const analyzing = ref(false);
const buildStage = ref('');
const step = ref<'target' | 'analyze' | 'film'>('target');
const checking = ref(false);
const doctor = ref<ShowcaseDoctor | null>(null);
const seed = ref<SeedStatus | null>(null);

// Пункты про цель и вход относятся к конкретному стенду, а сетевая проверка —
// ручная и ни к чему не ведёт: на первом шаге показывается только то, что можно
// исправить прямо сейчас.
const GENERAL_OPERATIONS = new Set(['browser', 'media', 'voice', 'speech', 'storage']);

const doctorOperations = computed(() => (
  (doctor.value?.operations ?? []).filter((operation) => GENERAL_OPERATIONS.has(operation.id))
));

const doctorState = computed(() => {
  const operations = doctorOperations.value;

  if (!operations.length) {
    return { tone: 'idle', label: checking.value ? 'Проверяем' : 'Не проверено' };
  }

  if (operations.some((operation) => operation.status === 'blocked')) {
    return { tone: 'bad', label: 'Есть блокеры' };
  }

  if (operations.some((operation) => operation.status === 'warning')) {
    return { tone: 'warn', label: 'Нужна проверка' };
  }

  if (operations.some((operation) => operation.status === 'unknown')) {
    return { tone: 'idle', label: 'Не всё проверено' };
  }

  return { tone: 'good', label: 'Всё готово' };
});

// Готовый движок есть — установка голосов с первого шага уходит: ставить другие
// голоса можно с экрана ролика, где их и выбирают.
const voiceReady = computed(() => (
  Boolean(store.voices?.engines.some((engine) => engine.doctor.status === 'ready'))
));

// Голос и темп ролика — у его сцен: первая синтезируемая сцена говорит за все,
// потому что сервер меняет их только разом.
const projectVoiceRef = computed(() => (
  store.opened?.scenes.find((scene) => scene.audioSource.kind === 'tts')?.audioSource.voiceRef
    ?? null
));

const projectPace = computed(() => store.opened?.scenes[0]?.direction.pace ?? null);

// Сцены есть — значит разбор уже дал план, и шаг «Ролик» открыт. Судить об этом
// по своему флагу нельзя: ролик живёт на сервере и переживает перезагрузку вкладки.
const hasScript = computed(() => Boolean(store.opened?.scenes.length));

// Шаг следует за состоянием: закрыли ролик — вернулись к выбору стенда, разобрали —
// ушли к ролику. Человек по-прежнему может листать шаги руками, но сам мастер
// никогда не оставляет его на пустом экране.
watch([() => store.opened?.id, hasScript], ([id, ready]) => {
  if (!id) {
    step.value = 'target';

    return;
  }

  step.value = ready ? 'film' : 'analyze';
}, { immediate: true });

let stopWatching: (() => void) | null = null;

onMounted(() => {
  stopWatching = watchShowcase(store);
  void loadShowcase(store);
  void loadShowcaseVoices(store);
  void check();
});

// Доступность подготовки данных зависит от ЖИВОГО состояния стенда, поэтому она
// спрашивается при появлении карточки, а не хранится в записи ролика: вчерашняя
// доступность сегодня уже ничего не значит.
watch(() => store.opened?.id, async (id) => {
  seed.value = id ? await loadSeedStatus(store) : null;
}, { immediate: true });

// Подписка снимается вместе с экраном: выключенный плагин и уход со страницы не
// должны оставлять слушателя, который продолжит писать в состояние раздела.
onUnmounted(() => {
  stopWatching?.();
  stopWatching = null;
});

/**
 * Шаг «Далее» мастера: ролик заводится и сразу уходит в разбор. Название ему даёт
 * сервер по стенду, а текст задачи он берёт сам — человеку на этом шаге заполнять
 * нечего, он уже сказал, ЧТО показывать.
 */
async function create(payload: { ref: ShowcaseSelectableTargetRef }) {
  creating.value = true;

  try {
    if (!await createShowcaseProject(store, { ref: payload.ref })) {
      return;
    }

    await analyze();
  } finally {
    creating.value = false;
  }
}

/**
 * Разбор стенда. Долгий шаг: модель читает постановку и diff, поэтому мастер
 * держит на экране свой прогресс, а не молчит до ответа сервера.
 */
async function analyze() {
  analyzing.value = true;

  try {
    await analyzeShowcase(store);
  } finally {
    analyzing.value = false;
  }
}

/**
 * Сборка ролика целиком: запись, озвучка и mp4 одной командой. Стадия показывается
 * человеку строкой — между заданиями есть паузы, и молчащий экран в это время
 * читается как «ничего не идёт».
 */
async function build() {
  await buildShowcaseFilm(store, (stage) => {
    buildStage.value = stage;
  });
}

/**
 * Удаление необратимо и уносит записанные клипы, звук и собранный ролик, поэтому
 * спрашиваем всегда: восстановить их можно только повторной записью, а она занимает
 * то же время, что и первая.
 */
async function remove(id: string) {
  const project = store.projects.find((item) => item.id === id);
  const accepted = await confirmDialog(
    `Удалить ролик «${project?.title ?? id}»?\n\n`
      + 'Вместе с записью будут удалены её сцены, звук и собранный файл. '
      + 'Идущие задания сначала отменяются.',
    {
      title: 'Удаление ролика',
      okText: 'Удалить',
      danger: true,
    },
  );

  if (!accepted) {
    return;
  }

  await deleteShowcaseProject(store, id);
}

async function cancel(jobId: string) {
  await cancelShowcaseJob(store, jobId);
}

async function open(id: string) {
  await openShowcaseProject(store, id);
}

/**
 * Подготовка данных меняет стенд, поэтому спрашиваем всегда и называем в вопросе
 * ровно то, что будет запущено: рецепт профиля на конкретном стенде.
 */
async function prepareData(recipeFingerprint: string) {
  const accepted = await confirmDialog(
    `Запустить подготовку данных на цели «${seed.value?.targetLabel ?? ''}»?\n\n`
      + `Рецепт профиля «${seed.value?.profile ?? ''}» изменит данные стенда. `
      + 'После этого все записанные сцены устареют и их придётся снять заново.',
    {
      title: 'Подготовка демо-данных',
      okText: 'Подготовить',
      danger: true,
    },
  );

  if (!accepted) {
    return;
  }

  await prepareShowcaseData(store, recipeFingerprint);
  seed.value = await loadSeedStatus(store);
}

async function markDataUpdated() {
  await markShowcaseDataUpdated(store);
}

function close() {
  seed.value = null;
  closeShowcaseProject(store);
  void loadShowcase(store);
}

async function addScene(payload: { screenId: string; narration: string }) {
  await addShowcaseScene(store, {
    title: '',
    screenId: payload.screenId,
    narration: payload.narration,
    caption: '',
    subtitleText: payload.narration,
    actions: [],
  });
}

async function saveScene(payload: {
  id: string;
  narration: string;
  caption: string;
  subtitleText: string;
}) {
  await updateShowcaseScene(store, payload.id, {
    narration: payload.narration,
    caption: payload.caption,
    subtitleText: payload.subtitleText,
  });
}

/**
 * Удаление сцены необратимо уносит её звук и запись, поэтому спрашиваем: собрать
 * их заново стоит столько же, сколько в первый раз.
 */
async function removeScene(sceneId: string) {
  const scene = store.opened?.scenes.find((item) => item.id === sceneId);
  const accepted = await confirmDialog(
    `Удалить сцену «${scene?.title ?? sceneId}»?\n\n`
      + 'Вместе со сценой удалятся её звук и запись экрана.',
    {
      title: 'Удаление сцены',
      okText: 'Удалить',
      danger: true,
    },
  );

  if (!accepted) {
    return;
  }

  await removeShowcaseScene(store, sceneId);
}

/**
 * Перестановка соседей. Порядок уходит полным списком: сервер отказывается
 * достраивать частичный, и это правильно — достроенный порядок означал бы ролик,
 * собранный не так, как виделось человеку.
 */
async function moveScene(payload: { id: string; delta: number }) {
  const opened = store.opened;

  if (!opened) {
    return;
  }

  const order = [...opened.scenes]
    .sort((left, right) => left.order - right.order)
    .map((scene) => scene.id);
  const from = order.indexOf(payload.id);
  const to = from + payload.delta;

  if (from < 0 || to < 0 || to >= order.length) {
    return;
  }

  const moved = order[from] as string;

  order.splice(from, 1);
  order.splice(to, 0, moved);

  await reorderShowcaseScenes(store, order);
}

async function uploadAudio(payload: { id: string; file: File }) {
  await importShowcaseAudio(store, payload.id, payload.file);
}

/**
 * Установка голоса. Подтверждения не спрашиваем: размер и лицензия названы прямо
 * на кнопке, а сама установка обратима — отмена рядом, скачанное лежит в каталоге
 * раздела.
 */
async function installVoice(voiceId: string) {
  await installShowcaseVoice(store, voiceId);
}

async function cancelVoiceInstall() {
  await cancelShowcaseVoiceInstall(store);
}

async function changeVoice(choice: ShowcaseVoiceChoice) {
  await setShowcaseVoice(store, choice);
}

function previewUrl(voiceRef: string): string {
  return showcaseApi.voicePreviewUrl(voiceRef);
}

function artifactUrl(artifactId: string): string {
  return store.opened ? showcaseApi.artifactUrl(store.opened.id, artifactId) : '';
}

/**
 * Готовность спрашивается без цели: так видно общее состояние установки — браузер,
 * ffmpeg, голос. Готовность конкретной цели показывает карточка ролика, у которой
 * эта цель уже выбрана. Отказ проверки не становится ошибкой раздела: она
 * справочная, и красная полоса из-за неё мешала бы завести ролик.
 */
async function check() {
  checking.value = true;

  try {
    doctor.value = await showcaseApi.doctor(null);
  } catch {
    doctor.value = null;
  } finally {
    checking.value = false;
  }
}
</script>

<style scoped>
.showcase {
  width: min(100%, 1160px);
  margin-inline: auto;
  display: flex;
  flex-direction: column;
  gap: 20px;
  min-width: 0;
}

.showcase__hero {
  position: relative;
  min-height: 0;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 32px;
  padding: 28px 30px;
  border: 1px solid var(--line);
  border-radius: 19px;
  background:
    radial-gradient(
      circle at 86% 5%,
      color-mix(in srgb, var(--accent) 18%, transparent),
      transparent 30%
    ),
    linear-gradient(
      135deg,
      color-mix(in srgb, var(--surface) 94%, var(--accent)) 0%,
      var(--surface) 72%
    );
  box-shadow: var(--shadow);
}

.showcase__hero::after {
  position: absolute;
  right: -64px;
  bottom: -142px;
  width: 350px;
  height: 255px;
  border: 1px solid color-mix(in srgb, var(--accent) 17%, transparent);
  border-radius: 50%;
  content: '';
  pointer-events: none;
}

.showcase__hero-copy {
  position: relative;
  z-index: 1;
  max-width: 625px;
  min-width: 0;
}

.showcase__eyebrow,
.showcase__section-kicker {
  margin: 0 0 6px;
  color: var(--accent);
  font-size: 10.5px;
  font-weight: 750;
  letter-spacing: 0.1em;
  line-height: 1.2;
  text-transform: uppercase;
}

.showcase__hero h1 {
  margin: 0;
  font-size: clamp(27px, 2.4vw, 34px);
  line-height: 1.15;
  letter-spacing: -0.035em;
}

.showcase__hero-copy > p:last-child {
  margin: 0;
  margin-top: 10px;
  color: var(--ink-mid);
  font-size: 14px;
  line-height: 1.55;
}

.showcase__refresh {
  position: relative;
  z-index: 1;
  flex: none;
}







.showcase--project .showcase__hero {
  min-height: 0;
  padding-block: 18px;
}

.showcase--project .showcase__hero h1 {
  font-size: 22px;
}

.showcase--project .showcase__hero-copy > p:last-child {
  display: none;
}

.showcase__panel,
.showcase__block,
.showcase__health {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.showcase__steps {
  display: flex;
  align-items: center;
  gap: 12px;
}

/* Полоса шагов растягивается на всю ширину, а вкладки делят её поровну: общий
   контрол сжимается до содержимого, и три шага слипались бы в одну строку. */
.showcase__steps-tabs {
  display: flex;
  width: 100%;
}

.showcase__step {
  flex: 1;
  justify-content: center;
  white-space: nowrap;
}

.showcase__progress {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: color-mix(in srgb, var(--surface) 94%, #fff);
}

.showcase__progress div {
  flex: 1;
  min-width: 0;
}

.showcase__progress p {
  margin: 4px 0 0;
  color: var(--muted);
  font-size: 13px;
}

.showcase__panel {
  gap: 17px;
  padding: 20px;
  border: 1px solid var(--line);
  border-radius: 16px;
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--surface) 96%, #fff) 0%,
    var(--surface) 100%
  );
  box-shadow: inset 0 1px 0 #ffffff08;
}

.showcase__section-head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  min-width: 0;
}

.showcase__section-head > div {
  min-width: 0;
}

.showcase__section-mark,
.showcase__empty-mark {
  display: grid;
  flex: none;
  width: 40px;
  height: 40px;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--line));
  border-radius: 12px;
  background: color-mix(in srgb, var(--accent) 9%, var(--ground));
  color: var(--accent);
}

.showcase__section-mark svg,
.showcase__empty-mark svg {
  width: 19px;
  height: 19px;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.showcase__section-head h2,
.showcase__block-head h2,
.showcase__health h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 660;
  letter-spacing: -0.01em;
}

.showcase__section-head p:last-child {
  margin: 4px 0 0;
  color: var(--ink-mid);
  font-size: 12.5px;
  line-height: 1.45;
}

.showcase__section-kicker {
  margin-bottom: 3px;
  font-size: 9.5px;
}

.showcase__block {
  gap: 12px;
}

.showcase__block-head {
  display: flex;
  align-items: center;
  gap: 9px;
}

.showcase__count {
  display: inline-flex;
  min-width: 23px;
  min-height: 21px;
  align-items: center;
  justify-content: center;
  padding-inline: 7px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--surface-2);
  color: var(--ink-mid);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.showcase__empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 13px;
  min-height: 116px;
  padding: 22px;
  border: 1px dashed var(--line-2);
  border-radius: 14px;
  background: color-mix(in srgb, var(--surface-2) 28%, transparent);
}

.showcase__empty-mark {
  border-color: var(--line);
  background: var(--surface-2);
  color: var(--ink-mid);
}

.showcase__empty strong {
  font-size: 14px;
}

.showcase__empty p {
  max-width: 470px;
  margin: 5px 0 0;
  color: var(--ink-mid);
  font-size: 13px;
  line-height: 1.5;
}

.showcase__list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 340px), 1fr));
  gap: 14px;
}

.showcase__services {
  display: grid;
  grid-template-columns: minmax(0, 1.35fr) minmax(300px, 0.65fr);
  align-items: start;
  gap: 16px;
  min-width: 0;
}

.showcase__services--single {
  grid-template-columns: minmax(0, 1fr);
}

.showcase__health {
  min-height: 100%;
  gap: 14px;
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

.showcase__health-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.showcase__health-state {
  display: inline-flex;
  flex: none;
  min-height: 25px;
  align-items: center;
  gap: 6px;
  padding: 3px 9px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--ground);
  color: var(--ink-mid);
  font-size: 10.5px;
  white-space: nowrap;
}

.showcase__health-state i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentcolor;
}

.showcase__health-state[data-state='good'] {
  border-color: color-mix(in srgb, var(--good) 34%, var(--line));
  color: var(--good);
}

.showcase__health-state[data-state='warn'] {
  border-color: color-mix(in srgb, var(--warn) 38%, var(--line));
  color: var(--warn);
}

.showcase__health-state[data-state='bad'] {
  border-color: color-mix(in srgb, var(--bad) 38%, var(--line));
  color: var(--bad);
}

.showcase__note {
  margin: 0;
  color: var(--ink-mid);
  font-size: 12.5px;
  line-height: 1.5;
}

.showcase__doctor {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.showcase__doctor li {
  display: grid;
  grid-template-columns: 8px minmax(0, 1fr) auto;
  align-items: start;
  gap: 9px;
  min-width: 0;
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: color-mix(in srgb, var(--ground) 58%, transparent);
}

.showcase__doctor-dot {
  width: 8px;
  height: 8px;
  margin-top: 5px;
  border-radius: 50%;
  background: var(--ink-mid);
}

.showcase__doctor-dot[data-status='ready'] {
  background: var(--good);
}

.showcase__doctor-dot[data-status='warning'] {
  background: var(--warn);
}

.showcase__doctor-dot[data-status='blocked'] {
  background: var(--bad);
}

.showcase__doctor-copy {
  display: grid;
  gap: 2px;
  min-width: 0;
  font-size: 12.5px;
}

.showcase__doctor-reason {
  color: var(--ink-mid);
  min-width: 0;
  line-height: 1.4;
}

.showcase__doctor-manual {
  padding: 1px 7px;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--ink-mid);
  font-size: 10px;
}

.showcase__health-action {
  display: flex;
  justify-content: flex-end;
  margin-top: auto;
  padding-top: 2px;
}

.showcase__health-head > div {
  min-width: 0;
}

@media (max-width: 920px) {
  .showcase__hero {
    gap: 20px;
    padding-inline: 24px;
  }

  .showcase__services {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 720px) {
  .showcase__hero {
    min-height: 0;
    align-items: flex-start;
    flex-direction: column;
    padding: 22px;
  }

  .showcase__panel {
    padding: 17px;
  }

  .showcase__empty {
    align-items: flex-start;
    justify-content: flex-start;
  }
}

@media (max-width: 440px) {
  .showcase__health-head {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
