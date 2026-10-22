<template>
  <form class="project-editor" @submit.prevent="submit">
    <div class="editor-scroll">
      <div class="editor-body">
        <slot name="notices" />
        <section class="basics" aria-label="Основное">
          <UiField v-if="creating" label="Идентификатор" :error="errorOf('id')"
            data-context="workspace-property"
            hint="Латинские буквы, цифры, «-» и «_», начиная с буквы. После создания изменить нельзя.">
            <UiInput :ref="(element) => setIdRef(element)" :model-value="draft.id"
              data-role="project-id" placeholder="my-project" @update:model-value="setId" />
          </UiField>
          <UiField label="Название" :error="errorOf('title')" data-context="workspace-property">
            <UiInput :ref="(element) => setTitleRef(element)" :model-value="draft.title"
              data-role="project-title" placeholder="Название проекта" @update:model-value="set('title', $event)" />
          </UiField>
          <div v-if="!creating" class="identity-row">
            <span class="label">Идентификатор</span>
            <div class="identity-value"><span>{{ draft.id }}</span><span class="hint">Не меняется</span></div>
          </div>
          <UiField label="Описание" :error="errorOf('description')" data-context="workspace-property">
            <UiTextarea :model-value="draft.description" data-role="project-description"
              data-context="workspace-note" :rows="2" placeholder="Чем занимается проект и что важно о нём знать"
              @update:model-value="set('description', $event)" />
          </UiField>
          <UiField label="Метки" :error="errorOf('tags')" hint="Через запятую"
            data-context="workspace-property" data-hint-inline="true">
            <UiInput :model-value="draft.tags.join(', ')" data-role="project-tags"
              placeholder="продукт, сайт, внутренний" @update:model-value="setTags" />
          </UiField>
        </section>
        <section class="editor-section">
          <ProjectRepoRows ref="repoRows" v-model="draft" :errors="shownErrors"
            :checks="checks" :readonly="reposReadonly" @check="emit('check', $event)"
            @select-repo="emit('selectRepo', $event)" />
          <div class="source-row">
            <span class="hint">{{ reposReadonly ? 'Пути из профиля фабрики' : 'Пути из паспорта проекта' }}</span>
            <UiButton variant="ghost" data-context="workspace-toolbar" :aria-expanded="accessNoteOpen"
              :aria-controls="accessNoteId" @click="accessNoteOpen = !accessNoteOpen">
              Доступ к папкам {{ accessNoteOpen ? '↑' : '↓' }}
            </UiButton>
          </div>
          <p v-if="reposReadonly" class="hint">
            Пути задаёт профиль фабрики; редактирование откроется после миграции
          </p>
          <p v-show="accessNoteOpen" :id="accessNoteId" class="trust" data-role="project-trust">
            Пути из паспорта расширяют область чтения триажа и обновления кода.
            Права чатов и попыток фабрики они не расширяют.
          </p>
        </section>
        <section v-if="!creating" class="editor-section">
          <header class="editor-heading">
            <h3>Фабрика и связи</h3>
          </header>

          <ProjectProfileStatus
            v-if="detail"
            :detail="detail"
            @open-routes="emit('openRoutes')"
          />
          <p v-else class="hint">Связи появятся после создания проекта.</p>
        </section>

        <section v-if="!creating" class="management" data-role="project-manage">
          <h3 class="ui-visually-hidden">Управление</h3>

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
              data-context="workspace-toolbar"
              variant="text"
              :disabled="!canArchive"
              :loading="busy"
              @click="emit('archive')"
            >
              <template #leading><ProjectIcon name="archive" /></template>Архивировать
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
            <span v-if="dirty" class="hint">
              Сначала сохраните или отмените изменения.
            </span>
            <span v-else-if="!archived && dependencies?.archivable === false" class="hint">
              Архив недоступен: проверьте связи проекта выше.
            </span>
          </UiFormActions>

          <p v-if="lifecycleFailure" class="warn" data-role="project-manage-failure">
            {{ lifecycleFailure }}
          </p>
        </section>

      </div>
    </div>
    <footer class="editor-footer">
      <UiFormActions class="save-actions" align="between">
        <span v-if="draft.defaultRepoRequired" class="save-status attention" role="status">
          Выберите репозиторий по умолчанию.
        </span>
        <span v-else class="save-status" :class="{ attention: dirty }" role="status">
          <span v-if="!creating" class="save-dot" aria-hidden="true" />
          {{ saveStatus }}
        </span>
        <div class="save-buttons">
          <UiButton v-if="dirty" variant="ghost" data-context="workspace-toolbar"
            data-role="project-cancel" :disabled="saving" @click="cancel">Отменить</UiButton>
          <UiButton
            data-role="project-save"
            data-context="workspace-save"
            tone="accent"
            variant="outline"
            :disabled="!canSave"
            :loading="saving"
            loading-label="Сохраняю"
            type="submit"
          >
            {{ creating ? 'Создать проект' : 'Сохранить' }}
          </UiButton>
        </div>
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
import ProjectIcon from './ProjectIcon.vue';
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
  cancel: [];
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

function cancel(): void {
  localErrors.value = [];
  emit('cancel');
}

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
.project-editor {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.editor-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.editor-body {
  max-width: 980px;
  padding: 20px;
}

.basics {
  display: grid;
  gap: 8px;
  width: calc(100% - var(--workspace-selection-column) - var(--workspace-actions-column) - 2 * var(--workspace-column-gap));
}

.identity-row {
  display: grid;
  grid-template-columns: var(--workspace-label-column) minmax(0, 1fr);
  gap: var(--workspace-column-gap);
  align-items: center;
  min-height: 24px;
}

.identity-value {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 12px;
  overflow-wrap: anywhere;
  min-width: 0;
}

.label {
  color: var(--workspace-label-color);
  font-size: 12px;
  line-height: 18px;
}

.editor-section {
  margin-top: 20px;
}

.editor-heading {
  display: flex;
  align-items: center;
  min-height: 32px;
  margin-bottom: 8px;
  border-bottom: 1px solid var(--line);
}

.editor-heading h3 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}

.source-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
}

.management {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 16px;
  padding-top: 8px;
  border-top: 1px solid var(--line);
}

.hint, .trust {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--ink-mid);
}

.trust {
  max-width: 650px;
  margin-top: 4px;
  line-height: 20px;
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
  overflow-wrap: anywhere;
}

.link-label {
  font-weight: 600;
}

.link-items {
  color: var(--ink-mid);
}

.warn {
  margin: 0;
  font-size: 12px;
  color: var(--warn);
}

.editor-footer {
  flex: none;
  padding: 8px 20px;
  border-top: 1px solid var(--line);
  background: var(--sidebar);
}

.save-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 18px;
  overflow-wrap: anywhere;
}

.save-dot {
  width: 5px;
  height: 5px;
  flex: none;
  border-radius: var(--radius-round);
  background: var(--good);
}

.attention .save-dot {
  background: var(--warn);
}

.save-buttons {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
  margin-left: auto;
}

@container project-detail (max-width: 660px) {
  .basics {
    width: 100%;
  }

}

@container project-detail (max-width: 480px) {
  .editor-body {
    padding: 16px 12px;
  }

  .editor-footer {
    padding: 8px 12px;
  }

  .identity-row {
    grid-template-columns: 108px minmax(0, 1fr);
    gap: 5px;
  }

  .source-row {
    gap: 0;
  }

}

@container project-detail (max-width: 320px) {
  .identity-row {
    grid-template-columns: minmax(0, 1fr);
    gap: 3px;
  }

}
</style>
