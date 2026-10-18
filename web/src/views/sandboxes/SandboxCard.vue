<template>
  <article class="sandbox-card" :class="{ 'is-pipeline': entry.owner === 'pipeline' }">
    <header class="sandbox-card__head">
      <span class="sandbox-card__dot" :data-state="aliveState" aria-hidden="true"></span>
      <h3 class="sandbox-card__title">Стенд t{{ entry.task }}</h3>
      <span class="sandbox-card__chip" :class="{ 'is-manual': entry.owner === 'manual' }">
        {{ entry.owner === 'manual' ? 'ручная' : 'конвейер' }}
      </span>

      <div class="sandbox-card__meta">
        <span v-if="entry.profile">профиль {{ entry.profile }}</span>
        <span v-if="entry.slot !== null">слот {{ entry.slot }}</span>
        <span v-if="updatedLabel">{{ updatedLabel }}</span>
      </div>
    </header>

    <div v-if="job && job.state === 'running'" class="sandbox-card__progress">
      <UiProgress
        :label="`${jobTitle} стенда t${entry.task}`"
        :value="job.index"
        :max="job.total"
        :indeterminate="!job.total"
        :value-text="progressLabel"
      />
      <p class="sandbox-card__step">{{ progressLabel }}</p>
    </div>

    <UiInlineMessage v-if="job && job.state === 'failed'" tone="danger">
      {{ job.message || 'Задание завершилось с ошибкой.' }}
    </UiInlineMessage>
    <UiInlineMessage
      v-else-if="job && job.action === 'down' && job.state === 'done' && job.message"
      tone="warning"
    >
      {{ job.message }}
    </UiInlineMessage>
    <UiInlineMessage
      v-else-if="job && job.action === 'run' && job.state === 'done'"
      tone="success"
    >
      <span class="sandbox-card__result">{{ runSummary }}</span>
    </UiInlineMessage>

    <!-- Журнал задания — по запросу: итог в карточке короткий, а прогон профиля печатает
         сверку по шагам, которую человек читает целиком. -->
    <div v-if="job && (job.action === 'run' || job.state === 'failed')" class="sandbox-card__log">
      <UiDisclosureButton
        density="compact"
        :open="logOpen"
        :controls="`sandbox-log-${entry.task}`"
        @update:open="toggleLog"
      >
        {{ logOpen ? 'Скрыть журнал' : 'Журнал задания' }}
      </UiDisclosureButton>
      <pre
        v-if="logOpen"
        :id="`sandbox-log-${entry.task}`"
        class="sandbox-card__log-text"
      >{{ logText || 'Вывода пока нет.' }}</pre>
      <p v-if="logOpen && logTruncated" class="sandbox-card__hint">
        Показан только хвост журнала.
      </p>
    </div>

    <div v-if="hasPorts || entry.standAlive !== null" class="sandbox-card__ports">
      <a
        v-if="feHref"
        class="sandbox-port"
        :href="feHref"
        target="_blank"
        rel="noopener"
        v-tooltip="`Открыть фронт стенда: ${feHref}`"
      >Фронт <b>:{{ entry.fePort }}</b><span aria-hidden="true"> ↗</span></a>

      <a
        v-if="apiHref"
        class="sandbox-port"
        :href="apiHref"
        target="_blank"
        rel="noopener"
        v-tooltip="`Открыть API стенда: ${apiHref}`"
      >API <b>:{{ entry.apiPort }}</b><span aria-hidden="true"> ↗</span></a>

      <span class="sandbox-card__alive" :data-state="aliveState">{{ aliveLabel }}</span>
    </div>

    <ul v-if="entry.repos.length" class="sandbox-card__repos">
      <li v-for="repo in entry.repos" :key="repo.path" class="sandbox-repo">
        <span class="sandbox-repo__name">{{ repo.name }}</span>
        <span class="sandbox-repo__branch" v-tooltip="repo.branch || undefined">
          {{ repo.branch || 'ветка неизвестна' }}
        </span>
        <code class="sandbox-repo__path" v-tooltip="repo.path">{{ repo.path }}</code>
        <UiIconButton
          role="embedded"
          :label="copyLabel(repo.path)"
          v-tooltip="copyLabel(repo.path)"
          @click="copyPath(repo.path)"
        >
          <svg v-if="copied === repo.path" v-bind="ICON" aria-hidden="true">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          <svg v-else v-bind="ICON" aria-hidden="true">
            <rect x="9" y="9" width="13" height="13" rx="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        </UiIconButton>
      </li>
    </ul>

    <!-- Действия профиля: прогоны на поднятом стенде, объявленные рядом с его up/down.
         Доступны и стенду конвейера — на воротах приёмки человек гоняет стенд руками. -->
    <div v-if="actions.length" class="sandbox-card__runs">
      <UiButton
        v-for="action in actions"
        :key="action.id"
        variant="ghost"
        tone="accent"
        v-tooltip="action.description"
        :aria-disabled="busy || (job !== null && job.state === 'running')"
        @click="emit('run', { task: entry.task, action })"
      >
        {{ action.label }}
      </UiButton>
    </div>

    <footer
      v-if="entry.removable || blockedReason"
      class="sandbox-card__actions"
      :class="{ 'is-blocked': !entry.removable }"
    >
      <p v-if="!entry.removable" class="sandbox-card__hint">{{ blockedReason }}</p>
      <template v-else>
        <UiButton
          variant="ghost"
          tone="danger"
          :aria-disabled="busy"
          @click="emit('dismantle', { task: entry.task, force: true })"
        >
          Снести вместе с незакоммиченным
        </UiButton>
        <UiButton
          variant="solid"
          tone="danger"
          :loading="busy"
          @click="emit('dismantle', { task: entry.task, force: false })"
        >
          Снести стенд
        </UiButton>
      </template>
    </footer>
  </article>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  UiButton,
  UiDisclosureButton,
  UiIconButton,
  UiInlineMessage,
  UiProgress,
  vTooltip,
} from '../../ui';
import { loadSandboxJobLog } from '../../actions/sandboxes';
import { sandboxUrl } from '../../shared/sandbox.js';
import { writeClipboardText } from '../../shared/clipboard.ts';
import type {
  SandboxActionDecl, SandboxEntry, SandboxJob,
} from '../../../../shared/plugins/sandboxes/sandboxContracts';

const ICON = {
  viewBox: '0 0 24 24',
  width: 16,
  height: 16,
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': 2,
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round',
} as const;

const props = defineProps<{
  entry: SandboxEntry;
  job: SandboxJob | null;
  busy: boolean;
}>();

const emit = defineEmits<{
  dismantle: [payload: {
    task: string;
    force: boolean;
  }];
  run: [payload: {
    task: string;
    action: SandboxActionDecl;
  }];
}>();

const copied = ref('');
const logOpen = ref(false);
const logText = ref('');
const logTruncated = ref(false);

const actions = computed(() => props.entry.actions ?? []);

const feHref = computed(() => sandboxUrl(props.entry.fePort));
const apiHref = computed(() => sandboxUrl(props.entry.apiPort));

// Пока подъём не дошёл до портов, строке адресов нечего сказать: у неё не остаётся
// ни ссылок, ни состояния, и вместо неё говорит полоса прогресса.
const hasPorts = computed(() => Boolean(feHref.value || apiHref.value));

// Живость считается реальностью — ответом порта, а не записью в реестре: реестр
// переживает и остановленные контейнеры, и убитый руками стенд. Состояние красит
// точку заголовка, поэтому оно отдельно от подписи.
const aliveState = computed(() => {
  if (props.entry.standAlive === null) {
    return 'unknown';
  }

  return props.entry.standAlive ? 'alive' : 'silent';
});

const aliveLabel = computed(() => {
  if (aliveState.value === 'unknown') {
    return 'портов ещё нет';
  }

  return aliveState.value === 'alive' ? 'порты отвечают' : 'порты молчат';
});

// Шаг по умолчанию, пока задание не назвало свой: у прогона журнал ещё пуст.
const RUNNING_STEP: Record<SandboxJob['action'], string> = {
  up: 'идёт подъём',
  down: 'идёт снос',
  run: 'идёт прогон',
};

// Заголовок задания словами: у прогона это подпись действия из манифеста профиля.
const jobTitle = computed(() => {
  const job = props.job;

  if (!job) {
    return '';
  }

  if (job.action === 'run') {
    return job.actionLabel || 'Прогон';
  }

  return job.action === 'up' ? 'Подъём' : 'Снос';
});

// Полоса прогресса сама по себе молчит: человеку нужен шаг словами, иначе неясно,
// клонируется ли база или уже поднимаются контейнеры.
const progressLabel = computed(() => {
  const job = props.job;

  if (!job) {
    return '';
  }

  const step = job.total ? `${job.index}/${job.total}` : '';
  const label = job.label || RUNNING_STEP[job.action];

  return step ? `${step} · ${label}` : label;
});

// Итог прогона — хвост его вывода, где скрипт печатает сверку; без вывода — одно слово.
const runSummary = computed(() => {
  const job = props.job;

  if (!job) {
    return '';
  }

  return job.message || `${job.actionLabel || 'Прогон'}: выполнено.`;
});

// Секунды записи реестра ничего не решают и только удлиняют строку меты.
const updatedLabel = computed(() => {
  const value = props.entry.updatedAt;

  if (!value) {
    return '';
  }

  const when = new Date(value).toLocaleString('ru-RU', {
    dateStyle: 'short',
    timeStyle: 'short',
  });

  return `реестр от ${when}`;
});

// Причину запрета считает сервер: клиентская догадка по состоянию задания разошлась
// бы с настоящим отказом ручки, а правило владения живёт там же, где и снос.
const BLOCKED: Record<string, string> = {
  pipeline_owned: 'Стендом владеет конвейер или общий checkout: он сносится из карточки задачи.',
  job_running: 'По стенду сейчас идёт работа.',
  unknown_owner: 'GrigDesk не знает, чей это стенд, — снос остаётся за скриптом профиля в терминале.',
};

const blockedReason = computed(() => BLOCKED[props.entry.removableReason || ''] || '');

function copyLabel(path: string) {
  return copied.value === path ? 'Скопировано' : 'Копировать путь';
}

/**
 * Журнал читается при открытии и перечитывается на каждую смену задания, пока
 * раскрыт: у идущего прогона хвост растёт, и держать в раскрытом блоке старый текст
 * значило бы показывать не то, что печатает скрипт.
 */
async function refreshLog() {
  const log = await loadSandboxJobLog(props.entry.task);

  if (log) {
    logText.value = log.text;
    logTruncated.value = log.truncated;
  }
}

async function toggleLog(open: boolean) {
  logOpen.value = open;

  if (open) {
    await refreshLog();
  }
}

watch(() => [props.job?.state, props.job?.label, props.job?.finishedAt], () => {
  if (logOpen.value) {
    void refreshLog();
  }
});

/**
 * Путь worktree чаще всего нужен в терминале, поэтому он копируется целиком, а
 * подтверждение показывается на самой кнопке — отдельного оповещения тут не надо.
 */
async function copyPath(value: string) {
  const ok = await writeClipboardText(value);

  copied.value = ok ? value : '';
}
</script>

<style scoped>
.sandbox-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: var(--shadow);
}

/* Стенд конвейера показан для сведения: он тише ручного и не притворяется кликабельным. */
.sandbox-card.is-pipeline {
  background: color-mix(in srgb, var(--surface) 55%, var(--ground));
  box-shadow: none;
}

.sandbox-card__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.sandbox-card__dot {
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: 50%;
  background: var(--idle);
}

.sandbox-card__dot[data-state='alive'] {
  background: var(--good);
}

.sandbox-card__dot[data-state='silent'] {
  background: var(--bad);
}

.sandbox-card__title {
  margin: 0;
  font-size: 15px;
  font-weight: 650;
}

.sandbox-card__chip {
  padding: 1px 8px;
  border: 1px solid var(--line-2);
  border-radius: 999px;
  color: var(--ink-mid);
  font-size: 11px;
}

.sandbox-card__chip.is-manual {
  border-color: color-mix(in srgb, var(--accent) 60%, transparent);
  color: var(--accent);
}

.sandbox-card__meta {
  display: flex;
  flex-wrap: wrap;
  margin-left: auto;
  gap: 4px 14px;
  color: var(--ink-mid);
  font-size: 12px;
}

.sandbox-card__progress {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--surface-2);
}

.sandbox-card__step {
  margin: 0;
  color: var(--ink-mid);
  font-size: 12px;
}

.sandbox-card__ports {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 10px;
}

.sandbox-port {
  padding: 3px 8px;
  border: 1px solid var(--line-2);
  border-radius: 6px;
  color: var(--accent);
  font-size: 11.5px;
  text-decoration: none;
  white-space: nowrap;
}

.sandbox-port b {
  font-family: var(--mono);
  font-weight: 600;
}

.sandbox-port:hover {
  border-color: var(--accent);
}

.sandbox-card__alive {
  color: var(--ink-mid);
  font-size: 12px;
}

.sandbox-card__alive[data-state='silent'] {
  color: var(--bad);
}

.sandbox-card__repos {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: 10px;
  list-style: none;
  overflow: hidden;
}

.sandbox-repo {
  display: grid;
  grid-template-columns: minmax(64px, auto) minmax(90px, auto) minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  background: color-mix(in srgb, var(--surface-2) 55%, transparent);
}

.sandbox-repo + .sandbox-repo {
  border-top: 1px solid var(--line);
}

.sandbox-repo__name {
  font-size: 12.5px;
  font-weight: 600;
}

.sandbox-repo__branch {
  overflow: hidden;
  color: var(--node-code);
  font-family: var(--mono);
  font-size: 11.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sandbox-repo__path {
  overflow: hidden;
  color: var(--ink-mid);
  font-family: var(--mono);
  font-size: 11.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sandbox-card__runs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.sandbox-card__result {
  white-space: pre-line;
}

.sandbox-card__log {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: flex-start;
}

.sandbox-card__log-text {
  width: 100%;
  max-height: 320px;
  margin: 0;
  padding: 10px 12px;
  overflow: auto;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--surface-2);
  color: var(--ink);
  font-family: var(--mono);
  font-size: 11.5px;
  line-height: 1.45;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.sandbox-card__actions {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 10px;
}

.sandbox-card__actions.is-blocked {
  justify-content: flex-start;
}

.sandbox-card__hint {
  margin: 0;
  color: var(--ink-mid);
  font-size: 12px;
}

@media (max-width: 720px) {
  .sandbox-card__meta {
    margin-left: 0;
    flex-basis: 100%;
  }

  .sandbox-repo {
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: 4px 10px;
  }

  .sandbox-repo__path {
    grid-area: 2 / 1 / 3 / -1;
  }

  .sandbox-card__actions {
    flex-wrap: wrap;
  }
}
</style>
