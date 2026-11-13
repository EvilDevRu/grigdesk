<template>
  <section class="sandboxes ui-page ui-workspace" data-ui-workspace aria-labelledby="sandboxes-title">
    <UiPaneHeader class="sandboxes__header">
      <template #title><h1 id="sandboxes-title">{{ t('core.sandboxes') }}</h1></template>
      <template #meta><span v-if="store.loaded">{{ t('core.sandboxStendov') }} {{ rows.length }}</span></template>
      <template #actions>
        <UiIconButton :label="t('core.sandboxObnovitPesochnitsy')" v-tooltip="t('core.sandboxObnovitPesochnitsy')"
                      data-context="workspace-toolbar" :loading="store.loading" @click="loadSandboxes()">
          <UiRefreshIcon />
        </UiIconButton>
        <UiButton v-if="store.loaded" tone="accent" data-context="workspace-toolbar"
                  :aria-expanded="showCreate" aria-controls="sandboxes-create" @click="toggleCreate">
          {{ createOpen ? t('core.dbDesignHideForm') : t('core.sandboxPodnyatStend') }}
        </UiButton>
      </template>
    </UiPaneHeader>

    <UiInlineMessage v-if="store.error" class="sandboxes__error" tone="danger">
      {{ store.error }}
    </UiInlineMessage>
    <UiInlineMessage v-if="sandboxPipelineSnapshot.error" class="sandboxes__error" tone="warning"> {{ t('core.sandboxSvedeniyaKonveyeraUstareli') }} {{ sandboxPipelineSnapshot.error }}
    </UiInlineMessage>

    <div class="sandboxes__tabs">
      <UiTabs v-model="panel" size="compact" data-ui-workspace-tabs :label="t('core.sandboxOblastPesochnits')">
        <UiTab value="list" controls="sandboxes-list">{{ t('core.sandboxSpisok') }}</UiTab>
        <UiTab value="detail" controls="sandboxes-detail">{{ t('core.sandboxStend') }}</UiTab>
      </UiTabs>
    </div>

    <div class="sandboxes__panels" :data-panel="panel">
      <div id="sandboxes-list" class="sandboxes__catalog sandboxes__scroll">
        <div class="sandboxes__filters">
          <UiInput v-model="search" type="search" :aria-label="t('core.sandboxPoiskStenda')"
                   :placeholder="t('core.sandboxNazvanieNomerProfilIli')" />
          <UiSelect v-model="profile" :aria-label="t('core.sandboxProektStenda')">
            <option value="all">{{ t('core.sandboxVseProekty') }}{{ stateRows.length }})</option>
            <option v-for="option in profiles" :key="option.value" :value="option.value">
              {{ option.label }} ({{ option.count }})
            </option>
          </UiSelect>
          <UiSelect v-model="owner" :aria-label="t('core.sandboxKakieStendyPokazat')">
            <option v-for="state in states" :key="state.value" :value="state.value">
              {{ state.label }} ({{ state.count }})
            </option>
          </UiSelect>
          <UiButton v-if="filtered" variant="text" data-context="workspace-form" @click="resetFilters"> {{ t('settings.reset') }} </UiButton>
          <span v-if="filtered" class="sandboxes__note" role="status"> {{ t('core.sandboxNaydeno') }} {{ visibleCount }} {{ t('settings.from') }} {{ rows.length }}
          </span>
        </div>

        <UiLoadingState v-if="!store.loaded && !store.error" :label="t('core.sandboxChitaemSostoyaniePesochnits')" >
          <div class="sandboxes-loading"><UiSkeletonLayout layout="list" :header="true" /></div>
        </UiLoadingState>
        <p v-if="store.loaded && !store.error && !store.sandboxes.length" class="sandboxes__empty">
          <template v-if="awaitingStand">{{ t('core.sandboxPodgotovkaIdetTekuschiyShag') }}</template>
          <template v-else>{{ t('core.sandboxStendovPokaNetVyberite') }}</template>
        </p>
        <p v-if="rows.length && !visibleCount" class="sandboxes__empty"> {{ t('core.sandboxPodhodyaschihStendovNetIzmenite') }} </p>

        <div class="sandboxes__groups">
          <section v-for="group in groups" :key="group.profile" class="sandboxes__block">
            <div class="sandboxes__block-head">
              <h2>{{ group.label }}</h2>
              <span class="sandboxes__note">{{ group.rows.length }} {{ t('core.sandboxSloty') }} {{ group.slots.join(', ') || '—' }}</span>
            </div>
            <div class="sandboxes__list">
              <SandboxListRow v-for="row in group.rows" :key="row.task" :row="row"
                              :selected="row.task === selectedTask" @select="selectStand" />
            </div>
          </section>
        </div>

        <details v-if="store.orphanJobs.length" class="sandboxes__recent ui-workspace-disclosure"
                 data-context="workspace-inline">
          <summary>{{ t('core.sandboxNedavnieZadaniya') }}{{ store.orphanJobs.length }})</summary>
          <p class="sandboxes__note">{{ t('core.sandboxStendEscheNePoyavilsya') }}</p>
          <ul class="sandboxes__jobs">
            <li v-for="job in store.orphanJobs" :key="job.task">
              <strong>{{ 't' }}{{ job.task }}</strong>
              <span>{{ jobKind(job) }} · {{ jobState(job) }}</span>
              <span v-if="job.profile" class="sandboxes__note">{{ job.profile }}</span>
              <p v-if="job.state === 'running' && job.label" class="sandboxes__job-message">
                <template v-if="job.total">{{ job.index }}/{{ job.total }} · </template>{{ job.label }}
              </p>
              <p v-else-if="job.message" class="sandboxes__job-message">{{ job.message }}</p>
            </li>
          </ul>
        </details>
      </div>

      <div id="sandboxes-detail" class="sandboxes__detail sandboxes__scroll">
        <section v-show="showCreate" id="sandboxes-create" class="sandboxes__create"
                 aria-labelledby="sandboxes-raise-title">
          <UiPaneHeader>
            <template #title><h2 id="sandboxes-raise-title">{{ t('core.sandboxNovayaPesochnitsa') }}</h2></template>
          </UiPaneHeader>
          <div class="ui-workspace-section__body">
            <SandboxRaiseForm :options="store.capableProfiles" :range="store.manualRange"
                              :busy="raising" @raise="raise" />
          </div>
        </section>
        <div v-show="!showCreate" class="sandboxes__selection">
          <p v-if="outsideFilter" class="sandboxes__empty">{{ t('core.sandboxVybrannyyStendVneFiltra') }}</p>
          <SandboxCard v-if="selected?.entry" :key="selected.task" :entry="selected.entry"
                       :job="selected.job" :busy="store.isBusy(selected.task)"
                       :profiles="store.profiles"
                       :task-title="selected.title" :state-label="selected.stateLabel"
                       :state-detail="selected.detail" @dismantle="dismantle" @run="run" />
          <section v-else-if="selected" class="ui-workspace-section sandboxes__pending">
            <h3>{{ t('core.sandboxStendT') }}{{ selected.task }} · {{ selected.title }}</h3>
            <p>{{ t('core.sandboxPodgotovkaIdet') }}</p>
            <UiProgress v-if="selected.job" :label="t('core.sandboxPodemStendaTTask', { task: selected.task })"
                        :value="selected.job.index" :max="selected.job.total"
                        :indeterminate="!selected.job.total" :value-text="selected.step" />
            <p>{{ selected.step }}</p>
            <p v-if="selected.job?.message">{{ selected.job.message }}</p>
          </section>
          <aside v-else class="sandboxes__placeholder ui-workspace-guide"> {{ t('core.sandboxVyberiteStendVSpiske') }} </aside>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { UiSkeletonLayout, t, messageRef } from '../ui';

import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import {
  UiRefreshIcon, UiButton, UiIconButton, UiInlineMessage, UiInput, UiPaneHeader, UiProgress,
  UiSelect, UiTab, UiTabs, confirmDialog, promptDialog, vTooltip, UiLoadingState,
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
  SandboxActionDecl, SandboxJob,
} from '../../../shared/plugins/sandboxes/sandboxContracts';
import SandboxCard from './sandboxes/SandboxCard.vue';
import SandboxListRow from './sandboxes/SandboxListRow.vue';
import { sandboxPipelineSnapshot } from '../shared/sandboxPipelineSnapshot.ts';
import {
  NO_PROFILE, SANDBOX_STATES, sandboxGroups, sandboxMatches, sandboxProfileKey,
  sandboxRows, sandboxStateMatches,
} from '../shared/sandboxPresentation.ts';
import SandboxRaiseForm from './sandboxes/SandboxRaiseForm.vue';

const store = useSandboxesStore();
const raising = ref(false);
const createOpen = ref(false);
const search = ref('');
const owner = ref('all');
const profile = ref('all');
const selectedTask = ref<string | null>(null);
const panel = ref('list');
const now = ref(Date.now());
let clock: ReturnType<typeof setInterval> | undefined;
let firstOverview = false;
let requestedRaise: {
  profile: string;
  task: string | null;
  before: Set<string>;
} | null = null;

const showCreate = computed(() => store.loaded && createOpen.value);
const rows = computed(() => sandboxRows(
  store.sandboxes, store.jobs, sandboxPipelineSnapshot.value, now.value,
));
const searched = computed(() => rows.value.filter((row) => sandboxMatches(row, search.value)));
const stateRows = computed(() => searched.value.filter((row) => sandboxStateMatches(row, owner.value)));
const profileRows = computed(() => searched.value.filter((row) =>
  profile.value === 'all' || sandboxProfileKey(row) === profile.value));
const visibleRows = computed(() => stateRows.value.filter((row) =>
  profile.value === 'all' || sandboxProfileKey(row) === profile.value));
const groups = computed(() => sandboxGroups(visibleRows.value, rows.value));
const orderedRows = computed(() => groups.value.flatMap((group) => group.rows));
const selected = computed(() => rows.value.find((row) => row.task === selectedTask.value) || null);
const outsideFilter = computed(() => selected.value
  && !visibleRows.value.some((row) => row.task === selectedTask.value));
const visibleCount = computed(() => visibleRows.value.length);
const filtered = computed(() => Boolean(search.value.trim())
  || owner.value !== 'all' || profile.value !== 'all');
const awaitingStand = computed(() => rows.value.some((row) => !row.entry));
const profiles = computed(() => sandboxGroups(rows.value, rows.value).map((group) => ({
  value: group.profile,
  label: group.profile === NO_PROFILE ? t('core.sandboxBezProfilya') : group.profile,
  count: stateRows.value.filter((row) => sandboxProfileKey(row) === group.profile).length,
})));
const states = computed(() => SANDBOX_STATES.map((state) => ({
  ...state,
  count: profileRows.value.filter((row) => sandboxStateMatches(row, state.value)).length,
})));

function resetFilters() {
  search.value = '';
  owner.value = 'all';
  profile.value = 'all';
}

function selectStand(task: string) {
  selectedTask.value = task;
  createOpen.value = false;
  panel.value = 'detail';
}

function toggleCreate() {
  createOpen.value = !createOpen.value;
  panel.value = 'detail';
}

/**
 * Фоновая замена объектов не меняет выбранный номер, даже вне текущего фильтра.
 * Только исчезновение записи переводит подробности на первый доступный стенд.
 */
function reconcileSelection() {
  if (!rows.value.some((row) => row.task === selectedTask.value)) {
    selectedTask.value = orderedRows.value[0]?.task || null;
  }
}

/**
 * Явная смена фильтров выбирает подходящий стенд вместо скрытого.
 * Обновление состояния из конвейера само эту функцию не вызывает.
 */
function selectFilteredStand() {
  if (!visibleRows.value.some((row) => row.task === selectedTask.value)) {
    selectedTask.value = orderedRows.value[0]?.task || null;
  }
}

function jobKey(job: SandboxJob) {
  return [job.task, job.action, job.state, job.startedAt].join(':');
}

/**
 * Закрывает форму только после нового подъёма, который подтвердили в этом виде.
 * Чужие задания и отказ операции сохраняют открытый черновик и прежний выбор.
 */
function revealRequestedRaise() {
  const request = requestedRaise;

  if (!request) {
    return;
  }

  const job = store.jobs.find((item) => item.action === 'up' && item.state === 'running'
    && item.profile === request.profile && !request.before.has(jobKey(item))
    && (!request.task || item.task === request.task));

  if (!job) {
    return;
  }

  requestedRaise = null;
  createOpen.value = false;
  resetFilters();
  panel.value = 'list';
  void nextTick(() => {
    const row = document.querySelector(`[data-context="workspace-catalog-row"][data-task="${job.task}"]`);

    row?.scrollIntoView?.({ block: 'nearest' });
  });
}

watch(() => rows.value.map((row) => row.task).join(','), reconcileSelection, { immediate: true });
watch([search, owner, profile], selectFilteredStand);
watch(profiles, (options) => {
  if (profile.value !== 'all' && !options.some((option) => option.value === profile.value)) {
    profile.value = 'all';
  }
});
watch(() => [store.loaded, store.error], () => {
  if (store.loaded && !store.error && !firstOverview) {
    firstOverview = true;
    createOpen.value = !rows.value.length;

    if (createOpen.value) {
      panel.value = 'detail';
    }
  }
}, { immediate: true });
watch(() => store.jobs, revealRequestedRaise, { deep: true });

onMounted(() => {
  watchSandboxes();
  void loadSandboxes();
  now.value = Date.now();
  clock = setInterval(() => {
    now.value = Date.now();
  }, 60000);
});
onUnmounted(() => clearInterval(clock));

/**
 * Род задания словами: подъём, снос или прогон — подписью действия из манифеста
 * профиля, чтобы в списке недавних заданий было видно, ЧТО именно гоняли.
 */
function jobKind(job: SandboxJob) {
  if (job.action === 'run') {
    return job.actionLabel || t('core.coreProgon');
  }

  return job.action === 'up' ? t('core.corePodem') : t('core.coreSnos');
}

// Состояние задания словами: у стенда, которого уже нет в реестре, это единственное,
// что остаётся человеку от подъёма или сноса.
function jobState(job: SandboxJob) {
  if (job.state === 'running') {
    return t('settings.running');
  }

  return job.state === 'done' ? t('settings.remoteStepCompleted') : t('settings.error');
}

/**
 * Подъём подтверждается человеком: он занимает слот стенда и четверть часа, а
 * скрипт профиля создаёт контейнеры и схемы данных. Отказ показывает сам стор.
 */
async function raise(payload: { profile: string; task: string | null }) {
  const target = payload.task
                          ? t('core.coreZadachiTask', { task: payload.task })
                          : t('core.coreBezZadachiSluzhebnyyNomer');
  const accepted = await confirmDialog(
    messageRef('core.sandboxPodnyatPesochnitsuProfilyaProfile', { profile: payload.profile, target }),
    {
      title: t('core.sandboxPodemPesochnitsy'),
      okText: t('core.sandboxPodnyat'),
    },
  );

  if (!accepted) {
    return;
  }

  raising.value = true;
  requestedRaise = { ...payload, before: new Set(store.jobs.map(jobKey)) };

  try {
    await raiseSandbox(payload.profile, payload.task);
    revealRequestedRaise();
  } finally {
    requestedRaise = null;
    raising.value = false;
  }
}

/**
 * Снос необратим для инфраструктуры, поэтому спрашиваем всегда, а разницу двух
 * кнопок проговариваем прямо в вопросе: обычный снос оставляет незакоммиченное,
 * второй забирает worktree вместе с ним (профиль снимает патч в архив).
 */
async function dismantle(payload: {
  task: string;
  force: boolean;
  profile?: string;
}) {
  const profileNotice = payload.profile
    ? `${t('core.sandboxRemovalProfileConfirm', { profile: payload.profile })}\n\n`
    : '';
  const accepted = await confirmDialog(
    messageRef('core.sandboxSnestiStendTTask', {
      task: payload.task,
      profileNotice,
      value: payload.force
        ? t('core.sandboxWorktreeRemovedWithChanges')
        : t('core.sandboxContainersRemovedWorktreeKept'),
    }),
    {
      title: t('core.sandboxSnosStenda'),
      okText: t('core.sandboxSnesti'),
      danger: true,
    },
  );

  if (!accepted) {
    return;
  }

  await dismantleSandbox(payload.task, payload.force, payload.profile);
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
      title: t('core.sandboxLabelStendTTask', { label: action.label, task }),
      text: arg.hint ? t('core.sandboxLabelHint', { label: arg.label, hint: arg.hint }) : arg.label,
      placeholder: arg.type === 'number' ? t('core.sandboxTseloeChislo') : '',
      okText: t('core.sandboxDalshe'),
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
    messageRef('core.sandboxLabelNaStendeT', {
      label: action.label,
      task,
      description: action.confirm || action.description,
    }),
    {
      title: t('core.sandboxProgonNaStende'),
      okText: t('core.sandboxZapustit'),
    },
  );

  if (!accepted) {
    return;
  }

  await runSandboxAction(task, action.id, args);
}
</script>

<style scoped>
.sandboxes-loading { padding: 8px 12px; }

.sandboxes {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  container: sandboxes / inline-size;
  background: var(--surface);
}

.sandboxes__panels {
  display: grid;
  grid-template-columns: minmax(320px, 440px) minmax(0, 1fr);
  flex: 1;
  min-height: 0;
  min-width: 0;
}

.sandboxes__scroll {
  min-width: 0;
  min-height: 0;
  overflow: auto;
  scrollbar-gutter: stable;
}

.sandboxes__catalog {
  border-right: 1px solid var(--line);
}

.sandboxes__detail {
  padding: 12px;
}

.sandboxes__tabs {
  display: none;
  flex: none;
  padding: 0 12px;
  border-bottom: 1px solid var(--line);
}

.sandboxes__error {
  margin: 8px 12px;
}

.sandboxes__create {
  min-width: 0;
  border: 1px solid var(--line);
}

.sandboxes__filters {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: center;
  gap: 8px;
  padding: 12px;
}

.sandboxes__filters > :first-child,
.sandboxes__filters > .sandboxes__note {
  grid-column: 1 / -1;
}

.sandboxes__block-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  padding: 8px 12px;
}

.sandboxes__block-head h2 {
  min-width: 0;
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.sandboxes__note {
  margin: 0;
  color: var(--ink-mid);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.sandboxes__list {
  display: grid;
  gap: 2px;
  padding: 0 12px 8px;
}

.sandboxes__empty,
.sandboxes__placeholder,
.sandboxes__pending {
  margin: 0;
  padding: 12px;
  color: var(--ink-mid);
  font-size: 13px;
  overflow-wrap: anywhere;
}

.sandboxes__recent {
  margin: 8px 12px;
}

.sandboxes__jobs {
  margin: 0;
  padding: 0;
  list-style: none;
}

.sandboxes__jobs li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  padding: 8px 0;
  overflow-wrap: anywhere;
  border-top: 1px solid var(--line);
}

.sandboxes__job-message {
  flex-basis: 100%;
  min-width: 0;
  margin: 0;
  color: var(--ink-mid);
  font-size: 12px;
  white-space: pre-wrap;
}

@container sandboxes (max-width: 1000px) {
  .sandboxes__tabs {
    display: flex;
  }

  .sandboxes__panels {
    grid-template-columns: minmax(0, 1fr);
  }

  .sandboxes__panels[data-panel='list'] > .sandboxes__detail,
  .sandboxes__panels[data-panel='detail'] > .sandboxes__catalog {
    display: none;
  }

  .sandboxes__catalog {
    border-right: 0;
  }
}

@container sandboxes (max-width: 360px) {
  .sandboxes__filters {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
