<template>
  <section class="showcase" aria-labelledby="showcase-title">
    <header class="showcase__head">
      <div class="showcase__intro">
        <h1 id="showcase-title">Презентации</h1>
        <p>
          Ролик о готовой работе по сценам: сценарий, озвучка, запись браузера и сборка
          mp4 с субтитрами. Адреса, экраны и вход берутся из объявления профиля —
          раздел не придумывает их сам и стенды не поднимает.
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

    <ShowcaseProjectCard
      v-if="store.opened"
      :project="store.opened"
      :seed="seed"
      :jobs="store.jobsOf(store.opened.id)"
      :busy="store.isBusy(store.opened.id)"
      :max-scenes="store.limits.maxScenes"
      :artifact-url="artifactUrl"
      @close="close"
      @record="record"
      @seed="prepareData"
      @data-updated="markDataUpdated"
      @brief="proposeBrief"
      @script="proposeScript"
      @voice="synthesize"
      @assemble="assemble"
      @cancel="cancel"
      @add-scene="addScene"
      @save-scene="saveScene"
      @remove-scene="removeScene"
      @move-scene="moveScene"
      @scene-audio="uploadAudio"
    />

    <template v-else>
    <section class="showcase__panel" aria-labelledby="showcase-create-title">
      <h2 id="showcase-create-title" class="showcase__panel-title">Завести ролик</h2>
      <ShowcaseCreateForm :profiles="store.profiles" :busy="creating" @create="create" />
    </section>

    <section class="showcase__block" aria-labelledby="showcase-list-title">
      <div class="showcase__block-head">
        <h2 id="showcase-list-title">Ролики</h2>
        <span v-if="store.projects.length" class="showcase__count">
          {{ store.projects.length }}
        </span>
      </div>

      <div v-if="!store.projects.length" class="showcase__empty">
        <strong>{{ store.loaded ? 'Роликов ещё нет' : 'Читаем состояние…' }}</strong>
        <p v-if="store.loaded">
          Заведённый ролик встанет сюда: с целью показа, состоянием сцен и ходом сборки.
        </p>
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

    <ShowcaseVoicePanel
      :catalog="store.voices"
      :busy="store.voiceBusy"
      @install="installVoice"
      @cancel="cancelVoiceInstall"
    />

    <section class="showcase__block" aria-labelledby="showcase-doctor-title">
      <div class="showcase__block-head">
        <h2 id="showcase-doctor-title">Готовность</h2>
        <UiButton variant="ghost" :loading="checking" @click="check">Проверить</UiButton>
      </div>

      <p v-if="!doctor" class="showcase__note">
        Проверка показывает, чего не хватает для записи и сборки. Пробы, которые ходят
        в сеть или стоят денег, запускаются отдельно и только по нажатию.
      </p>
      <ul v-else class="showcase__doctor">
        <li v-for="operation in doctor.operations" :key="operation.id">
          <span class="showcase__doctor-dot" :data-status="operation.status" aria-hidden="true" />
          <strong>{{ operation.title }}</strong>
          <span class="showcase__doctor-reason">{{ operation.reason }}</span>
          <span v-if="operation.manual" class="showcase__doctor-manual">запускается вручную</span>
        </li>
      </ul>
    </section>
  </section>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';

import { UiButton, UiInlineMessage, confirmDialog } from '../ui';
import {
  addShowcaseScene,
  assembleShowcase,
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
  proposeShowcaseBrief,
  proposeShowcaseScript,
  recordShowcase,
  removeShowcaseScene,
  synthesizeShowcase,
  reorderShowcaseScenes,
  updateShowcaseScene,
  useShowcaseStore,
  watchShowcase,
} from '../actions/showcase';
import { showcaseApi, showcaseErrorMessage } from '../shared/showcaseApi';
import type { SeedStatus } from '../actions/showcase';
import type { ShowcaseDoctor } from '../../../shared/showcaseContracts';
import ShowcaseCard from './showcase/ShowcaseCard.vue';
import ShowcaseCreateForm from './showcase/ShowcaseCreateForm.vue';
import ShowcaseProjectCard from './showcase/ShowcaseProjectCard.vue';
import ShowcaseVoicePanel from './showcase/ShowcaseVoicePanel.vue';

const store = useShowcaseStore();
const creating = ref(false);
const checking = ref(false);
const doctor = ref<ShowcaseDoctor | null>(null);
const seed = ref<SeedStatus | null>(null);

let stopWatching: (() => void) | null = null;

onMounted(() => {
  stopWatching = watchShowcase(store);
  void loadShowcase(store);
  void loadShowcaseVoices(store);
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

async function create(payload: {
  kind: 'project' | 'sandbox' | 'task';
  id: string;
  profile: string;
  title: string;
}) {
  creating.value = true;

  try {
    await createShowcaseProject(store, {
      ref: { kind: payload.kind, id: payload.id },
      profile: payload.profile,
      title: payload.title,
    });
  } finally {
    creating.value = false;
  }
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

async function record() {
  await recordShowcase(store);
}

async function synthesize() {
  await synthesizeShowcase(store);
}

async function proposeBrief(taskText: string) {
  await proposeShowcaseBrief(store, taskText);
}

async function proposeScript(taskText: string) {
  await proposeShowcaseScript(store, taskText);
}

/**
 * Сборка идёт до результата или до конкретной остановки. Подтверждения здесь нет
 * намеренно: она не принимает за человека ни нового сценария, ни расширения
 * доступа, ни внешней отправки — только собирает из уже принятого.
 */
async function assemble() {
  await assembleShowcase(store);
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

function artifactUrl(artifactId: string): string {
  return store.opened ? showcaseApi.artifactUrl(store.opened.id, artifactId) : '';
}

/**
 * Готовность спрашивается без цели: так видно общее состояние установки — браузер,
 * ffmpeg, место. Готовность конкретной цели показывает карточка ролика, у которой
 * эта цель уже выбрана.
 */
async function check() {
  checking.value = true;

  try {
    doctor.value = await showcaseApi.doctor(null, '');
    store.setError('');
  } catch (error) {
    store.setError(showcaseErrorMessage(error, 'Проверка готовности не удалась.'));
  } finally {
    checking.value = false;
  }
}
</script>

<style scoped>
.showcase {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 20px;
  min-width: 0;
}

.showcase__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.showcase__intro {
  max-width: 720px;
  min-width: 0;
}

.showcase__intro h1 {
  margin: 0 0 6px;
  font-size: 22px;
}

.showcase__intro p {
  margin: 0;
  color: var(--muted, #9aa4b2);
  font-size: 13px;
  line-height: 1.6;
}

.showcase__panel,
.showcase__block {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

.showcase__panel {
  padding: 16px;
  border: 1px solid var(--border, #2a2f3a);
  border-radius: 10px;
  background: var(--panel, #171a21);
}

.showcase__panel-title,
.showcase__block-head h2 {
  margin: 0;
  font-size: 15px;
}

.showcase__block-head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.showcase__count {
  font-size: 12px;
  color: var(--muted, #9aa4b2);
}

.showcase__empty {
  padding: 16px;
  border: 1px dashed var(--border, #2a2f3a);
  border-radius: 10px;
  color: var(--muted, #9aa4b2);
}

.showcase__empty p {
  margin: 6px 0 0;
  font-size: 13px;
}

.showcase__list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 12px;
}

.showcase__note {
  margin: 0;
  color: var(--muted, #9aa4b2);
  font-size: 13px;
}

.showcase__doctor {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.showcase__doctor li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 13px;
  min-width: 0;
  flex-wrap: wrap;
}

.showcase__doctor-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--muted, #9aa4b2);
  flex: none;
  align-self: center;
}

.showcase__doctor-dot[data-status='ready'] {
  background: var(--ok, #4c9a5a);
}

.showcase__doctor-dot[data-status='warning'] {
  background: var(--warning, #b4823a);
}

.showcase__doctor-dot[data-status='blocked'] {
  background: var(--danger, #d05353);
}

.showcase__doctor-reason {
  color: var(--muted, #9aa4b2);
  min-width: 0;
}

.showcase__doctor-manual {
  color: var(--muted, #9aa4b2);
  font-size: 12px;
  border: 1px solid var(--border, #2a2f3a);
  border-radius: 999px;
  padding: 1px 8px;
}
</style>
