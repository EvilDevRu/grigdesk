<template>
  <form class="form" @submit.prevent="submit">
    <section class="section">
      <header class="section-heading">
        <div>
          <h3 class="sttl">Основное</h3>
          <p class="section-description">Название и детали, по которым легко найти проект.</p>
        </div>
      </header>

      <div class="basics">
        <UiField
          v-if="creating"
          label="Идентификатор"
          :error="errorOf('id')"
          hint="Строчная латинская буква, дальше буквы, цифры, «-» и «_»"
        >
          <UiInput
            :ref="(element) => setIdRef(element)"
            :model-value="draft.id"
            data-role="project-id"
            placeholder="my-project"
            @update:model-value="setId"
          />
        </UiField>

        <UiField label="Название" :error="errorOf('title')">
          <UiInput
            :ref="(element) => setTitleRef(element)"
            :model-value="draft.title"
            data-role="project-title"
            placeholder="Название проекта"
            @update:model-value="set('title', $event)"
          />
        </UiField>

        <UiField label="Метки" :error="errorOf('tags')" hint="Через запятую">
          <UiInput
            :model-value="draft.tags.join(', ')"
            data-role="project-tags"
            placeholder="продукт, сайт, внутренний"
            @update:model-value="setTags"
          />
        </UiField>

        <UiField class="description" label="Описание" :error="errorOf('description')">
          <UiTextarea
            :model-value="draft.description"
            data-role="project-description"
            :rows="2"
            placeholder="Чем занимается проект и что важно о нём знать"
            @update:model-value="set('description', $event)"
          />
        </UiField>
      </div>
    </section>

    <section class="section">
      <header class="section-heading">
        <div>
          <h3 class="sttl">Репозитории <span class="repo-count">{{ draft.repos.length }}</span></h3>
          <p class="section-description">Рабочие копии кода и репозиторий по умолчанию.</p>
        </div>
      </header>

      <ProjectRepoRows
        ref="repoRows"
        v-model="draft"
        :errors="shownErrors"
        :checks="checks"
        :readonly="reposReadonly"
        @check="emit('check', $event)"
        @select-repo="emit('selectRepo', $event)"
      />

      <p v-if="reposReadonly" class="hint">
        Пути задаёт профиль фабрики; редактирование откроется после миграции
      </p>

      <!--
        Граница доверия: пути вводит человек, и они расширяют только те области,
        которые перечислены здесь. Обещать больше — значит соврать о правах.
      -->
      <div class="access-note">
        <UiButton
          variant="text"
          :aria-expanded="accessNoteOpen"
          :aria-controls="accessNoteId"
          @click="accessNoteOpen = !accessNoteOpen"
        >
          Как используются эти пути {{ accessNoteOpen ? '↑' : '↓' }}
        </UiButton>
        <p v-show="accessNoteOpen" :id="accessNoteId" class="trust" data-role="project-trust">
          Пути из паспорта расширяют область чтения триажа и обновления кода.
          Права чатов и попыток фабрики они не расширяют.
        </p>
      </div>
    </section>

    <section class="section">
      <header class="section-heading">
        <div>
          <h3 class="sttl">Фабрика и связи</h3>
          <p class="section-description">Профиль и маршруты автоматизации проекта.</p>
        </div>
      </header>

      <ProjectProfileStatus
        v-if="detail"
        :detail="detail"
        @open-routes="emit('openRoutes')"
      />
      <p v-else class="hint">Связи появятся после создания проекта.</p>
    </section>

    <section class="section" data-role="project-manage">
      <header class="section-heading">
        <div>
          <h3 class="sttl">Управление</h3>
          <p class="section-description">Архив проекта и связи, которые его держат.</p>
        </div>
      </header>

      <p v-if="archived" class="hint">
        Проект в архиве: разделы его больше не предлагают, а связи и маршруты остались.
      </p>

      <!--
        Связи показываются до архива: «нельзя» без списка того, что мешает, человеку
        ничего не объясняет. У правил рядом ссылка на их раздел.
      -->
      <div v-if="dependencies && dependencies.items.length" class="links">
        <div v-for="item in dependencies.items" :key="item.kind" class="link">
          <span class="link-label">{{ item.label }}: {{ item.count }}</span>
          <span v-if="item.items.length" class="link-items">{{ item.items.join(', ') }}</span>
          <UiButton
            v-if="ruleRoute(item.kind)"
            variant="text"
            :data-role="`project-rule-link-${item.kind}`"
            @click="emit('openRules', ruleRoute(item.kind))"
          >
            Настроить правило
          </UiButton>
        </div>
      </div>

      <p v-for="reason in dependencies?.reasons ?? []" :key="reason" class="warn">{{ reason }}</p>

      <UiFormActions align="between">
        <UiButton
          v-if="!archived"
          data-role="project-archive"
          :disabled="!canArchive"
          :loading="busy"
          @click="emit('archive')"
        >
          Архивировать
        </UiButton>
        <UiButton
          v-else
          data-role="project-restore"
          tone="accent"
          :disabled="busy"
          :loading="busy"
          @click="emit('restore')"
        >
          Восстановить
        </UiButton>
        <span v-if="!archived && !canArchive" class="hint">
          Архив запрещён, пока на проект ссылаются другие разделы.
        </span>
      </UiFormActions>

      <p v-if="lifecycleFailure" class="warn" data-role="project-manage-failure">
        {{ lifecycleFailure }}
      </p>
    </section>

    <footer class="savebar">
      <UiFormActions align="between">
        <span v-if="draft.defaultRepoRequired" class="save-status attention" role="status">
          Выберите репозиторий по умолчанию.
        </span>
        <span v-else class="save-status" :class="{ attention: dirty }" role="status">
          <span v-if="!creating" class="save-dot" aria-hidden="true" />
          {{ saveStatus }}
        </span>
        <UiButton
          data-role="project-save"
          tone="accent"
          variant="solid"
          :disabled="!canSave"
          :loading="saving"
          loading-label="Сохраняю"
          @click="submit"
        >
          {{ creating ? 'Создать проект' : 'Сохранить' }}
        </UiButton>
      </UiFormActions>
    </footer>
  </form>
</template>

<script setup lang="ts">
// Форма паспорта: черновик из стора, проверка ввода и отправка операциям раздела.
//
// Форма не ходит в сеть и не хранит снимок: она правит черновик, сверяет его
// со снимком (dirty) и отдаёт наверх — сохранение, проверку путей и переход
// в «Маршруты» делает страница.
import { computed, nextTick, ref, useId } from 'vue';

import {
  UiButton,
  UiField,
  UiFormActions,
  UiInput,
  UiTextarea,
} from '../../ui';
import { validateProjectInput } from '../../../../shared/runtime/projectsContracts';
import { toInput } from './projectDraft';
import ProjectProfileStatus from './ProjectProfileStatus.vue';
import ProjectRepoRows from './ProjectRepoRows.vue';
import type {
  ProjectDependencies,
  ProjectDetail,
} from '../../../../shared/runtime/projectsContracts';
import type { ProjectDraft } from './projectDraft';
import type { UiTextValue } from '../../ui';

const draft = defineModel<ProjectDraft>({ required: true });

const props = defineProps<{
  detail: ProjectDetail | null;
  creating: boolean;
  saving: boolean;
  // Есть ли правки относительно снимка: считает страница — ей это нужно и для
  // защиты ухода, и для кнопки сохранения.
  dirty: boolean;
  serverErrors: Array<{ path: string; message: string }>;
  checks: Record<string, { state: string; message: string }>;
  // Архив и восстановление: кнопки выключены, пока идёт операция, есть правки или
  // живые связи. Отказ сервера показывается текстом рядом с кнопкой.
  busy: boolean;
  lifecycleFailure: string;
  dependencies: ProjectDependencies | null;
}>();

const emit = defineEmits<{
  save: [];
  check: [dirs: string[]];
  selectRepo: [key: string];
  openRoutes: [];
  archive: [];
  restore: [];
  openRules: [path: string];
}>();

// Куда вести «Настроить правило»: у каждого раздела-владельца своя страница.
const RULE_ROUTES: Record<string, string> = {
  telegram: '/telegram',
  github: '/github',
};

const localErrors = ref<Array<{ path: string; message: string }>>([]);
const accessNoteOpen = ref(false);
const accessNoteId = useId();
const idInput = ref<InstanceType<typeof UiInput> | null>(null);
const titleInput = ref<InstanceType<typeof UiInput> | null>(null);
const repoRows = ref<InstanceType<typeof ProjectRepoRows> | null>(null);

// Свежая локальная проверка важнее серверной: она про тот текст, что в поле сейчас.
const shownErrors = computed(() => (
  localErrors.value.length ? localErrors.value : props.serverErrors
));

// У профильного проекта пути задаёт профиль фабрики: строки только показываются.
const reposReadonly = computed(() => props.detail?.profile.pathsSource === 'profile');

// Пока выбор по умолчанию потерян, сохранять нельзя: репозиторий по умолчанию
// исчез бы молча, а от него зависят и «Код», и пути триажа.
const canSave = computed(() => (
  props.dirty && !draft.value.defaultRepoRequired && !props.saving
));

const saveStatus = computed(() => {
  if (props.saving) {
    return 'Сохраняем изменения…';
  }
  if (props.dirty) {
    return 'Есть несохранённые изменения';
  }

  return props.creating ? 'Заполните данные проекта' : 'Все изменения сохранены';
});

const archived = computed(() => Boolean(props.detail?.archivedAt));

// Архив при несохранённых правках потерял бы их: сначала сохранение. Живые связи
// (например, правила Telegram) архив тоже не пропускают — это видно по сводке.
const canArchive = computed(() => (
  !props.busy && !props.dirty && props.dependencies?.archivable !== false
));

function ruleRoute(kind: string): string {
  return RULE_ROUTES[kind] ?? '';
}

function setIdRef(element: unknown): void {
  idInput.value = element as InstanceType<typeof UiInput> | null;
}

function setTitleRef(element: unknown): void {
  titleInput.value = element as InstanceType<typeof UiInput> | null;
}

function errorOf(path: string): string {
  return shownErrors.value.find((error) => error.path === path)?.message ?? '';
}

function setId(value: UiTextValue): void {
  draft.value = { ...draft.value, id: String(value ?? '') };
}

function set(field: 'title' | 'description', value: UiTextValue): void {
  draft.value = { ...draft.value, [field]: String(value ?? '') };
}

function setTags(value: UiTextValue): void {
  const tags = String(value ?? '').split(',').map((tag) => tag.trim()).filter(Boolean);

  draft.value = { ...draft.value, tags };
}

/**
 * Ведёт фокус к первой неправде: у репозиториев это строка (её поля живут в дочернем
 * компоненте), у остальных — своё поле. Тик ожидания нужен, чтобы поле уже было в DOM.
 */
async function focusFirst(path: string): Promise<void> {
  await nextTick();

  if (path === 'id') {
    idInput.value?.focus();

    return;
  }
  if (path === 'title') {
    titleInput.value?.focus();

    return;
  }

  repoRows.value?.focus(path);
}

/**
 * Отправка: сначала проверка ввода, потом — операция сохранения. Локальные подсказки
 * важнее серверных: они про тот текст, который человек видит в поле сейчас.
 */
async function submit(): Promise<void> {
  if (!canSave.value) {
    return;
  }

  const value = { ...toInput(draft.value), ...(props.creating ? { id: draft.value.id } : {}) };
  const validation = validateProjectInput(value, { creating: props.creating });

  if (!validation.ok) {
    localErrors.value = validation.fieldErrors;
    await focusFirst(validation.fieldErrors[0]?.path ?? '');

    return;
  }

  localErrors.value = [];
  emit('save');
}
</script>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  min-height: 100%;
}

.section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 0;
  border-bottom: 1px solid var(--line);
}

.section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.section-index {
  color: var(--ink-low);
  font-family: var(--mono);
  font-size: 11px;
}

.section-description {
  margin: 4px 0 0;
  color: var(--ink-mid);
  font-size: 12px;
}

.basics {
  display: grid;
  align-items: start;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 12px;
}

.description {
  grid-column: 1 / -1;
}

.sttl {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.015em;
}

.repo-count {
  margin-left: 6px;
  color: var(--ink-mid);
  font-size: 12px;
  font-weight: 400;
}

.hint,
.trust {
  margin: 0;
  font-size: 12px;
  color: var(--ink-mid);
}

.access-note {
  color: var(--ink-low);
  font-size: 12px;
}

.links {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.link {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: baseline;
  font-size: 12px;
}

.link-label {
  font-weight: 600;
}

.link-items {
  color: var(--ink-low);
}

.warn {
  margin: 0;
  font-size: 12px;
  color: var(--warn-fg, #b26a00);
}

.trust {
  max-width: 650px;
  margin-top: 8px;
}

.manage-note {
  margin: 16px 0 24px;
  color: var(--ink-low);
  font-size: 11px;
}

.savebar {
  position: sticky;
  bottom: 0;
  z-index: 1;
  margin: auto -16px 0;
  padding: 10px 16px;
  border-top: 1px solid var(--line);
  background: var(--sidebar);
}

.save-status {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--ink-mid);
  font-size: 12px;
}

.save-dot {
  width: 5px;
  height: 5px;
  flex: none;
  border-radius: 50%;
  background: var(--good);
}

.attention {
  color: var(--warn);
}

.attention .save-dot {
  background: var(--warn);
}

@container project-detail (max-width: 580px) {
  .basics {
    grid-template-columns: minmax(0, 1fr);
    gap: 12px;
  }

  .section {
    padding: 12px 0;
  }

  .savebar {
    margin-inline: -16px;
    padding: 8px 16px;
  }
}

@container project-detail (max-width: 360px) {
  .save-status {
    max-width: 145px;
    font-size: 11px;
  }
}
</style>
