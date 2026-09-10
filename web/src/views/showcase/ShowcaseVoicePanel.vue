<template>
  <section class="voice" aria-labelledby="showcase-voice-title">
    <div class="voice__head">
      <h2 id="showcase-voice-title">Голос</h2>
      <span v-if="readyEngine" class="voice__ready">{{ readyEngine.name }}</span>
    </div>

    <p class="voice__note">
      Озвучка идёт на этой машине: ни ключей, ни запросов наружу синтезу не нужно.
      Скачивание движка и модели — отдельное действие: оно весит сотни мегабайт и
      начинается только по нажатию.
    </p>

    <ul v-if="catalog" class="voice__engines">
      <li v-for="engine in catalog.engines" :key="engine.id">
        <span class="voice__dot" :data-status="engine.doctor.status" aria-hidden="true" />
        <strong>{{ engine.name }}</strong>
        <span class="voice__reason">{{ engine.doctor.reason }}</span>
        <span v-if="engine.doctor.install" class="voice__install">{{ engine.doctor.install }}</span>
      </li>
    </ul>

    <div v-if="job" class="voice__job" :data-state="job.state">
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

    <ul v-if="catalog" class="voice__packages">
      <li v-for="item in catalog.install.available" :key="item.id">
        <div class="voice__package-copy">
          <strong>{{ item.name }}</strong>
          <span class="voice__package-about">
            {{ item.timbre }}, {{ item.language }} · {{ megabytes(item.byteSize) }} · {{ item.license }}
          </span>
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
        <span v-else class="voice__package-done">Установлен</span>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import { UiButton } from '../../ui';
import type { ShowcaseVoiceCatalog } from '../../../../shared/showcaseContracts';

const props = defineProps<{
  catalog: ShowcaseVoiceCatalog | null;
  busy: boolean;
}>();

const emit = defineEmits<{
  install: [voiceId: string];
  cancel: [];
}>();

const job = computed(() => props.catalog?.install.job ?? null);

const installing = computed(() => job.value?.state === 'running');

// Готовый движок называется отдельно: у раздела их несколько, и человеку важно
// знать, чей голос он услышит, а не только что «что-то готово».
const readyEngine = computed(
  () => props.catalog?.engines.find((engine) => engine.doctor.status === 'ready') ?? null,
);

const JOB_TITLES: Record<string, string> = {
  running: 'Идёт установка',
  succeeded: 'Установка завершена',
  failed: 'Установка не удалась',
  cancelled: 'Установка отменена',
  interrupted: 'Установка оборвалась',
};

const jobTitle = computed(() => JOB_TITLES[job.value?.state ?? ''] ?? 'Установка');

function megabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} МБ`;
}
</script>

<style scoped>
.voice {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface);
}

.voice__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.voice__head h2 {
  margin: 0;
  font-size: 15px;
}

.voice__ready {
  font-size: 12px;
  color: var(--muted);
}

.voice__note {
  margin: 0;
  font-size: 13px;
  color: var(--muted);
  max-width: 720px;
}

.voice__engines,
.voice__packages {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.voice__engines li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 13px;
}

.voice__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--muted);
}

.voice__dot[data-status='ready'] {
  background: var(--ok, #3fb950);
}

.voice__dot[data-status='blocked'] {
  background: var(--danger, #f85149);
}

.voice__reason,
.voice__install {
  color: var(--muted);
}

.voice__job {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  font-size: 13px;
}

.voice__job[data-state='failed'],
.voice__job[data-state='interrupted'] {
  border-color: var(--danger, #f85149);
}

.voice__job-label,
.voice__job-error {
  color: var(--muted);
}

.voice__packages li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
}

.voice__package-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.voice__package-about {
  font-size: 12px;
  color: var(--muted);
}

.voice__package-done {
  font-size: 12px;
  color: var(--muted);
}
</style>
