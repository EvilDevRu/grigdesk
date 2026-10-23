<template>
  <article class="sandbox-card ui-workspace-section" :aria-labelledby="`sandbox-title-${entry.task}`">
    <UiPaneHeader class="sandbox-card__head">
      <template #title><h3 :id="`sandbox-title-${entry.task}`">Стенд t{{ entry.task }}</h3></template>
      <template #meta>
        <span class="sandbox-card__alive" :data-state="aliveState">
          <span class="sandbox-card__dot" aria-hidden="true"></span>{{ aliveLabel }}
        </span>
      </template>
      <template #actions>
        <div class="sandbox-card__meta">
          <span v-if="entry.profile">Профиль: {{ entry.profile }}</span>
          <span v-if="entry.slot !== null">Слот {{ entry.slot }}</span>
        </div>
      </template>
    </UiPaneHeader>
    <div class="sandbox-card__body">
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
          data-context="workspace-form"
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

      <div v-if="hasPorts" class="sandbox-card__ports">
        <UiActionLink v-if="feHref" :href="feHref" target="_blank" tone="accent"
                      :aria-label="`Открыть сайт стенда t${entry.task}`"
                      data-context="workspace-form" v-tooltip="`Открыть сайт стенда: ${feHref}`">
          Сайт <span class="sandbox-card__port">:{{ entry.fePort }}</span>
          <span aria-hidden="true">↗</span>
        </UiActionLink>
        <UiActionLink v-if="apiHref" :href="apiHref" target="_blank" data-context="workspace-form"
                      v-tooltip="`Открыть API — интерфейс сервера: ${apiHref}`">
          API <span class="sandbox-card__port">:{{ entry.apiPort }}</span><span aria-hidden="true">↗</span>
        </UiActionLink>
      </div>

      <div v-if="actions.length" class="sandbox-card__runs">
        <div v-for="action in actions" :key="action.id" class="sandbox-card__run">
          <UiButton variant="outline" data-context="workspace-form-wrap"
                    :aria-disabled="busy || (job !== null && job.state === 'running')"
                    @click="emit('run', { task: entry.task, action })">
            {{ action.label }}
          </UiButton>
          <p v-if="action.description" class="sandbox-card__hint">{{ action.description }}</p>
        </div>
      </div>

      <div class="sandbox-card__tools">
        <details v-if="entry.repos.length || updatedLabel" class="ui-workspace-disclosure sandbox-card__details"
                 data-context="workspace-inline">
          <summary>
            <template v-if="entry.repos.length">Код и рабочие папки · {{ entry.repos.length }}</template>
            <template v-else>Сведения о стенде</template>
          </summary>
          <div class="ui-workspace-section__body">
            <p v-if="entry.repos.length" class="sandbox-card__hint">
              Отдельные копии репозиториев стенда (worktree). Путь можно скопировать.
            </p>
            <ul v-if="entry.repos.length" class="sandbox-card__repos">
              <li v-for="repo in entry.repos" :key="repo.path" class="sandbox-repo">
                <span class="sandbox-repo__name">{{ repo.name }}</span>
                <span class="sandbox-repo__branch" v-tooltip="repo.branch || undefined">
                  {{ repo.branch || 'ветка неизвестна' }}
                </span>
                <code class="sandbox-repo__path" v-tooltip="repo.path">{{ repo.path }}</code>
                <UiIconButton
                  role="embedded"
                  data-context="workspace-form"
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

            <p v-if="updatedLabel" class="sandbox-card__hint">{{ updatedLabel }}</p>
          </div>
        </details>

        <details v-if="entry.removable" class="ui-workspace-disclosure sandbox-card__removal"
                 data-context="workspace-inline">
          <summary>Удаление стенда</summary>
          <div class="sandbox-card__actions ui-workspace-section__body">
            <div class="sandbox-card__removal-option">
              <UiButton variant="outline" tone="danger" data-context="workspace-form-wrap"
                        :loading="busy" @click="emit('dismantle', { task: entry.task, force: false })">
                Снести стенд
              </UiButton>
              <p class="sandbox-card__hint">
                Удалить контейнеры и базы. Рабочие папки с незакоммиченными изменениями сохранятся.
              </p>
            </div>
            <div class="sandbox-card__removal-option">
              <UiButton variant="ghost" tone="danger" data-context="workspace-form-wrap" :aria-disabled="busy"
                        @click="emit('dismantle', { task: entry.task, force: true })">
                Снести вместе с изменениями
              </UiButton>
              <p class="sandbox-card__hint">
                Удалить и рабочие папки. Профиль предварительно сохранит изменения патчем в архив.
              </p>
            </div>
          </div>
        </details>
        <p v-else-if="blockedReason" class="sandbox-card__hint">{{ blockedReason }}</p>
      </div>
    </div>
  </article>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  UiActionLink,
  UiButton,
  UiDisclosureButton,
  UiIconButton,
  UiInlineMessage,
  UiProgress,
  UiPaneHeader,
  vTooltip,
} from '../../ui';
import { loadSandboxJobLog } from '../../actions/sandboxes';
import { sandboxUrl } from '../../shared/sandbox.ts';
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
    return 'Не проверен';
  }

  return aliveState.value === 'alive' ? 'Порты отвечают' : 'Порты не отвечают';
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

  return `Запись о стенде обновлена ${when}`;
});

// Причину запрета считает сервер: клиентская догадка по состоянию задания разошлась
// бы с настоящим отказом ручки, а правило владения живёт там же, где и снос.
const BLOCKED: Record<string, string> = {
  pipeline_owned: 'Стендом владеет конвейер или общий checkout: он сносится из карточки задачи.',
  job_running: 'Удаление недоступно, пока выполняется задание стенда.',
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
  min-width: 0;
  container: sandbox-card / inline-size;
}

.sandbox-card__body {
  display: grid;
  gap: 8px;
  min-width: 0;
  padding: 10px 12px;
}

.sandbox-card__body > * {
  min-width: 0;
}

.sandbox-card__alive {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--ink-mid);
}

.sandbox-card__alive[data-state='silent'] {
  color: var(--bad);
}

.sandbox-card__dot {
  width: 6px;
  height: 6px;
  flex: none;
  border-radius: 50%;
  background: var(--idle);
}

.sandbox-card__alive[data-state='alive'] .sandbox-card__dot {
  background: var(--good);
}

.sandbox-card__alive[data-state='silent'] .sandbox-card__dot {
  background: var(--bad);
}

.sandbox-card__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  color: var(--ink-mid);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.sandbox-card__progress {
  display: grid;
  gap: 6px;
}

.sandbox-card__step,
.sandbox-card__hint {
  margin: 0;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 18px;
  overflow-wrap: anywhere;
}

.sandbox-card__ports {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: center;
  width: 220px;
  max-width: 100%;
  gap: 8px;
}

.sandbox-card__port {
  font-family: var(--mono);
  font-size: 12px;
}

.sandbox-card__tools {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 0 24px;
}

.sandbox-card__tools > details[open],
.sandbox-card__tools > .sandbox-card__hint {
  flex-basis: 100%;
  min-width: 0;
}

.sandbox-card__repos {
  display: grid;
  margin: 0;
  padding: 0;
  list-style: none;
}

.sandbox-repo {
  display: grid;
  grid-template-columns: minmax(64px, 120px) minmax(90px, 220px) minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  border-top: 1px solid var(--line);
}

.sandbox-repo__name {
  min-width: 0;
  font-size: 12px;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.sandbox-repo__branch,
.sandbox-repo__path {
  min-width: 0;
  color: var(--ink-mid);
  font-family: var(--mono);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.sandbox-repo__branch {
  color: var(--node-code);
}

.sandbox-card__runs {
  display: grid;
  gap: 8px;
}

.sandbox-card__run,
.sandbox-card__removal-option {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  align-items: center;
  gap: 6px 12px;
}

.sandbox-card__result {
  white-space: pre-line;
  overflow-wrap: anywhere;
}

.sandbox-card__log {
  display: grid;
  justify-items: start;
  gap: 6px;
}

.sandbox-card__log-text {
  width: 100%;
  max-height: 320px;
  margin: 0;
  padding: 8px;
  overflow: auto;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--sidebar);
  color: var(--ink);
  font-family: var(--mono);
  font-size: 12px;
  line-height: 18px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

@container sandbox-card (max-width: 660px) {
  .sandbox-card__ports {
    width: 100%;
  }

  .sandbox-repo {
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 4px 8px;
  }

  .sandbox-repo__branch,
  .sandbox-repo__path {
    grid-column: 1;
  }

  .sandbox-repo > :last-child {
    grid-column: 2;
    grid-row: 1 / 4;
  }

  .sandbox-card__run,
  .sandbox-card__removal-option {
    grid-template-columns: minmax(0, 1fr);
  }
}

@container sandbox-card (max-width: 520px) {
  .sandbox-card__head :deep(.ui-pane-header__actions) {
    flex-basis: 100%;
  }

}
</style>
