<template>
  <article class="scene" :data-stale="scene.stale ? 'yes' : 'no'">
    <header class="scene__head">
      <div class="scene__title">
        <span class="scene__order">{{ scene.order }}</span>
        <strong>{{ scene.title }}</strong>
      </div>
      <span class="scene__state">{{ stateText }}</span>
    </header>

    <!-- На виду только то, что человек правит чаще всего: слова диктора и подпись.
         Субтитр, загрузка своего звука и подробности записи — за раскрытием. -->
    <UiField label="Текст озвучки">
      <UiTextarea v-model="draft.narration" :disabled="busy" rows="3" />
    </UiField>

    <UiField label="Подпись на экране" hint="Короткая, не дословный субтитр.">
      <UiInput v-model="draft.caption" :disabled="busy" />
    </UiField>

    <UiAudio v-if="audioUrl" :src="audioUrl" :label="`Звук сцены «${scene.title}»`" />

    <ul v-if="speechChecks.length" class="scene__checks">
      <li v-for="check in speechChecks" :key="check.id" :data-status="check.status">
        <span class="scene__check-dot" aria-hidden="true"></span>
        <span>{{ CHECK_TEXT[check.status] }}: {{ check.reason }}</span>
        <span v-for="hint in check.suggestions" :key="hint" class="scene__hint">{{ hint }}</span>
      </li>
    </ul>

    <UiDisclosureButton
      v-model:open="moreOpen"
      :controls="`${scene.id}-more`"
      density="compact"
    >
      {{ moreOpen ? 'Скрыть подробности' : 'Субтитр, свой звук и запись' }}
    </UiDisclosureButton>

    <div v-show="moreOpen" :id="`${scene.id}-more`" class="scene__more">
      <UiField label="Субтитр" hint="Тот же смысл, что в речи, обычной письменной формой.">
        <UiTextarea v-model="draft.subtitleText" :disabled="busy" rows="2" />
      </UiField>

      <div class="scene__media-block">
        <span class="scene__media-title">Свой звук вместо синтеза</span>
        <p class="scene__hint">
          Загруженную запись озвучка не трогает: правка текста её не переозвучит.
        </p>
        <UiFilePicker
          accept="audio/wav,audio/x-wav,.wav"
          :disabled="busy"
          :label="audioUrl ? 'Заменить звук' : 'Загрузить звук'"
          @change="pickAudio"
        />
      </div>

      <p class="scene__hint">{{ clipText }}</p>
    </div>

    <footer class="scene__actions">
      <UiButton
        variant="solid"
        tone="accent"
        :disabled="!changed || busy"
        @click="save"
      >
        Сохранить
      </UiButton>
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
import { computed, reactive, ref, watch } from 'vue';

import {
  UiAudio,
  UiButton,
  UiDisclosureButton,
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

const moreOpen = ref(false);

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
  if (!props.scene.clip) {
    return 'Запись экрана появится после сборки ролика.';
  }

  const seconds = Math.round((props.scene.clip.durationMs ?? 0) / 100) / 10;

  return `Запись экрана: ${seconds} с.`;
});

/**
 * Субтитр по умолчанию повторяет речь: пока человек его не правил, он следует за
 * текстом озвучки, и заполнять два поля одним и тем же не нужно.
 */
function save() {
  const subtitleFollows = props.scene.subtitleText === props.scene.narration
    && draft.subtitleText === props.scene.subtitleText;

  emit('save', {
    id: props.scene.id,
    narration: draft.narration,
    caption: draft.caption,
    subtitleText: subtitleFollows ? draft.narration : draft.subtitleText,
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
  min-width: 0;
  flex-direction: column;
  gap: 12px;
  padding: 15px;
  border: 1px solid var(--line);
  border-radius: 13px;
  background: color-mix(in srgb, var(--ground) 60%, var(--surface));
}

.scene[data-stale='yes'] {
  border-color: color-mix(in srgb, var(--warn) 48%, var(--line));
  background: color-mix(in srgb, var(--warn) 3%, var(--ground));
}

.scene__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.scene__title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex-wrap: wrap;
}

.scene__order {
  display: grid;
  min-width: 24px;
  height: 24px;
  place-items: center;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--surface-2);
  color: var(--ink-mid);
  font-family: var(--mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.scene__state,
.scene__hint {
  color: var(--ink-mid);
  font-size: 12.5px;
}

.scene__state {
  padding: 2px 8px;
  border: 1px solid color-mix(in srgb, var(--good) 32%, var(--line));
  border-radius: 999px;
  color: var(--good);
  font-size: 10.5px;
}

.scene[data-stale='yes'] .scene__state {
  border-color: color-mix(in srgb, var(--warn) 38%, var(--line));
  color: var(--warn);
}

.scene__more {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

.scene__media-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding: 11px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: color-mix(in srgb, var(--surface) 62%, transparent);
}

.scene__media-title {
  font-size: 12px;
  font-weight: 650;
}

.scene__hint {
  margin: 0;
  line-height: 1.45;
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
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: color-mix(in srgb, var(--surface) 54%, transparent);
}

.scene__check-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
  align-self: center;
  background: var(--ink-mid);
}

.scene__checks li[data-status='passed'] .scene__check-dot {
  background: var(--good);
}

.scene__checks li[data-status='warning'] .scene__check-dot {
  background: var(--warn);
}

.scene__checks li[data-status='blocked'] .scene__check-dot {
  background: var(--bad);
}

.scene__actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
  padding-top: 12px;
  border-top: 1px solid var(--line);
}

@media (max-width: 560px) {
  .scene {
    padding: 13px;
  }
}
</style>
