<template>
  <article class="scene" :data-stale="scene.stale ? 'yes' : 'no'">
    <header class="scene__head">
      <div class="scene__title">
        <span class="scene__order">{{ scene.order }}</span>
        <strong>{{ scene.title }}</strong>
        <span class="scene__screen">экран «{{ scene.screenId }}»</span>
      </div>
      <span class="scene__state">{{ stateText }}</span>
    </header>

    <div class="scene__grid">
      <UiField label="Что говорит голос" hint="Короткая фраза с одной мыслью.">
        <UiTextarea v-model="draft.narration" :disabled="busy" rows="3" />
      </UiField>

      <UiField label="Подпись на экране" hint="Это подпись, а не дословный субтитр.">
        <UiInput v-model="draft.caption" :disabled="busy" />
      </UiField>

      <UiField label="Субтитр" hint="Тот же смысл, что в речи, обычной письменной формой.">
        <UiTextarea v-model="draft.subtitleText" :disabled="busy" rows="2" />
      </UiField>
    </div>

    <div class="scene__media">
      <div class="scene__media-block">
        <span class="scene__media-title">Звук сцены</span>
        <UiAudio v-if="audioUrl" :src="audioUrl" :label="`Звук сцены «${scene.title}»`" />
        <p v-else class="scene__hint">Звука ещё нет — загрузите запись сцены.</p>
        <UiFilePicker
          accept="audio/wav,audio/x-wav,.wav"
          :disabled="busy"
          :label="audioUrl ? 'Заменить звук' : 'Загрузить звук'"
          @change="pickAudio"
        />
      </div>

      <div class="scene__media-block">
        <span class="scene__media-title">Запись экрана</span>
        <p class="scene__hint">
          {{ scene.clip ? clipText : 'Клипа ещё нет: запустите запись из карточки ролика.' }}
        </p>
      </div>
    </div>

    <ul v-if="speechChecks.length" class="scene__checks">
      <li v-for="check in speechChecks" :key="check.id" :data-status="check.status">
        <span class="scene__check-dot" aria-hidden="true"></span>
        <span>{{ CHECK_TEXT[check.status] }}: {{ check.reason }}</span>
        <span v-for="hint in check.suggestions" :key="hint" class="scene__hint">{{ hint }}</span>
      </li>
    </ul>

    <footer class="scene__actions">
      <UiButton variant="ghost" :disabled="!changed || busy" @click="save">Сохранить</UiButton>
      <UiButton variant="ghost" :disabled="busy || first" @click="emit('move', { id: scene.id, delta: -1 })">
        Выше
      </UiButton>
      <UiButton variant="ghost" :disabled="busy || last" @click="emit('move', { id: scene.id, delta: 1 })">
        Ниже
      </UiButton>
      <UiButton variant="ghost" tone="danger" :disabled="busy" @click="emit('remove', scene.id)">
        Удалить сцену
      </UiButton>
    </footer>
  </article>
</template>

<script setup lang="ts">
import { computed, reactive, watch } from 'vue';

import {
  UiAudio,
  UiButton,
  UiField,
  UiFilePicker,
  UiInput,
  UiTextarea,
} from '../../ui';
import type { ShowcaseCheck, ShowcaseScene } from '../../../../shared/showcaseContracts';

interface SceneTextPayload {
  id: string;
  narration: string;
  caption: string;
  subtitleText: string;
}

const props = defineProps<{
  scene: ShowcaseScene;
  checks: ShowcaseCheck[];
  audioUrl: string;
  busy: boolean;
  first: boolean;
  last: boolean;
}>();

const emit = defineEmits<{
  save: [payload: SceneTextPayload];
  remove: [id: string];
  move: [payload: { id: string; delta: number }];
  audio: [payload: { id: string; file: File }];
}>();

// Пропущенная проверка показывается наравне с пройденной, но своим словом: место,
// которое никто не слушал, зелёным быть не должно.
const CHECK_TEXT: Record<ShowcaseCheck['status'], string> = {
  passed: 'речь проверена',
  warning: 'спорное место',
  blocked: 'проверка не пускает дальше',
  skipped: 'проверка пропущена',
};

const draft = reactive({
  narration: props.scene.narration,
  caption: props.scene.caption,
  subtitleText: props.scene.subtitleText,
});

// Свежая запись сцены приходит после каждой правки и после задания: черновик
// подхватывает её, пока человек эту сцену не редактирует, иначе он потерял бы
// набранное из-за чужого обновления списка.
watch(() => props.scene, (scene) => {
  if (!changed.value) {
    draft.narration = scene.narration;
    draft.caption = scene.caption;
    draft.subtitleText = scene.subtitleText;
  }
});

const changed = computed(() => (
  draft.narration !== props.scene.narration
  || draft.caption !== props.scene.caption
  || draft.subtitleText !== props.scene.subtitleText
));

const speechChecks = computed(() => props.checks.filter((check) => check.kind === 'speech'));

const stateText = computed(() => {
  if (props.scene.stale) {
    return props.scene.clip ? 'нужна пересъёмка' : 'ещё не записана';
  }

  return 'готова';
});

const clipText = computed(() => {
  const seconds = Math.round((props.scene.clip?.durationMs ?? 0) / 100) / 10;

  return `Клип на ${seconds} с записан.`;
});

function save() {
  emit('save', {
    id: props.scene.id,
    narration: draft.narration,
    caption: draft.caption,
    subtitleText: draft.subtitleText,
  });
}

function pickAudio(files: File[]) {
  const file = files[0];

  if (file) {
    emit('audio', { id: props.scene.id, file });
  }
}
</script>

<style scoped>
.scene {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
  border: 1px solid var(--border, #2a2f3a);
  border-radius: 10px;
  background: var(--panel, #171a21);
  min-width: 0;
}

.scene[data-stale='yes'] {
  border-color: var(--warning, #b4823a);
}

.scene__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.scene__title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.scene__order {
  font-variant-numeric: tabular-nums;
  color: var(--muted, #9aa4b2);
}

.scene__screen,
.scene__state,
.scene__hint {
  color: var(--muted, #9aa4b2);
  font-size: 13px;
}

.scene__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 12px;
}

.scene__media {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 12px;
}

.scene__media-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.scene__media-title {
  font-size: 13px;
}

.scene__hint {
  margin: 0;
}

.scene__checks {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
}

.scene__checks li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  flex-wrap: wrap;
}

.scene__check-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
  align-self: center;
  background: var(--muted, #9aa4b2);
}

.scene__checks li[data-status='passed'] .scene__check-dot {
  background: var(--ok, #4c9a5a);
}

.scene__checks li[data-status='warning'] .scene__check-dot {
  background: var(--warning, #b4823a);
}

.scene__checks li[data-status='blocked'] .scene__check-dot {
  background: var(--danger, #d05353);
}

.scene__actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
</style>
