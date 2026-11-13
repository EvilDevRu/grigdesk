<template>
  <div class="rows">
    <header class="repo-heading">
      <h3>{{ t('core.projectRepozitorii') }} <span class="repo-count">{{ draft.repos.length }}</span></h3>
      <UiButton
        data-role="project-repo-add"
        :aria-label="t('core.projectDobavitRepozitoriy')"
        variant="ghost"
        tone="accent"
        data-context="workspace-toolbar"
        :disabled="readonly"
        @click="add"
      >
        <template #leading>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </template> {{ t('core.add') }} </UiButton>
    </header>
    <div class="repo-columns" aria-hidden="true"><span>{{ t('core.projectMetka') }}</span><span>{{ t('core.projectPutKRabocheyKopii') }}</span></div>
    <div
      v-for="(repo, index) in draft.repos"
      :key="index"
      class="row"
      data-role="project-repo-row"
      :data-repo-key="repo.key"
    >
      <UiField
        class="key"
        :label="t('core.projectMetka')"
        data-context="workspace-repo"
        :data-label-repeat="index > 0"
        :error="errorOf(`repos.${index}.key`)"
      >
        <UiInput
          :ref="(element) => setKeyRef(index, element)"
          :model-value="repo.key"
          data-role="project-repo-key"
          :disabled="readonly"
          :placeholder="'service'"
          @update:model-value="rename(index, $event)"
        />
      </UiField>

      <UiField
        class="dir"
        :label="t('core.projectPutKRabocheyKopii')"
        data-context="workspace-repo"
        :data-label-repeat="index > 0"
        :error="errorOf(`repos.${index}.dir`)"
      >
        <UiInput
          :ref="(element) => setDirRef(index, element)"
          :model-value="repo.dir"
          data-role="project-repo-dir"
          data-context="workspace-path"
          :disabled="readonly"
          v-tooltip="repo.dir"
          :placeholder="'/srv/project/service'"
          @update:model-value="setDir(index, $event)"
          @blur="emit('check', [repo.dir])"
        />
      </UiField>

      <div class="repo-meta">
        <UiRadio
          :model-value="draft.defaultRepoKey"
          :value="repo.key"
          :name="defaultGroup"
          :disabled="readonly || !repo.key"
          data-role="project-repo-default"
          :data-repo-key="repo.key"
          @update:model-value="setDefault(index)"
        > {{ t('core.projectOsnovnoy') }} </UiRadio>
      </div>
      <span v-if="stateText(repo.dir)" class="state" :data-state="stateOf(repo.dir)" role="status">
        {{ stateText(repo.dir) }}
      </span>

      <span class="acts">
        <UiButton
          data-role="project-repo-up"
          data-context="project-repo-action"
          variant="ghost"
          :aria-label="t('core.projectPeremestitKeyVyshe', { key: repo.key || t('core.repositoryWord') })"
          v-tooltip="t('core.projectPeremestitVyshe')"
          :disabled="readonly || index === 0"
          @click="move(index, -1)"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
            <path d="m6 14 6-6 6 6" />
          </svg>
        </UiButton>
        <UiButton
          data-role="project-repo-down"
          data-context="project-repo-action"
          variant="ghost"
          :aria-label="t('core.projectPeremestitKeyNizhe', { key: repo.key || t('core.repositoryWord') })"
          v-tooltip="t('core.projectPeremestitNizhe')"
          :disabled="readonly || index === draft.repos.length - 1"
          @click="move(index, 1)"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
            <path d="m6 10 6 6 6-6" />
          </svg>
        </UiButton>
        <UiButton
          data-role="project-repo-remove"
          data-context="project-repo-action"
          variant="ghost"
          :aria-label="t('core.projectUbratKey', { key: repo.key || t('core.repositoryWord') })"
          :disabled="readonly"
          v-tooltip="t('core.projectUbratStroku')"
          @click="remove(index)"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
            <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7M14 10v7" />
          </svg>
        </UiButton>
      </span>
    </div>

    <p v-if="!draft.repos.length" class="empty">{{ t('core.projectDobavteRabochuyuKopiyuChtoby') }}</p>


  </div>
</template>

<script setup lang="ts">
// Строки репозиториев: метка, путь, состояние проверки, выбор по умолчанию и порядок.
//
// Правки идут через чистые функции черновика, а не через мутацию строк: так выбор
// по умолчанию едет вместе с переименованной строкой, а форма не держит вторую
// копию этих правил. Состояние пути приходит снаружи: проверяет его сервер.
import { computed, ref } from 'vue';

import { UiButton, UiField, UiInput, UiRadio, vTooltip, t } from '../../ui';
import { moveRepo, removeRepo, renameRepoKey } from './projectDraft';
import type { ProjectDraft } from './projectDraft';
import type { UiTextValue } from '../../ui';

const draft = defineModel<ProjectDraft>({ required: true });

const props = defineProps<{
  errors: Array<{ path: string; message: string }>;
  checks: Record<string, { state: string; message: string }>;
  readonly: boolean;
}>();

const emit = defineEmits<{
  check: [dirs: string[]];
  // Явный выбор человека: форма сообщает о нём наружу, а не только пишет в черновик.
  selectRepo: [key: string];
}>();

const keyInputs = ref<Array<InstanceType<typeof UiInput> | null>>([]);
const dirInputs = ref<Array<InstanceType<typeof UiInput> | null>>([]);
const defaultGroup = computed(() => `project-default-${draft.value.id || 'new'}`);

function errorOf(path: string): string {
  return props.errors.find((error) => error.path === path)?.message ?? '';
}

function stateOf(dir: string): string {
  return props.checks[dir]?.state ?? '';
}

function stateText(dir: string): string {
  return props.checks[dir]?.message ?? '';
}

function setKeyRef(index: number, element: unknown): void {
  keyInputs.value[index] = element as InstanceType<typeof UiInput> | null;
}

function setDirRef(index: number, element: unknown): void {
  dirInputs.value[index] = element as InstanceType<typeof UiInput> | null;
}

function rename(index: number, key: UiTextValue): void {
  draft.value = renameRepoKey(draft.value, index, String(key ?? ''));
}

function setDir(index: number, dir: UiTextValue): void {
  const repos = draft.value.repos.map((repo, position) => (
    position === index ? { ...repo, dir: String(dir ?? '') } : repo
  ));

  draft.value = { ...draft.value, repos };
}

/**
 * Выбор репозитория по умолчанию: он же снимает требование выбора, поставленное
 * удалением прежнего. О выборе сообщаем наружу — он уходит в UI-контекст.
 */
function setDefault(index: number): void {
  const repo = draft.value.repos[index];

  if (!repo) {
    return;
  }

  draft.value = {
    ...draft.value,
    defaultRepoKey: repo.key,
    defaultRepoRequired: false,
  };
  emit('selectRepo', repo.key);
}

function move(index: number, delta: number): void {
  draft.value = moveRepo(draft.value, index, delta);
}

function remove(index: number): void {
  draft.value = removeRepo(draft.value, index);
}

// Новая строка пустая: метку и путь человек вписывает сам, а отправить её
// с пустыми полями форма не даст — проверка ввода назовёт оба поля.
function add(): void {
  draft.value = { ...draft.value, repos: [...draft.value.repos, { key: '', dir: '' }] };
}

/**
 * Фокус на поле строки по пути ошибки: форма ведёт человека к первой неправде.
 * Путь приходит из проверки ввода (`repos.1.dir`) и разбирается здесь же.
 */
function focus(path: string): boolean {
  const match = /^repos\.(\d+)\.(key|dir)$/u.exec(path);

  if (!match) {
    return false;
  }

  const index = Number(match[1]);
  const target = (match[2] === 'key' ? keyInputs : dirInputs).value[index];

  target?.focus();

  return Boolean(target);
}

defineExpose({ focus });
</script>

<style scoped>
.rows {
  display: flex;
  flex-direction: column;
}

.repo-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  min-height: 32px;
  margin-bottom: 8px;
  border-bottom: 1px solid var(--line);
}

.repo-heading h3 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}

.repo-count {
  margin-left: 6px;
  color: var(--ink-mid);
  font-size: 12px;
  font-weight: 400;
}

.row, .repo-columns {
  display: grid;
  grid-template-columns: var(--workspace-label-column) minmax(0, 1fr) var(--workspace-selection-column) var(--workspace-actions-column);
  gap: var(--workspace-column-gap);
  align-items: start;
}

.repo-columns {
  margin-bottom: 4px;
  font-size: 12px;
  line-height: 18px;
  color: var(--workspace-label-color);
}

.row {
  padding-block: 4px;
}

.row + .row {
  border-top: 1px solid var(--line);
}

.key, .dir {
  min-width: 0;
}

.repo-meta {
  display: flex;
  align-items: center;
  grid-column: 3;
  grid-row: 1;
  min-width: 0;
}

.acts {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  grid-column: 4;
  grid-row: 1;
  min-height: var(--control-height);
}

.state {
  grid-column: 2 / -1;
  grid-row: 2;
  min-width: 0;
  color: var(--ink-mid);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.state[data-state='git'], .state[data-state='worktree'] {
  color: var(--good);
}

.state[data-state='missing'], .state[data-state='denied'], .state[data-state='file'], .state[data-state='timeout'] {
  color: var(--warn);
}

.empty {
  margin: 0;
  padding: 8px 0;
  color: var(--ink-mid);
  font-size: 13px;
}

@container project-detail (max-width: 660px) {
  .repo-columns {
    display: none;
  }

  .row {
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px 12px;
    padding-block: 10px;
  }

  .key {
    grid-column: 1 / -1;
    grid-row: 1;
  }

  .dir {
    grid-column: 1 / -1;
    grid-row: 2;
  }

  .repo-meta {
    grid-column: 1;
    grid-row: 3;
  }

  .acts {
    grid-column: 2;
    grid-row: 3;
  }

  .state {
    grid-column: 1 / -1;
    grid-row: 4;
  }

}
</style>
