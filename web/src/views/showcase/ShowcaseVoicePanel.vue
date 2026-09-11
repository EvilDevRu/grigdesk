<template>
  <section class="voice" :data-mode="mode" aria-labelledby="showcase-voice-title">
    <header class="voice__head">
      <div>
        <p class="voice__kicker">Озвучка</p>
        <h3 id="showcase-voice-title">{{ mode === 'choice' ? 'Голос ролика' : 'Голоса' }}</h3>
      </div>
      <span
        class="voice__ready"
        :data-state="voiceState.tone"
        role="status"
        aria-live="polite"
      >
        <i aria-hidden="true"></i>{{ voiceState.label }}
      </span>
    </header>

    <!-- Выбор голоса — один на весь ролик: сцены, говорящие разными голосами,
         читаются как ошибка. Образец слушается одним нажатием: по имени голос не
         выбрать, а тембр — единственное, что здесь важно. -->
    <div v-if="mode === 'choice'" class="voice__choice">
      <UiField
        label="Голос"
        hint="Один голос на все сцены. После смены звук устареет, и следующая сборка переозвучит их."
      >
        <UiSelect
          data-testid="showcase-voice-select"
          :model-value="currentVoice"
          :disabled="busy || !groups.length"
          @update:model-value="onVoice"
        >
          <option v-if="!groups.length" value="">голос ещё не установлен</option>
          <optgroup v-for="group in groups" :key="group.engineId" :label="group.name">
            <option v-for="voice in group.voices" :key="voice.ref" :value="voice.ref">
              {{ voice.name }}
            </option>
          </optgroup>
        </UiSelect>
      </UiField>

      <div class="voice__row">
        <UiButton
          variant="outline"
          data-testid="showcase-voice-preview"
          :disabled="!currentVoice || busy"
          :loading="previewing"
          @click="preview"
        >
          Прослушать образец
        </UiButton>
        <span v-if="previewError" class="voice__error" role="alert">{{ previewError }}</span>
      </div>

      <UiField label="Темп речи">
        <UiSegmentedControl
          :model-value="currentPace"
          :options="PACES"
          label="Темп речи"
          :disabled="busy"
          @update:model-value="onPace"
        />
      </UiField>

      <UiDisclosureButton
        v-model:open="setupOpen"
        controls="showcase-voice-setup"
        density="compact"
      >
        {{ setupOpen ? 'Скрыть установку голосов' : 'Установить другие голоса' }}
      </UiDisclosureButton>
    </div>

    <div v-show="mode === 'setup' || setupOpen" id="showcase-voice-setup" class="voice__setup">
      <p class="voice__note">
        Локальные движки говорят на этой машине без ключей и запросов наружу: движок и
        модель скачиваются один раз, по нажатию — размер назван до него. Облачный голос
        Яндекса включается ключом в корневом .env сервера; тогда текст сцен уходит
        поставщику, а синтез платный.
      </p>

      <ul v-if="catalog" class="voice__engines">
        <li v-for="engine in catalog.engines" :key="engine.id">
          <span class="voice__dot" :data-status="engine.doctor.status" aria-hidden="true" />
          <div class="voice__engine-copy">
            <div class="voice__engine-line">
              <strong>{{ engine.name }}</strong>
              <span class="voice__engine-state" :data-status="engine.doctor.status">
                {{ engineState(engine.doctor.status) }}
              </span>
            </div>
            <span class="voice__reason">{{ engine.doctor.reason }}</span>
            <span v-if="engine.doctor.install" class="voice__install">
              {{ engine.doctor.install }}
            </span>
          </div>
        </li>
      </ul>

      <div
        v-if="job"
        class="voice__job"
        :data-state="job.state"
        role="status"
        aria-live="polite"
      >
        <strong>{{ jobTitle }}</strong>
        <span class="voice__job-label">{{ job.label }}</span>
        <span v-if="job.error" class="voice__job-error">{{ job.error }}</span>
        <UiButton
          v-if="job.state === 'running'"
          variant="ghost"
          :loading="busy"
          @click="emit('cancel')"
        >
          Отменить
        </UiButton>
      </div>

      <ul v-if="catalog?.install.available.length" class="voice__packages">
        <li v-for="item in catalog.install.available" :key="item.id">
          <span class="voice__avatar" aria-hidden="true">{{ item.name.slice(0, 1) }}</span>
          <div class="voice__package-copy">
            <strong>{{ item.name }}</strong>
            <span class="voice__package-about">{{ packageAbout(item) }}</span>
          </div>
          <UiButton
            v-if="!item.installed"
            :data-testid="`showcase-voice-install-${item.id}`"
            :loading="busy"
            :disabled="installing"
            @click="emit('install', item.id)"
          >
            Установить
          </UiButton>
          <span v-else class="voice__package-done">
            <i aria-hidden="true"></i>Установлен
          </span>
        </li>
      </ul>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import {
  UiButton,
  UiDisclosureButton,
  UiField,
  UiSegmentedControl,
  UiSelect,
} from '../../ui';
import type {
  ShowcaseVoiceCatalog,
  ShowcaseVoicePackage,
} from '../../../../shared/showcaseContracts';

type Pace = 'slow' | 'normal' | 'fast';

const props = withDefaults(defineProps<{
  catalog: ShowcaseVoiceCatalog | null;
  busy: boolean;
  // Режим «установка» живёт на первом шаге, пока говорить нечем; «выбор» — на
  // экране ролика, где голос уже есть и его надо услышать и сменить.
  mode?: 'setup' | 'choice';
  voiceRef?: string | null;
  pace?: Pace | null;
  // Адрес образца строит вид: у панели нет доступа к сети, и стаб в тестах ей не нужен.
  previewUrl?: (voiceRef: string) => string;
}>(), {
  mode: 'setup',
  voiceRef: null,
  pace: null,
  previewUrl: () => '',
});

const emit = defineEmits<{
  install: [voiceId: string];
  cancel: [];
  change: [choice: { voiceRef: string | null; pace: Pace | null }];
}>();

const PACES: { value: Pace; label: string }[] = [
  { value: 'slow', label: 'Медленнее' },
  { value: 'normal', label: 'Обычный' },
  { value: 'fast', label: 'Быстрее' },
];

const previewing = ref(false);
const previewError = ref('');
const setupOpen = ref(false);

const job = computed(() => props.catalog?.install.job ?? null);

const installing = computed(() => job.value?.state === 'running');

// Готовый движок называется отдельно: у раздела их несколько, и человеку важно
// знать, чей голос он услышит, а не только что «что-то готово».
const readyEngine = computed(
  () => props.catalog?.engines.find((engine) => engine.doctor.status === 'ready') ?? null,
);

// Голоса, которыми можно говорить прямо сейчас, сгруппированные по движку.
// Недоступные в список выбора не попадают: выбрать голос, который молчит, нельзя.
const groups = computed(() => (props.catalog?.engines ?? [])
  .map((engine) => ({
    engineId: engine.id,
    name: engine.name,
    voices: engine.voices
      .filter((voice) => voice.available)
      .map((voice) => ({ ref: `${engine.id}:${voice.id}`, name: voice.name })),
  }))
  .filter((group) => group.voices.length > 0));

// Пока человек ничего не выбирал, звучит первый доступный голос первого готового
// движка — ровно тот, который возьмёт сервер. Показывать пустой выбор нельзя:
// голос у ролика есть всегда.
const currentVoice = computed(() => {
  const known = groups.value.flatMap((group) => group.voices.map((voice) => voice.ref));

  if (props.voiceRef && known.includes(props.voiceRef)) {
    return props.voiceRef;
  }

  return known[0] ?? '';
});

const currentPace = computed<Pace>(() => props.pace ?? 'normal');

const voiceState = computed(() => {
  if (!props.catalog) {
    return { tone: 'idle', label: 'Проверяем' };
  }

  return readyEngine.value
    ? { tone: 'ready', label: readyEngine.value.name }
    : { tone: 'blocked', label: 'Не настроен' };
});

// Установка раскрыта сама, пока говорить нечем: иначе человек искал бы кнопку.
watch(readyEngine, (engine) => {
  if (!engine) {
    setupOpen.value = true;
  }
}, { immediate: true });

const JOB_TITLES: Record<string, string> = {
  running: 'Идёт установка',
  succeeded: 'Установка завершена',
  failed: 'Установка не удалась',
  cancelled: 'Установка отменена',
  interrupted: 'Установка оборвалась',
};

const jobTitle = computed(() => JOB_TITLES[job.value?.state ?? ''] ?? 'Установка');

const ENGINE_STATES: Record<string, string> = {
  ready: 'готов',
  warning: 'есть ограничение',
  blocked: 'нужна настройка',
  unknown: 'не проверен',
};

function engineState(status: string): string {
  return ENGINE_STATES[status] ?? status;
}

function megabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} МБ`;
}

/**
 * Подпись пакета: кого услышишь, сколько скачается и на каких условиях. Голоса
 * перечислены по именам — модель на пять дикторов иначе выглядела бы одним.
 */
function packageAbout(item: ShowcaseVoicePackage): string {
  const voices = item.voices.length > 1 ? `голоса: ${item.voices.join(', ')}` : item.timbre;

  return `${voices} · ${megabytes(item.byteSize)} · ${item.license}`;
}

// Смена голоса уходит наверх только когда выбор действительно изменился: сервер
// перезаписывает все сцены, и повтор того же значения старил бы их звук зря.
function onVoice(value: unknown): void {
  const voiceRef = typeof value === 'string' && value ? value : null;

  if (voiceRef !== currentVoice.value) {
    emit('change', { voiceRef, pace: currentPace.value });
  }
}

// Темп меняется вместе с текущим голосом: серверу нужен полный выбор, а не одно
// из двух полей.
function onPace(value: Pace): void {
  if (value !== currentPace.value) {
    emit('change', { voiceRef: currentVoice.value || null, pace: value });
  }
}

/**
 * Образец воспроизводится сразу, без плеера на экране: первый запрос ещё и
 * синтезирует фразу, поэтому кнопка занята до начала звука, а не до конца.
 */
async function preview(): Promise<void> {
  if (!currentVoice.value || typeof Audio === 'undefined') {
    return;
  }

  previewing.value = true;
  previewError.value = '';

  try {
    await new Audio(props.previewUrl(currentVoice.value)).play();
  } catch {
    previewError.value = 'Образец не воспроизвёлся: движок не ответил.';
  } finally {
    previewing.value = false;
  }
}
</script>

<style scoped>
.voice {
  display: flex;
  min-width: 0;
  flex-direction: column;
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

.voice__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.voice__kicker {
  margin: 0 0 3px;
  color: var(--accent);
  font-size: 9.5px;
  font-weight: 750;
  letter-spacing: 0.1em;
  line-height: 1.2;
  text-transform: uppercase;
}

.voice__head h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 660;
  letter-spacing: -0.01em;
}

.voice__ready {
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

.voice__ready i,
.voice__package-done i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentcolor;
}

.voice__ready[data-state='ready'] {
  border-color: color-mix(in srgb, var(--good) 34%, var(--line));
  color: var(--good);
}

.voice__ready[data-state='blocked'] {
  border-color: color-mix(in srgb, var(--bad) 36%, var(--line));
  color: var(--bad);
}

.voice__choice,
.voice__setup {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

.voice__row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.voice__error {
  color: var(--bad);
  font-size: 12.5px;
}

.voice__note {
  margin: 0;
  max-width: 680px;
  color: var(--ink-mid);
  font-size: 12.5px;
  line-height: 1.5;
}

.voice__engines,
.voice__packages {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.voice__engines li {
  display: grid;
  grid-template-columns: 8px minmax(0, 1fr);
  align-items: start;
  gap: 9px;
  min-width: 0;
  padding: 10px 11px;
  border: 1px solid var(--line);
  border-radius: 11px;
  background: color-mix(in srgb, var(--ground) 58%, transparent);
}

.voice__dot {
  width: 8px;
  height: 8px;
  margin-top: 5px;
  border-radius: 50%;
  background: var(--ink-mid);
}

.voice__dot[data-status='ready'] {
  background: var(--good);
}

.voice__dot[data-status='blocked'] {
  background: var(--bad);
}

.voice__dot[data-status='warning'] {
  background: var(--warn);
}

.voice__engine-copy {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.voice__engine-line {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.voice__engine-line strong {
  font-size: 12.5px;
}

.voice__engine-state {
  flex: none;
  color: var(--ink-mid);
  font-size: 10.5px;
}

.voice__engine-state[data-status='ready'] {
  color: var(--good);
}

.voice__engine-state[data-status='warning'] {
  color: var(--warn);
}

.voice__engine-state[data-status='blocked'] {
  color: var(--bad);
}

.voice__reason,
.voice__install {
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.45;
}

.voice__install {
  padding-top: 4px;
  border-top: 1px solid var(--line);
  font-size: 11.5px;
}

.voice__job {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--line));
  border-radius: 10px;
  background: color-mix(in srgb, var(--accent) 6%, var(--surface));
  font-size: 13px;
}

.voice__job[data-state='failed'],
.voice__job[data-state='interrupted'] {
  border-color: color-mix(in srgb, var(--bad) 42%, var(--line));
  background: color-mix(in srgb, var(--bad) 6%, var(--surface));
}

.voice__job-label,
.voice__job-error {
  color: var(--ink-mid);
}

.voice__packages li {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: 11px;
  background: color-mix(in srgb, var(--ground) 58%, transparent);
}

.voice__avatar {
  display: grid;
  width: 34px;
  height: 34px;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--line));
  border-radius: 10px;
  background: color-mix(in srgb, var(--accent) 9%, var(--surface-2));
  color: var(--accent);
  font-size: 13px;
  font-weight: 700;
}

.voice__package-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.voice__package-about {
  font-size: 12px;
  color: var(--ink-mid);
  line-height: 1.4;
}

.voice__package-done {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--good);
  font-size: 11px;
}

@media (max-width: 520px) {
  .voice__head,
  .voice__engine-line {
    align-items: flex-start;
    flex-direction: column;
  }

  .voice__packages li {
    grid-template-columns: 34px minmax(0, 1fr);
  }

  .voice__packages li > :last-child {
    grid-column: 2;
    justify-self: start;
  }
}
</style>
