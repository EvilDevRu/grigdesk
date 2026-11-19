<template>
  <form :id="formId" class="project-editor" :class="{ 'project-editor-dialog': dialog }" @submit.prevent="submit">
    <div class="editor-scroll">
      <div class="editor-body">
        <slot name="notices" />
        <section class="basics" :aria-label="t('core.projectOsnovnoe')">
          <UiField :label="t('core.taskTitle')" :error="errorOf('title')"
            :data-context="propertyContext" :required="creating">
            <UiInput :ref="(element) => setTitleRef(element)" :model-value="draft.title" :readonly="readonly"
              data-role="project-title" :placeholder="t('core.projectNazvanieProekta')"
              @update:model-value="setTitle" />
          </UiField>
          <UiField v-if="creating && (allowIdEdit || errorOf('id'))"
            :label="t('core.projectIdentifikator')" :error="errorOf('id')" :data-context="propertyContext"
            :hint="t('core.projectLatinskieBukvyTsifryI')">
            <UiInput :ref="(element) => setIdRef(element)" :model-value="draft.id"
              data-role="project-id" @update:model-value="setId" />
          </UiField>
          <UiField :label="t('core.projectIcon')" :error="errorOf('icon')"
            :data-context="propertyContext">
            <ProjectIconEditor
              :key="iconProjectId + ':' + iconEditorEpoch"
              :id="iconProjectId"
              :project-title="draft.title"
              :model-value="draft.icon"
              :disabled="readonly || saving || archived"
              @update:model-value="draft = { ...draft, icon: $event }"
              @busy="iconBusy = $event"
            />
          </UiField>
          <div v-if="!creating" class="identity-row">
            <span class="label">{{ t('core.projectIdentifikator') }}</span>
            <div class="identity-value"><span>{{ draft.id }}</span><span class="hint">{{ t('core.projectNeMenyaetsya') }}</span></div>
          </div>
          <UiField :label="t('core.taskDescription')" :error="errorOf('description')"
            :data-context="propertyContext">
            <UiTextarea :model-value="draft.description" :readonly="readonly" data-role="project-description"
              data-context="workspace-note" :rows="2" :placeholder="t('core.projectChemZanimaetsyaProektI')"
              @update:model-value="setDescription" />
          </UiField>
          <UiField :label="t('core.projectMetki')" :error="errorOf('tags')"
            :hint="t('core.projectCherezZapyatuyu')" :data-context="propertyContext"
            :data-hint-inline="dialog ? undefined : 'true'">
            <UiInput :model-value="draft.tags.join(', ')" :readonly="readonly" data-role="project-tags"
              :placeholder="t('core.projectProduktSaytVnutrenniy')" @update:model-value="setTags" />
          </UiField>
        </section>
        <section class="editor-section">
          <ProjectRepoRows ref="repoRows" v-model="draft" :errors="shownErrors"
            :checks="checks" :readonly="readonly || archived" :locked-prefix="profileRepoCount"
            @check="emit('check', $event)"
            @select-repo="emit('selectRepo', $event)" />
          <div class="source-row">
            <span v-if="!dialog" class="hint">{{ repoSourceText }}</span>
            <UiDisclosureButton v-model:open="accessNoteOpen" :controls="accessNoteId"
              variant="outline" size="compact">
              {{ t('core.projectDostupKPapkam') }}
            </UiDisclosureButton>
          </div>
          <p v-show="accessNoteOpen" :id="accessNoteId" class="trust" data-role="project-trust"> {{ t('core.projectPutiIzPasportaRasshiryayut') }} </p>
        </section>
        <section v-if="!creating" class="editor-section">
          <header class="editor-heading">
            <h3>{{ t('core.projectFabrikaISvyazi') }}</h3>
          </header>

          <ProjectProfileStatus
            v-if="detail"
            :detail="detail"
            @open-routes="emit('openRoutes')"
          />
          <p v-else class="hint">{{ t('core.projectSvyaziPoyavyatsyaPosleSozdaniya') }}</p>
          <ProjectFactoryConfig v-if="detail?.profile.present" :detail="detail"
                                :readonly="readonly || saving || busy" />
        </section>

        <section v-if="!creating" class="management" data-role="project-manage">
          <h3 class="ui-visually-hidden">{{ t('core.pipelineControls') }}</h3>

          <p v-if="archived" class="hint"> {{ t('core.projectProektVArhiveRazdely') }} </p>

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
              > {{ t('core.projectNastroitPravilo') }} </UiButton>
            </div>
          </div>

          <p v-for="reason in dependencies?.reasons ?? []" :key="reason" class="warn">{{ reason }}</p>

          <UiFormActions v-if="!readonly" align="between">
            <UiButton
              v-if="!archived"
              data-role="project-archive"
              data-context="workspace-toolbar"
              variant="text"
              :disabled="!canArchive"
              :loading="busy"
              @click="emit('archive')"
            >
              <template #leading><ProjectIcon name="archive" /></template>{{ t('core.projectArhivirovat') }} </UiButton>
            <UiButton
              v-else
              data-role="project-restore"
              tone="accent"
              :disabled="busy"
              :loading="busy"
              @click="emit('restore')"
            > {{ t('core.projectVosstanovit') }} </UiButton>
            <UiButton
              v-if="archived"
              data-role="project-remove"
              tone="danger"
              :disabled="busy || saving || dirty"
              :loading="busy"
              @click="emit('remove')"
            > {{ t('core.projectUdalitRegistratsiyu') }} </UiButton>
            <span v-if="dirty" class="hint"> {{ t('core.projectSnachalaSohraniteIliOtmenite') }} </span>
            <span v-else-if="!archived && dependencies?.archivable === false" class="hint"> {{ t('core.projectArhivNedostupenProverteSvyazi') }} </span>
          </UiFormActions>

          <UiButton v-if="!dependencies && !readonly" variant="text"
            :disabled="busy" @click="emit('retryDependencies')"> {{ t('core.trackerRefresh') }} </UiButton>
          <p v-if="lifecycleFailure" class="warn" data-role="project-manage-failure">
            {{ lifecycleFailure }}
          </p>
        </section>

      </div>
    </div>
    <footer v-if="!dialog" class="editor-footer">
      <UiFormActions class="save-actions" align="between">
        <span class="save-status" :class="{ attention: dirty || draft.defaultRepoRequired }" role="status">
          <span v-if="!creating && !draft.defaultRepoRequired" class="save-dot" aria-hidden="true" />
          {{ saveStatus }}
        </span>
        <div class="save-buttons">
          <UiButton v-if="dirty" variant="ghost" data-context="workspace-toolbar"
            data-role="project-cancel" :disabled="saving" @click="cancel">{{ t('core.trackerCancel') }}</UiButton>
          <UiButton
            data-role="project-save"
            data-context="workspace-save"
            tone="accent"
            :disabled="!canSave"
            :loading="saving"
            :loading-label="t('core.projectSohranyayu')"
            type="submit"
          >
            {{ saveLabel }}
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

import { UiButton, UiDisclosureButton, UiField, UiFormActions, UiInput, UiTextarea, t } from '../../ui';
import { validateProjectInput } from '../../../../shared/runtime/projectsContracts';
import { projectIdFromTitle, toInput } from './projectDraft';
import ProjectIcon from './ProjectIcon.vue';
import ProjectIconEditor from './ProjectIconEditor.vue';
import ProjectProfileStatus from './ProjectProfileStatus.vue';
import ProjectFactoryConfig from './ProjectFactoryConfig.vue';
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
  dialog?: boolean;
  formId?: string;
  allowIdEdit?: boolean;
  saving: boolean;
  // Есть ли правки относительно снимка: считает страница — ей это нужно и для
  // защиты ухода, и для кнопки сохранения.
  dirty: boolean;
  serverErrors: Array<{ path: string; message: string }>;
  checks: Record<string, { state: string; message: string }>;
  // Архив и восстановление: кнопки выключены, пока идёт операция, есть правки или
  // живые связи. Отказ сервера показывается текстом рядом с кнопкой.
  busy: boolean;
  readonly?: boolean;
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
  remove: [];
  retryDependencies: [];
  openRules: [path: string];
}>();

// Куда вести «Настроить правило»: у каждого раздела-владельца своя страница.
const RULE_ROUTES: Record<string, string> = {
  telegram: '/telegram',
  github: '/github',
};

const localErrors = ref<Array<{ path: string; message: string }>>([]);
const iconBusy = ref(false);
const iconEditorEpoch = ref(0);
const accessNoteOpen = ref(false);
const accessNoteId = useId();
const idInput = ref<InstanceType<typeof UiInput> | null>(null);
const titleInput = ref<InstanceType<typeof UiInput> | null>(null);
const repoRows = ref<InstanceType<typeof ProjectRepoRows> | null>(null);
const propertyContext = computed(() => props.dialog ? undefined : 'workspace-property');
const iconProjectId = computed(() => props.creating ? '' : draft.value.id);

// Свежая локальная проверка важнее серверной: она про тот текст, что в поле сейчас.
const shownErrors = computed(() => (
  localErrors.value.length ? localErrors.value : props.serverErrors
));

// Источник путей сохраняется и в локальной копии удалённого паспорта.
// Запрет редактирования всей формы не меняет происхождение репозиториев.
const profilePaths = computed(() => props.detail?.profile.pathsSource === 'profile');
const profileRepoCount = computed(() => (
  profilePaths.value ? props.detail?.profile.repos.length ?? 0 : 0
));

// Пока выбор по умолчанию потерян, сохранять нельзя: репозиторий по умолчанию
// исчез бы молча, а от него зависят и «Код», и пути триажа.
const canSave = computed(() => (
  props.dirty && !draft.value.defaultRepoRequired && !props.saving && !props.busy && !props.readonly
  && !iconBusy.value && (!props.creating || Boolean(draft.value.title.trim()))
));

const saveLabel = computed(() => props.creating ? t('core.projectSozdatProekt') : t('core.save'));
const saveStatus = computed(() => {
  if (draft.value.defaultRepoRequired) {
    return t('core.projectVyberiteRepozitoriyPoUmolchaniyu');
  }
  if (props.saving) {
    return t('core.projectSohranyaemIzmeneniya');
  }
  if (props.dirty) {
    return t('core.taskEditUnsaved');
  }

  return props.creating ? t('core.projectZapolniteDannyeProekta') : t('core.projectVseIzmeneniyaSohraneny');
});

const archived = computed(() => Boolean(props.detail?.archivedAt));
const repoSourceText = computed(() => {
  if (!profilePaths.value) {
    return t('core.projectPutiIzPasportaProekta');
  }

  return props.readonly || archived.value
    ? t('core.projectPutiIzProfilyaFabriki') : t('core.projectPutiZadaetProfilFabriki');
});

// Архив при несохранённых правках потерял бы их: сначала сохранение. Живые связи
// (например, правила Telegram) архив тоже не пропускают — это видно по сводке.
const canArchive = computed(() => (
  !props.busy && !props.dirty && props.dependencies?.archivable !== false
));

function cancel(): void {
  localErrors.value = [];
  iconEditorEpoch.value += 1;
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

/**
 * Название обновляет автоматически полученный идентификатор нового проекта.
 * Ручной выбор после конфликта и идентификатор сохранённого проекта сохраняются.
 */
function setTitle(value: UiTextValue): void {
  const title = String(value ?? '');
  const { id, title: previousTitle } = draft.value;
  const automatic = props.creating && (!id || id === projectIdFromTitle(previousTitle));

  draft.value = {
    ...draft.value,
    title,
    id: automatic ? projectIdFromTitle(title) : id,
  };
}

function setDescription(value: UiTextValue): void {
  draft.value = { ...draft.value, description: String(value ?? '') };
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

  const id = draft.value.id || projectIdFromTitle(draft.value.title);
  const value = { ...toInput(draft.value), ...(props.creating ? { id } : {}) };
  const validation = validateProjectInput(value, { creating: props.creating });

  if (!validation.ok) {
    localErrors.value = validation.fieldErrors;
    await focusFirst(validation.fieldErrors[0]?.path ?? '');

    return;
  }

  localErrors.value = [];

  if (props.creating && !draft.value.id) {
    draft.value = { ...draft.value, id };
  }

  emit('save');
}
defineExpose({ canSave, saveStatus });
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

.project-editor-dialog .editor-scroll {
  overscroll-behavior: contain;
}

.project-editor-dialog .basics {
  width: 100%;
  gap: 14px;
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
  .project-editor-dialog .editor-body {
    padding-right: max(12px, env(safe-area-inset-right));
    padding-left: max(12px, env(safe-area-inset-left));
  }

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
