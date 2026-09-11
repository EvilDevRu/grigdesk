<template>
  <article class="showcase-card" :data-state="project.state">
    <header class="showcase-card__head">
      <div class="showcase-card__identity">
        <span class="showcase-card__mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
            <rect x="3" y="5" width="18" height="14" rx="2" />
            <path d="m10 9 5 3-5 3z" />
          </svg>
        </span>
        <div class="showcase-card__title">
          <h3>{{ project.title }}</h3>
          <span class="showcase-card__target">{{ targetText }}</span>
        </div>
      </div>
      <span class="showcase-card__state" :data-state="project.state">
        <i aria-hidden="true"></i>{{ STATE_TEXT[project.state] }}
      </span>
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
      <UiButton variant="outline" tone="accent" @click="emit('open', project.id)">
        Открыть
      </UiButton>
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
  min-width: 0;
  flex-direction: column;
  gap: 14px;
  padding: 17px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--surface) 96%, #fff) 0%,
    var(--surface) 100%
  );
  box-shadow: inset 0 1px 0 #ffffff08;
  transition: border-color 150ms ease, transform 150ms ease;
}

.showcase-card:hover {
  border-color: var(--line-2);
  transform: translateY(-1px);
}

.showcase-card[data-state='blocked'] {
  border-color: color-mix(in srgb, var(--warn) 48%, var(--line));
}

.showcase-card__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.showcase-card__identity {
  display: flex;
  align-items: flex-start;
  gap: 11px;
  min-width: 0;
}

.showcase-card__mark {
  display: grid;
  flex: none;
  width: 38px;
  height: 38px;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--accent) 32%, var(--line));
  border-radius: 11px;
  background: color-mix(in srgb, var(--accent) 8%, var(--ground));
  color: var(--accent);
}

.showcase-card__mark svg {
  width: 18px;
  height: 18px;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.showcase-card__title {
  min-width: 0;
}

.showcase-card__title h3 {
  margin: 1px 0 3px;
  font-size: 15px;
  line-height: 1.3;
  overflow-wrap: anywhere;
}

.showcase-card__target {
  display: block;
  overflow: hidden;
  color: var(--ink-mid);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.showcase-card__state {
  display: inline-flex;
  flex: none;
  min-height: 24px;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--ground);
  color: var(--ink-mid);
  font-size: 10.5px;
  white-space: nowrap;
}

.showcase-card__state i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentcolor;
}

.showcase-card__state[data-state='ready'],
.showcase-card__state[data-state='done'] {
  border-color: color-mix(in srgb, var(--good) 34%, var(--line));
  color: var(--good);
}

.showcase-card__state[data-state='building'] {
  border-color: color-mix(in srgb, var(--accent) 36%, var(--line));
  color: var(--accent);
}

.showcase-card__state[data-state='blocked'] {
  border-color: color-mix(in srgb, var(--warn) 38%, var(--line));
  color: var(--warn);
}

.showcase-card__facts {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0;
  margin: 0;
  padding: 10px 0;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: color-mix(in srgb, var(--ground) 54%, transparent);
}

.showcase-card__facts > div {
  min-width: 0;
  padding-inline: 11px;
}

.showcase-card__facts > div + div {
  border-left: 1px solid var(--line);
}

.showcase-card__facts dt {
  color: var(--ink-mid);
  font-size: 10.5px;
}

.showcase-card__facts dd {
  margin: 2px 0 0;
  overflow: hidden;
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  background: var(--ink-mid);
  flex: none;
}

.showcase-card__job-dot[data-state='running'],
.showcase-card__job-dot[data-state='queued'] {
  background: var(--accent, #3b82f6);
}

.showcase-card__job-dot[data-state='failed'],
.showcase-card__job-dot[data-state='interrupted'] {
  background: var(--bad);
}

.showcase-card__job-dot[data-state='succeeded'] {
  background: var(--good);
}

.showcase-card__job-state,
.showcase-card__job-label {
  color: var(--ink-mid);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.showcase-card__actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  margin-top: auto;
  padding-top: 13px;
  border-top: 1px solid var(--line);
}

@media (prefers-reduced-motion: reduce) {
  .showcase-card {
    transition: none;
  }

  .showcase-card:hover {
    transform: none;
  }
}

@media (max-width: 440px) {
  .showcase-card__head {
    flex-direction: column;
  }

  .showcase-card__facts {
    grid-template-columns: minmax(0, 1fr);
    padding: 0;
  }

  .showcase-card__facts > div {
    padding: 9px 11px;
  }

  .showcase-card__facts > div + div {
    border-top: 1px solid var(--line);
    border-left: 0;
  }
}
</style>
