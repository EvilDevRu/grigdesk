<template>
  <section class="sandboxes ui-page ui-workspace" data-ui-workspace aria-labelledby="sandboxes-title">
    <UiPaneHeader class="sandboxes__header">
      <template #title><h1 id="sandboxes-title">Песочницы</h1></template>
      <template #meta><span v-if="store.loaded">Стендов: {{ store.sandboxes.length }}</span></template>
      <template #actions>
        <UiButton v-if="store.loaded && store.sandboxes.length" tone="accent"
                  data-context="workspace-toolbar" :aria-expanded="showCreate"
                  aria-controls="sandboxes-create" @click="createOpen = !createOpen">
          {{ createOpen ? 'Скрыть форму' : '+ Поднять стенд' }}
        </UiButton>
        <UiIconButton label="Обновить песочницы" v-tooltip="'Обновить песочницы'"
                      data-context="workspace-toolbar" :loading="store.loading" @click="loadSandboxes()">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
               stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M20 7v5h-5M4 17v-5h5M6.1 6.1A8 8 0 0 1 20 12M4 12a8 8 0 0 0 13.9 5.9" />
          </svg>
        </UiIconButton>
      </template>
    </UiPaneHeader>

    <div class="sandboxes__scroll">
      <div class="sandboxes__content">
        <aside class="sandboxes__guide ui-workspace-guide">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
            <circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7v1" />
          </svg>
          <div><strong>Стенды для проверки изменений.</strong>
            Поднимите песочницу и откройте её сайт или рабочие папки.
          </div>
        </aside>

        <UiInlineMessage v-if="store.error" class="sandboxes__error" tone="danger">
          {{ store.error }}
        </UiInlineMessage>
        <p v-if="!store.loaded && !store.error" class="sandboxes__empty" role="status">
          Читаем состояние песочниц…
        </p>

        <section v-show="showCreate" id="sandboxes-create" class="sandboxes__create"
                 aria-labelledby="sandboxes-raise-title">
          <UiPaneHeader>
            <template #title><h2 id="sandboxes-raise-title">Новая песочница</h2></template>
          </UiPaneHeader>
          <div class="ui-workspace-section__body">
            <SandboxRaiseForm :options="store.capableProfiles" :range="store.manualRange"
                              :busy="raising" @raise="raise" />
          </div>
        </section>

        <div v-if="store.sandboxes.length" class="sandboxes__filters"
             :class="{ 'is-filtered': filtered, 'is-after-create': showCreate }">
          <UiInput v-model="search" type="search" aria-label="Поиск стенда"
                   placeholder="Номер, профиль или ветка" />
          <UiSelect v-model="owner" aria-label="Какие стенды показать">
            <option value="all">Все стенды</option>
            <option value="manual">Ручные стенды</option>
            <option value="pipeline">Стенды конвейера</option>
          </UiSelect>
          <UiButton v-if="filtered" variant="text" data-context="workspace-form" @click="resetFilters">
            Сбросить
          </UiButton>
          <span v-if="filtered" class="sandboxes__note" role="status">
            Найдено: {{ visibleCount }} из {{ store.sandboxes.length }}
          </span>
        </div>
        <p v-if="store.loaded && !store.error && !store.sandboxes.length" class="sandboxes__empty">
          <template v-if="awaitingStand">
            Подготовка идёт. Стенд появится здесь; текущий шаг — в недавних заданиях.
          </template>
          <template v-else>Стендов пока нет. Выберите профиль выше и поднимите первую песочницу.</template>
        </p>
        <p v-else-if="store.sandboxes.length && !visibleCount" class="sandboxes__empty">
          Подходящих стендов нет. Измените запрос или сбросьте фильтры.
        </p>

        <section v-if="manualEntries.length" class="sandboxes__block" aria-labelledby="sandboxes-manual-title">
          <div class="sandboxes__block-head">
            <h2 id="sandboxes-manual-title">Ручные стенды</h2>
            <span class="sandboxes__count">{{ manualEntries.length }}</span>
          </div>
          <div class="sandboxes__list">
            <SandboxCard v-for="entry in manualEntries" :key="entry.task" :entry="entry"
                         :job="store.jobOf(entry.task)" :busy="store.isBusy(entry.task)"
                         @dismantle="dismantle" @run="run" />
          </div>
        </section>

        <section v-if="store.orphanJobs.length" class="sandboxes__block" aria-labelledby="sandboxes-jobs-title">
          <div class="sandboxes__block-head">
            <h2 id="sandboxes-jobs-title">Недавние задания</h2>
            <span class="sandboxes__count">{{ store.orphanJobs.length }}</span>
          </div>
          <p class="sandboxes__note">
            Стенд ещё не появился в списке или уже удалён. Здесь остаются ход работы и результат.
          </p>
          <ul class="sandboxes__jobs">
            <li v-for="job in store.orphanJobs" :key="job.task">
              <span class="sandboxes__job-dot" :data-state="job.state" aria-hidden="true"></span>
              <strong>t{{ job.task }}</strong>
              <span>{{ jobKind(job) }} · {{ jobState(job) }}</span>
              <span v-if="job.profile" class="sandboxes__note">{{ job.profile }}</span>
              <p v-if="job.state === 'running' && job.label" class="sandboxes__job-message">
                <template v-if="job.total">{{ job.index }}/{{ job.total }} · </template>{{ job.label }}
              </p>
              <p v-else-if="job.message" class="sandboxes__job-message">{{ job.message }}</p>
            </li>
          </ul>
        </section>

        <section v-if="pipelineEntries.length" class="sandboxes__block"
                 aria-labelledby="sandboxes-pipeline-title">
          <div class="sandboxes__block-head">
            <h2 id="sandboxes-pipeline-title">Стенды конвейера</h2>
            <span class="sandboxes__count">{{ pipelineEntries.length }}</span>
          </div>
          <p class="sandboxes__note">
            Проверки доступны здесь, снос — в карточке задачи.
          </p>
          <div class="sandboxes__list">
            <SandboxCard v-for="entry in pipelineEntries" :key="entry.task" :entry="entry"
                         :job="store.jobOf(entry.task)" :busy="store.isBusy(entry.task)"
                         @dismantle="dismantle" @run="run" />
          </div>
        </section>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  UiButton, UiIconButton, UiInlineMessage, UiInput, UiPaneHeader, UiSelect,
  confirmDialog, promptDialog, vTooltip,
} from '../ui';
import {
  dismantleSandbox,
  loadSandboxes,
  raiseSandbox,
  runSandboxAction,
  useSandboxesStore,
  watchSandboxes,
} from '../actions/sandboxes';
import type {
  SandboxActionDecl, SandboxEntry, SandboxJob,
} from '../../../shared/plugins/sandboxes/sandboxContracts';
import SandboxCard from './sandboxes/SandboxCard.vue';
import SandboxRaiseForm from './sandboxes/SandboxRaiseForm.vue';

const store = useSandboxesStore();
const raising = ref(false);
const createOpen = ref(false);
const search = ref('');
const owner = ref('all');

const showCreate = computed(() => store.loaded && (createOpen.value
  || (!store.sandboxes.length && !store.error)));
const manualEntries = computed(() => store.manualSandboxes.filter(matches));
const pipelineEntries = computed(() => store.pipelineSandboxes.filter(matches));
const visibleCount = computed(() => manualEntries.value.length + pipelineEntries.value.length);
const filtered = computed(() => Boolean(search.value.trim()) || owner.value !== 'all');
const awaitingStand = computed(() => store.orphanJobs.some((job) =>
  job.action === 'up' && job.state === 'running'));

/**
 * Поиск ограничивает только список стендов: недавние задания остаются видны,
 * чтобы ошибка подъёма или текущая работа не исчезли из-за фильтра владельца.
 */
function matches(entry: SandboxEntry): boolean {
  if (owner.value !== 'all' && entry.owner !== owner.value) {
    return false;
  }

  const text = [entry.task, `t${entry.task}`, entry.profile,
    ...entry.repos.flatMap((repo) => [repo.name, repo.branch, repo.path])].join(' ').toLowerCase();

  return text.includes(search.value.trim().toLowerCase());
}

function resetFilters() {
  search.value = '';
  owner.value = 'all';
}

onMounted(() => {
  watchSandboxes();
  void loadSandboxes();
});

/**
 * Род задания словами: подъём, снос или прогон — подписью действия из манифеста
 * профиля, чтобы в списке недавних заданий было видно, ЧТО именно гоняли.
 */
function jobKind(job: SandboxJob) {
  if (job.action === 'run') {
    return job.actionLabel || 'прогон';
  }

  return job.action === 'up' ? 'подъём' : 'снос';
}

// Состояние задания словами: у стенда, которого уже нет в реестре, это единственное,
// что остаётся человеку от подъёма или сноса.
function jobState(job: SandboxJob) {
  if (job.state === 'running') {
    return 'выполняется';
  }

  return job.state === 'done' ? 'выполнено' : 'ошибка';
}

/**
 * Подъём подтверждается человеком: он занимает слот стенда и четверть часа, а
 * скрипт профиля создаёт контейнеры и схемы данных. Отказ показывает сам стор.
 */
async function raise(payload: { profile: string; task: string | null }) {
  const target = payload.task ? `задачи ${payload.task}` : 'без задачи (служебный номер)';
  const accepted = await confirmDialog(
    `Поднять песочницу профиля «${payload.profile}» ${target}?\n\n`
      + 'Скрипт профиля создаст worktree, контейнеры и свои схемы данных. '
      + 'Обычно это 12–15 минут и один занятый слот стенда.',
    {
      title: 'Подъём песочницы',
      okText: 'Поднять',
    },
  );

  if (!accepted) {
    return;
  }

  raising.value = true;

  try {
    await raiseSandbox(payload.profile, payload.task);
  } finally {
    raising.value = false;
  }
}

/**
 * Снос необратим для инфраструктуры, поэтому спрашиваем всегда, а разницу двух
 * кнопок проговариваем прямо в вопросе: обычный снос оставляет незакоммиченное,
 * второй забирает worktree вместе с ним (профиль снимает патч в архив).
 */
async function dismantle(payload: { task: string; force: boolean }) {
  const accepted = await confirmDialog(
    `Снести стенд t${payload.task}?\n\n`
      + (payload.force
        ? 'Worktree будет удалён вместе с незакоммиченными изменениями — профиль сохранит их патчем в архив.'
        : 'Контейнеры и схемы данных будут удалены. Незакоммиченное в worktree сохраняется: '
          + 'скрипт профиля оставит каталог и предупредит об этом.'),
    {
      title: 'Снос стенда',
      okText: 'Снести',
      danger: true,
    },
  );

  if (!accepted) {
    return;
  }

  await dismantleSandbox(payload.task, payload.force);
}

/**
 * Прогон профиля: аргументы спрашиваются по одному в порядке объявления, а сам
 * запуск подтверждается словами профиля — он гоняет стенд по-настоящему (очереди,
 * лимиты, публикация), и что именно произойдёт, знает только его описание.
 */
async function run(payload: { task: string; action: SandboxActionDecl }) {
  const { task, action } = payload;
  const args: Record<string, string> = {};

  for (const arg of action.args) {
    const answer = await promptDialog({
      title: `${action.label} — стенд t${task}`,
      text: arg.hint ? `${arg.label}. ${arg.hint}` : arg.label,
      placeholder: arg.type === 'number' ? 'целое число' : '',
      okText: 'Дальше',
    });

    if (answer === null) {
      return;
    }

    if (!answer.trim() && arg.required) {
      return;
    }

    args[arg.key] = answer.trim();
  }

  const accepted = await confirmDialog(
    `${action.label} на стенде t${task}?\n\n${action.confirm || action.description}`,
    {
      title: 'Прогон на стенде',
      okText: 'Запустить',
    },
  );

  if (!accepted) {
    return;
  }

  await runSandboxAction(task, action.id, args);
}
</script>

<style scoped>
.sandboxes {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  container: sandboxes / inline-size;
  background: var(--surface);
}

.sandboxes__scroll {
  display: flex;
  flex-direction: column;
  gap: 0;
  min-height: 0;
  overflow: auto;
  scrollbar-gutter: stable;
}

.sandboxes__guide,
.sandboxes__error {
  margin: 12px;
}

.sandboxes__create {
  border-block: 1px solid var(--line);
}

.sandboxes__content {
  flex: none;
  min-width: 0;
  width: 100%;
}

.sandboxes__content > * {
  min-width: 0;
}

.sandboxes__filters {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 200px;
  align-items: center;
  gap: 8px;
  padding: 0 12px 12px;
}

.sandboxes__filters.is-filtered {
  grid-template-columns: minmax(0, 1fr) 200px auto;
}

.sandboxes__filters.is-after-create {
  padding-top: 12px;
}

.sandboxes__filters > .sandboxes__note {
  grid-column: 1 / -1;
}

.sandboxes__block {
  display: grid;
  gap: 0;
}

.sandboxes__block-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
}

.sandboxes__block > .sandboxes__note {
  padding: 0 12px 8px;
}

.sandboxes__block-head h2 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}

.sandboxes__count,
.sandboxes__note {
  margin: 0;
  color: var(--ink-mid);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.sandboxes__count {
  font-variant-numeric: tabular-nums;
}

.sandboxes__list {
  display: grid;
  gap: 12px;
  padding: 0 12px 12px;
}

.sandboxes__empty {
  margin: 0;
  padding: 12px;
  color: var(--ink-mid);
  font-size: 13px;
  overflow-wrap: anywhere;
}

.sandboxes__jobs {
  margin: 0;
  padding: 0;
  list-style: none;
  border-block: 1px solid var(--line);
}

.sandboxes__jobs li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  padding: 8px 12px;
  overflow-wrap: anywhere;
}

.sandboxes__jobs li + li {
  border-top: 1px solid var(--line);
}

.sandboxes__job-dot {
  width: 6px;
  height: 6px;
  flex: none;
  border-radius: 50%;
  background: var(--accent);
}

.sandboxes__job-dot[data-state='done'] {
  background: var(--good);
}

.sandboxes__job-dot[data-state='failed'] {
  background: var(--bad);
}

.sandboxes__job-message {
  flex-basis: 100%;
  min-width: 0;
  margin: 0 0 0 14px;
  color: var(--ink-mid);
  font-size: 12px;
  white-space: pre-wrap;
}

@container sandboxes (max-width: 660px) {
  .sandboxes__filters,
  .sandboxes__filters.is-filtered {
    grid-template-columns: minmax(0, 1fr) auto;
  }

  .sandboxes__filters > :first-child {
    grid-column: 1 / -1;
  }

  .sandboxes__filters:not(.is-filtered) > :nth-child(2) {
    grid-column: 1 / -1;
  }
}

@container sandboxes (max-width: 360px) {
  .sandboxes__header :deep(.ui-pane-header__actions) {
    flex-basis: 100%;
  }
}
</style>
