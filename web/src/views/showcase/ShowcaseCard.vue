<template>
  <article class="showcase-card" :data-state="project.state">
    <header class="showcase-card__head">
      <div class="showcase-card__title">
        <h3>{{ project.title }}</h3>
        <span class="showcase-card__target">{{ targetText }}</span>
      </div>
      <span class="showcase-card__state">{{ STATE_TEXT[project.state] }}</span>
    </header>

    <dl class="showcase-card__facts">
      <div>
        <dt>Сцен</dt>
        <dd>{{ project.sceneCount || '—' }}</dd>
      </div>
      <div>
        <dt>Готовый ролик</dt>
        <dd>{{ project.hasFinal ? 'есть' : 'нет' }}</dd>
      </div>
      <div>
        <dt>Изменён</dt>
        <dd>{{ updatedText }}</dd>
      </div>
    </dl>

    <ul v-if="jobs.length" class="showcase-card__jobs">
      <li v-for="job in jobs" :key="job.id">
        <span class="showcase-card__job-dot" :data-state="job.state" aria-hidden="true"></span>
        <strong>{{ JOB_KIND[job.kind] }}</strong>
        <span class="showcase-card__job-state">{{ JOB_STATE[job.state] }}</span>
        <span v-if="job.progress.label" class="showcase-card__job-label">
          {{ job.progress.label }}
        </span>
        <UiButton
          v-if="isRunning(job.state)"
          variant="ghost"
          size="compact"
          @click="emit('cancel', job.id)"
        >
          Отменить
        </UiButton>
      </li>
    </ul>

    <footer class="showcase-card__actions">
      <UiButton variant="ghost" @click="emit('open', project.id)">Открыть</UiButton>
      <UiButton variant="ghost" tone="danger" :loading="busy" @click="emit('remove', project.id)">
        Удалить
      </UiButton>
    </footer>
  </article>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import { UiButton } from '../../ui';
import type { ShowcaseJob, ShowcaseProjectSummary } from '../../../../shared/showcaseContracts';

const props = defineProps<{
  project: ShowcaseProjectSummary;
  jobs: ShowcaseJob[];
  busy: boolean;
}>();

const emit = defineEmits<{
  open: [id: string];
  remove: [id: string];
  cancel: [jobId: string];
}>();

const STATE_TEXT: Record<ShowcaseProjectSummary['state'], string> = {
  draft: 'черновик',
  ready: 'сцены готовы',
  building: 'идёт сборка',
  blocked: 'нужен человек',
  done: 'ролик собран',
};

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

const KIND_TEXT: Record<ShowcaseProjectSummary['ref']['kind'], string> = {
  project: 'проект',
  sandbox: 'песочница',
  task: 'задача',
};

const targetText = computed(() => {
  const kind = KIND_TEXT[props.project.ref.kind];

  return props.project.targetLabel || `${kind} ${props.project.ref.id}`;
});

const updatedText = computed(() => new Date(props.project.updatedAt).toLocaleString('ru-RU'));

function isRunning(state: ShowcaseJob['state']): boolean {
  return state === 'queued' || state === 'running';
}
</script>

<style scoped>
.showcase-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  border: 1px solid var(--border, #2a2f3a);
  border-radius: 10px;
  background: var(--panel, #171a21);
}

.showcase-card[data-state='blocked'] {
  border-color: var(--warning, #b4823a);
}

.showcase-card__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.showcase-card__title {
  min-width: 0;
}

.showcase-card__title h3 {
  margin: 0;
  font-size: 16px;
  overflow-wrap: anywhere;
}

.showcase-card__target {
  color: var(--muted, #9aa4b2);
  font-size: 13px;
}

.showcase-card__state {
  flex: none;
  font-size: 12px;
  color: var(--muted, #9aa4b2);
}

.showcase-card__facts {
  display: flex;
  gap: 20px;
  margin: 0;
  flex-wrap: wrap;
}

.showcase-card__facts dt {
  font-size: 12px;
  color: var(--muted, #9aa4b2);
}

.showcase-card__facts dd {
  margin: 2px 0 0;
  font-size: 14px;
}

.showcase-card__jobs {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.showcase-card__jobs li {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  min-width: 0;
}

.showcase-card__job-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--muted, #9aa4b2);
  flex: none;
}

.showcase-card__job-dot[data-state='running'],
.showcase-card__job-dot[data-state='queued'] {
  background: var(--accent, #3b82f6);
}

.showcase-card__job-dot[data-state='failed'],
.showcase-card__job-dot[data-state='interrupted'] {
  background: var(--danger, #d05353);
}

.showcase-card__job-dot[data-state='succeeded'] {
  background: var(--ok, #4c9a5a);
}

.showcase-card__job-state,
.showcase-card__job-label {
  color: var(--muted, #9aa4b2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.showcase-card__actions {
  display: flex;
  justify-content: flex-end;
}
</style>
