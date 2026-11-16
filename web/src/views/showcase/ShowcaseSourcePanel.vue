<template>
  <div class="source" data-testid="showcase-source">
    <p class="source__intro"> {{ t('core.showcaseChtoModelProchitaetPri') }} {{ defaultText }}
    </p>

    <UiInlineMessage v-if="blocked" tone="warning"> {{ t('core.showcaseStendNedostupenVyborNelzya') }} </UiInlineMessage>

    <!-- Чужая правка выбора (другая вкладка) не затирает то, что человек уже набрал. -->
    <UiInlineMessage v-if="externalChange" tone="warning" data-role="source-external"> {{ t('core.showcaseSohranennyyVyborIzmenilsyaPoka') }} <UiButton variant="ghost" :disabled="locked" @click="resetDraft">{{ t('core.showcaseVernutSohranennyy') }}</UiButton>
    </UiInlineMessage>

    <div class="source__fields">
      <UiCheckbox
        :checked="taskShown"
        :disabled="locked || !options?.taskAvailable"
        data-testid="showcase-source-task"
        @update:checked="setTask"
      > {{ t('core.showcaseTekstZadachiIzPortala') }} </UiCheckbox>
      <UiCheckbox
        :checked="code"
        :disabled="locked"
        data-testid="showcase-source-code"
        @update:checked="setCode"
      > {{ t('core.showcasePokazyvatModeliKodIzmeneniy') }} </UiCheckbox>
      <p class="source__hint"> {{ t('core.showcaseBezKodaModelVidit') }} </p>
      <UiField :label="t('core.showcaseSvoimiSlovami')" :hint="t('core.showcaseChtoPokazatINa')">
        <UiTextarea
          :model-value="note"
          rows="3"
          :maxlength="noteMax"
          :disabled="locked"
          data-testid="showcase-source-note"
          @update:model-value="setNote"
        />
      </UiField>
    </div>

    <UiLoadingState v-if="loading && !options" :label="t('core.showcaseChitayuIstoriyuRepozitorievStenda')"
                    :failed="Boolean(error)">
      <div class="source-loading"><UiSkeletonLayout layout="list" :header="false" /></div>
    </UiLoadingState>
    <UiInlineMessage v-else-if="error" tone="warning">{{ error }}</UiInlineMessage>
    <p v-else-if="options && !options.repos.length" class="source__hint"> {{ t('core.showcaseUStendaNetRepozitoriev') }} </p>

    <!-- Коммиты — по линии ветки, свежие сверху. Слияние видно, но не выбирается: его
         патч смешивает чужую ветку с разрешением конфликтов. Выбор вне списка — ниже
         своими строками: скрытое, но читаемое разбором человек обязан видеть. -->
    <section
      v-for="repo in options?.repos ?? []"
      :key="`${repo.name}:${listVersion}`"
      class="source__repo"
      :aria-label="t('core.showcaseRepozitoriyName', { name: repo.name })"
    >
      <div class="source__repo-head">
        <strong>{{ repo.name }}</strong>
        <span class="source__meta">{{ repo.branch ? t('core.showcaseVetkaBranch', { branch: repo.branch }) : t('core.showcaseVetkaNeOpredelena') }}</span>
      </div>
      <UiInlineMessage v-if="repo.error" tone="warning">{{ repo.error }}</UiInlineMessage>
      <ul class="source__list">
        <li>
          <UiCheckbox
            :checked="selectionOf(repo.name).work"
            :disabled="locked || (!selectionOf(repo.name).work && repo.workFiles === 0)"
            :data-testid="`showcase-source-work-${repo.name}`"
            @update:checked="setWork(repo.name, $event)"
          > {{ t('core.showcaseNezakommichennyePravki') }} {{ repo.error ? t('core.showcaseNeUdalosProverit') : repo.workFiles ? t('core.showcaseFaylovWorkfiles', { workFiles: repo.workFiles }) : t('core.showcaseNet') }}
          </UiCheckbox>
        </li>
        <li v-for="commit in repo.commits" :key="commit.id">
          <UiCheckbox
            :checked="selectionOf(repo.name).commits.includes(commit.id)"
            :disabled="locked || commit.merge"
            :data-testid="`showcase-source-commit-${commit.id.slice(0, 7)}`"
            @update:checked="setCommit(repo.name, commit.id, $event)"
          >
            <span class="source__commit"><code>{{ commit.id.slice(0, 7) }}</code> {{ commit.subject }}</span>
          </UiCheckbox>
          <span class="source__meta">{{ commitMeta(commit) }}</span>
        </li>
        <li v-for="row in outsideRows(repo.name)" :key="row.id">
          <UiCheckbox
            :checked="selectionOf(repo.name).commits.includes(row.id)"
            :disabled="outsideDisabled(repo.name, row)"
            :data-testid="`showcase-source-outside-${row.id.slice(0, 7)}`"
            @update:checked="setCommit(repo.name, row.id, $event)"
          >
            <span class="source__commit">
              <code>{{ row.id.slice(0, 7) }}</code> {{ row.subject ?? t('core.showcaseOpisanieNedostupno') }}
            </span>
          </UiCheckbox>
          <span class="source__meta">{{ OUTSIDE_TEXT[row.state] }}</span>
        </li>
      </ul>
    </section>

    <section
      v-for="name in missingRepos"
      :key="`missing:${name}`"
      class="source__repo"
      data-role="source-missing"
      :aria-label="t('core.showcaseRepozitoriyName', { name })"
    >
      <div class="source__repo-head">
        <strong>{{ name }}</strong>
        <span class="source__meta">{{ t('core.showcaseBolsheNeUStenda') }}</span>
      </div>
      <p class="source__hint"> {{ t('core.showcaseRepozitoriyOstalsyaVSohranennom') }} </p>
      <UiButton
        variant="ghost"
        :disabled="locked"
        :data-testid="`showcase-source-drop-${name}`"
        @click="dropRepo(name)"
      > {{ t('core.showcaseUbratIzVybora') }} </UiButton>
    </section>

    <div class="source__actions">
      <UiButton variant="ghost" :loading="loading" :disabled="locked" @click="emit('reload')"> {{ t('core.browserRefreshOwners') }} </UiButton>
      <UiButton variant="ghost" :disabled="locked || repos === null" @click="resetRepos"> {{ t('core.showcaseKommityPoUmolchaniyu') }} </UiButton>
      <UiButton variant="ghost" :disabled="locked || !options?.repos.length" @click="clearRepos"> {{ t('core.showcaseSnyatVse') }} </UiButton>
      <UiButton
        variant="solid"
        tone="accent"
        :loading="busy"
        :disabled="locked || !options || blocked"
        data-testid="showcase-source-apply"
        @click="apply"
      >
        {{ applyLabel }}
      </UiButton>
    </div>
    <p class="source__hint"> {{ t('core.showcaseKommityPoUmolchaniyuVozvraschaet') }} </p>
  </div>
</template>

<script setup lang="ts">
import { UiSkeletonLayout, t, messageRef, uiLocale } from '../../ui';

import { computed, ref, watch } from 'vue';

import {
  confirmDialog,
  UiButton,
  UiCheckbox,
  UiField,
  UiInlineMessage,
  UiTextarea,
  UiLoadingState,
} from '../../ui';
import {
  normalizeShowcaseSource,
  SHOWCASE_SOURCE_NOTE_MAX,
  showcaseSourceEqual,
} from '../../../../shared/plugins/showcase/showcaseContracts';
import type {
  ShowcaseProject,
  ShowcaseSourceCommit,
  ShowcaseSourceOptions,
  ShowcaseSourceOutsideCommit,
  ShowcaseStorySource,
  ShowcaseStorySourceRepo,
} from '../../../../shared/plugins/showcase/showcaseContracts';

const props = defineProps<{
  project: Pick<ShowcaseProject, 'id' | 'ref' | 'target' | 'scenes' | 'source'>;
  // Список из живой истории стенда; null — ещё не прочитан или не прочитался.
  options: ShowcaseSourceOptions | null;
  loading: boolean;
  error: string;
  busy: boolean;
}>();

const emit = defineEmits<{
  // null — выбор по умолчанию цели: ролик и дальше следует за её веткой.
  apply: [source: ShowcaseStorySource | null];
  reload: [];
}>();

// Строка выбора вне видимого списка: сохранённое глубже 50, выпавшее из истории или
// отмеченное в черновике коммита, которого больше нет в обновлённом списке.
type OutsideRow = Omit<ShowcaseSourceOutsideCommit, 'state'> & {
  state: ShowcaseSourceOutsideCommit['state'] | 'local';
};

const OUTSIDE_TEXT: Record<OutsideRow['state'], string> = {
  get available() {
    return t('core.showcaseGlubzhePokazannogoSpiska');
  },
  get outdated() {
    return t('core.showcasePropalIzIstoriiSnimite');
  },
  get unavailable() {
    return t('core.showcaseIstoriyaRepozitoriyaNeChitaetsya');
  },
  get local() {
    return t('core.showcaseVneSpiskaBudetProveren');
  },
};

const NARROWING_TEXT = messageRef('core.showcaseUmolchanieChitaetVsyuVetku');

// Черновик. Задача — null, пока человек её не трогал: тогда она следует умолчанию списка,
// который может прийти позже введённого текста.
const task = ref<boolean | null>(null);
const note = ref('');
const code = ref(true);
// null — коммиты по умолчанию цели; список — выбор человека по репозиториям.
const repos = ref<ShowcaseStorySourceRepo[] | null>(null);
const touched = ref(false);
const externalChange = ref(false);
const confirmingRepos = ref(false);
// Пересоздаёт строки галочек, когда отказ от сужения должен вернуть их к умолчанию.
const listVersion = ref(0);
// Что ушло на применение: его возврат с сервера — своё сохранение, а не чужая правка.
let lastApplied: ShowcaseStorySource | null | undefined;

const blocked = computed(() => props.project.target.status !== 'ready');
const locked = computed(() => props.busy || confirmingRepos.value);

const defaultText = computed(() => (
  props.project.ref.kind === 'project'
    ? t('core.showcaseIzmeneniyaNeChitayutsyaOtmette')
    : t('core.showcaseVsyaVetkaOtGlavnoy')
));

const applyLabel = computed(() => (
  props.project.scenes.length ? t('core.showcaseRazobratPoEtomuVyboru') : t('core.showcaseSnyatRolik')
));

const noteMax = computed(() => props.options?.noteMax ?? SHOWCASE_SOURCE_NOTE_MAX);

const taskShown = computed(() => task.value ?? props.options?.defaults.task ?? true);

// Репозитории явного выбора, которых у стенда больше нет: их видно и можно убрать.
const missingRepos = computed(() => {
  if (!props.options || repos.value === null) {
    return [];
  }

  const listed = new Set(props.options.repos.map((repo) => repo.name));

  return repos.value.filter((repo) => !listed.has(repo.name)).map((repo) => repo.name);
});

/**
 * Черновик из сохранённого выбора ролика, а без него — умолчание цели. Вызывается при
 * смене ролика, при новом сохранённом выборе и по кнопке «Вернуть сохранённый».
 */
function resetDraft(): void {
  const saved = props.project.source;

  task.value = saved ? saved.task : null;
  note.value = saved?.note ?? '';
  code.value = saved?.code ?? true;
  repos.value = saved?.repos
    ? saved.repos.map((repo) => ({ ...repo, commits: [...repo.commits] }))
    : null;
  touched.value = false;
  externalChange.value = false;
  lastApplied = undefined;
  listVersion.value += 1;
}

watch(() => props.project.id, resetDraft, { immediate: true });

// Новый сохранённый выбор принимается, если черновик не тронут или это вернулось своё
// применение. Иначе черновик остаётся у человека, а блок говорит о чужой правке.
watch(() => JSON.stringify(normalizeShowcaseSource(props.project.source)), () => {
  const own = lastApplied !== undefined && showcaseSourceEqual(props.project.source, lastApplied);

  if (!touched.value || own) {
    resetDraft();

    return;
  }

  externalChange.value = true;
});

function setTask(value: boolean): void {
  task.value = value;
  touched.value = true;
}

function setCode(value: boolean): void {
  code.value = value;
  touched.value = true;
}

function setNote(value: string | null): void {
  note.value = value ?? '';
  touched.value = true;
}

/**
 * Что отмечено в репозитории сейчас: выбор человека или видимое умолчание цели.
 * Репозиторий, которого нет в явном выборе, в разборе не участвует.
 */
function selectionOf(name: string): ShowcaseStorySourceRepo {
  const list = repos.value ?? props.options?.defaults.repos ?? [];

  return list.find((repo) => repo.name === name) ?? {
    name,
    work: false,
    commits: [],
  };
}

function outsideDisabled(name: string, row: OutsideRow): boolean {
  return locked.value || (row.state !== 'available' && !selectionOf(name).commits.includes(row.id));
}

/**
 * Явный выбор из того, что видно на экране, вместе с репозиториями выбора, которых у
 * стенда уже нет: первая же галочка превращает умолчание в отметки без потерь.
 */
function explicitRepos(): ShowcaseStorySourceRepo[] {
  const listed = (props.options?.repos ?? []).map((repo) => {
    const current = selectionOf(repo.name);

    return {
      name: repo.name,
      work: current.work,
      commits: [...current.commits],
    };
  });
  const gone = (repos.value ?? [])
    .filter((repo) => !listed.some((item) => item.name === repo.name))
    .map((repo) => ({ ...repo, commits: [...repo.commits] }));

  return [...listed, ...gone];
}

/**
 * Правка галочек репозиториев. Первая правка переводит умолчание в явные отметки; если
 * умолчание читает больше видимого, человек подтверждает сужение, а отказ оставляет
 * умолчание и возвращает галочки на место.
 */
async function changeRepos(update: (list: ShowcaseStorySourceRepo[]) => ShowcaseStorySourceRepo[]) {
  if (locked.value) {
    return;
  }

  const id = props.project.id;
  const version = listVersion.value;
  const list = explicitRepos();

  if (repos.value === null && props.options?.requiresExplicitSelectionConfirmation) {
    let accepted = false;

    confirmingRepos.value = true;

    try {
      accepted = await confirmDialog(NARROWING_TEXT, {
        title: t('core.showcaseSuzitVybor'),
        okText: t('core.showcaseOtmetit'),
      });
    } finally {
      confirmingRepos.value = false;
    }

    // Вопрос относится к показанному черновику; смена ролика или сохранённого выбора
    // за время ответа не даёт перенести прежний клик в новый черновик.
    if (!accepted || props.project.id !== id || listVersion.value !== version || props.busy) {
      listVersion.value += 1;

      return;
    }
  }

  repos.value = update(list);
  touched.value = true;
}

function setWork(name: string, value: boolean): void {
  void changeRepos((list) => list.map((repo) => (repo.name === name ? { ...repo, work: value } : repo)));
}

/**
 * Отметка коммита. Порядок отметок смысла не несёт: куски сервер собирает по линии
 * ветки, а сравнение выбора не зависит от порядка кликов.
 */
function setCommit(name: string, id: string, value: boolean): void {
  void changeRepos((list) => list.map((repo) => {
    if (repo.name !== name) {
      return repo;
    }

    const commits = repo.commits.filter((commit) => commit !== id);

    return { ...repo, commits: value ? [...commits, id] : commits };
  }));
}

function clearRepos(): void {
  void changeRepos((list) => list.map((repo) => ({
    name: repo.name,
    work: false,
    commits: [],
  })));
}

function dropRepo(name: string): void {
  void changeRepos((list) => list.filter((repo) => repo.name !== name));
}

function resetRepos(): void {
  repos.value = null;
  touched.value = true;
  listVersion.value += 1;
}

/**
 * Строки вне видимого списка для репозитория: сохранённое, о котором сообщил сервер, и
 * отметки черновика, которых нет ни в списке, ни в сообщении сервера.
 */
function outsideRows(name: string): OutsideRow[] {
  const repo = props.options?.repos.find((item) => item.name === name);
  const shown = new Set(repo?.commits.map((commit) => commit.id) ?? []);
  const reported: OutsideRow[] = props.options?.selectedOutsideCatalog
    .find((group) => group.name === name && !group.missing)?.commits ?? [];
  const known = new Set(reported.map((row) => row.id));
  const local: OutsideRow[] = selectionOf(name).commits
    .filter((id) => !shown.has(id) && !known.has(id))
    .map((id) => ({
      id,
      subject: null,
      state: 'local' as const,
    }));

  return [...reported, ...local];
}

/**
 * Вторая строка коммита: дата, своя ли это ветка и почему слияние не выбирается.
 * Дата нужна, чтобы отличить вчерашнюю работу от прошлонедельной.
 */
function commitMeta(commit: ShowcaseSourceCommit): string {
  const date = new Date(commit.date);
  const day = Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleDateString(uiLocale.value, { day: '2-digit', month: '2-digit' });

  return [day, commit.own
  ? t('core.showcaseSvoyaVetka')
  : '', commit.merge
    ? t('core.showcaseSliyanieNeVybiraetsya')
    : '']
    .filter(Boolean)
    .join(' · ');
}

/**
 * Выбор уходит целиком. Умолчание отправляется как null: так ролик и дальше следует за
 * веткой, и новые коммиты попадут в разбор без повторного выбора. Репозитории без единой
 * отметки в выборе не участвуют и не отправляются.
 */
function apply(): void {
  const chosen = repos.value === null
    ? null
    : repos.value.filter((repo) => repo.work || repo.commits.length > 0);
  const draft: ShowcaseStorySource = {
    task: taskShown.value,
    note: note.value.trim(),
    code: code.value,
    repos: chosen,
  };
  const defaultTask = props.options?.defaults.task ?? true;
  const isDefault = draft.task === defaultTask && !draft.note && draft.code && draft.repos === null;

  lastApplied = isDefault ? null : draft;
  emit('apply', lastApplied);
}
</script>

<style scoped>
.source-loading {
  --skeleton-row-height: 20px;
  --skeleton-copy-gap: 4px;
  --skeleton-avatar-display: none; padding: 10px 12px; border: 1px solid var(--line); border-radius: 11px; }

.source {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

.source__intro,
.source__hint {
  margin: 0;
  color: var(--ink-mid);
  font-size: 12.5px;
  line-height: 1.5;
}

.source__fields {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.source__repo {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 11px;
}

.source__repo-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
}

.source__list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 320px;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}

.source__list li {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}

.source__commit {
  min-width: 0;
  overflow-wrap: anywhere;
}

.source__commit code {
  margin-right: 4px;
  color: var(--ink-mid);
  font-size: 11.5px;
}

.source__meta {
  flex: none;
  color: var(--ink-mid);
  font-size: 11.5px;
  white-space: nowrap;
}

.source__actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  flex-wrap: wrap;
}
</style>
