<template>
  <UiDialog
    :open="open"
    :title="t('core.projectNovyyProekt')"
    size="content"
    data-role="project-create"
    data-ui-workspace
    :body-inset="false"
    initial-focus="[data-role='project-title']"
    :busy="saving"
    :dismissible="!saving"
    :close-label="t('core.close')"
    :footer-status="form?.saveStatus"
    :footer-pending="dirty"
    @update:open="onOpenUpdate"
  >
    <ProjectFormScreen
      ref="form"
      creating
      dialog
      :form-id="formId"
      :chat="null"
      :detail="null"
      :draft-present="Boolean(store.draft)"
      :saving="saving"
      :dirty="dirty"
      :server-errors="fieldErrors"
      :busy="false"
      :lifecycle-failure="''"
      :dependencies="store.dependencies"
      :save-failure="saveFailure"
      @save="submit"
      @check="check"
      @open-routes="openRoutes"
      @open-rules="openRules"
      @reload="reload"
      @overwrite="overwrite"
      @open-found="openFound"
    />
    <template #footer>
      <UiButton data-role="project-cancel" :disabled="saving" @click="requestClose">{{ t('core.cancel') }}</UiButton>
      <UiButton data-role="project-save" type="submit" :form="formId" variant="solid" tone="accent"
        :disabled="!form?.canSave" :loading="saving" :loading-label="t('core.projectSohranyayu')">
        {{ t('core.projectSozdatProekt') }}
      </UiButton>
    </template>
  </UiDialog>
</template>

<script setup lang="ts">
// Модалка создания проекта из списка чатов: тот же экран паспорта, что и в разделе
// «Проекты», но со своим коротким жизненным циклом — черновик живёт пока окно открыто.
import { computed, ref, useId, useTemplateRef, watch } from 'vue';
import { useRouter } from 'vue-router';

import { UiButton, UiDialog, confirmDialog, messageRef, t } from '../../ui';
import { checkRepositories, saveProject, useProjectsStore } from '../../actions/projects';
import { createDraft, isDirty } from './projectDraft';
import ProjectFormScreen from './ProjectFormScreen.vue';

const props = defineProps<{ open: boolean }>();

const emit = defineEmits<{
  'update:open': [value: boolean];
  saved: [id: string];
  openFound: [id: string];
}>();

const store = useProjectsStore();
const router = useRouter();
const emptyDraft = createDraft(null);

const saving = ref(false);
const fieldErrors = ref<Array<{ path: string; message: string }>>([]);
const saveFailure = ref('');
const form = useTemplateRef('form');
const formId = useId();

// Правки прежнего паспорта нельзя молча затереть черновиком создания.
const existingDirty = computed(() => {
  if (!store.draft) {
    return false;
  }

  const snapshot = store.opened ? createDraft(store.opened) : emptyDraft;

  return isDirty(store.draft, snapshot);
});

const dirty = computed(() => Boolean(store.draft && isDirty(store.draft, emptyDraft)));

/**
 * Открытие начинает пустой черновик; несохранённые правки прежнего паспорта
 * сбрасываются только после подтверждения человека, иначе окно не открывается.
 */
async function init(): Promise<void> {
  if (existingDirty.value) {
    const confirmed = await confirmDialog(
      messageRef('core.projectEstNesohranennyeIzmeneniyaBrosit'),
      { okText: t('core.projectBrosit') },
    );

    if (!confirmed) {
      emit('update:open', false);

      return;
    }
  }

  store.setOpened(null);
  store.setDraft(createDraft(null));
  store.setConflict(null);
  fieldErrors.value = [];
  saveFailure.value = '';
}

watch(() => props.open, (value) => {
  if (value) {
    void init();
  }
}, { immediate: true });

/**
 * Успех создания закрывает окно и очищает черновик: паспорт дальше живёт
 * в разделе «Проекты», а список чатов получает проект из каталога.
 */
function finishSave(id: string): void {
  store.setDraft(null);
  store.setConflict(null);
  emit('saved', id);
  emit('update:open', false);
}

/**
 * Создание передаёт подготовленный формой id, начальную ревизию назначает сервер.
 * Подсказки полей и код отказа остаются в окне, успех закрывает его через finishSave.
 */
async function submit(): Promise<void> {
  const draft = store.draft;

  if (!draft || saving.value) {
    return;
  }

  saving.value = true;
  fieldErrors.value = [];
  saveFailure.value = '';

  try {
    const result = await saveProject(null, draft, { catalogScope: 'active' });

    fieldErrors.value = result.fieldErrors;
    saveFailure.value = result.ok ? '' : result.error;

    if (result.ok) {
      finishSave(store.opened?.id ?? draft.id);
    }
  } finally {
    saving.value = false;
  }
}

/**
 * Перезапись поверх свежей ревизии: в создании прежней ревизии нет, поэтому
 * берём названную сервером в конфликте, иначе нулевую.
 */
async function overwrite(): Promise<void> {
  const draft = store.draft;

  if (!draft || saving.value) {
    return;
  }

  saving.value = true;
  fieldErrors.value = [];

  try {
    const result = await saveProject(null, draft, {
      expectedRevision: store.conflict?.currentRevision ?? 0,
      catalogScope: 'active',
    });

    fieldErrors.value = result.fieldErrors;
    saveFailure.value = result.ok ? '' : result.error;

    if (result.ok) {
      finishSave(store.opened?.id ?? draft.id);
    }
  } finally {
    saving.value = false;
  }
}

/**
 * Все способы закрытия проходят одну проверку черновика.
 * Пустая форма закрывается сразу, правки требуют подтверждения.
 */
async function requestClose(): Promise<void> {
  if (saving.value) {
    return;
  }

  if (dirty.value) {
    const confirmed = await confirmDialog(
      messageRef('core.projectEstNesohranennyeIzmeneniyaBrosit'),
      { okText: t('core.projectBrosit') },
    );

    if (!confirmed) {
      return;
    }
  }

  store.setDraft(null);
  store.setConflict(null);
  emit('update:open', false);
}

function onOpenUpdate(value: boolean): void {
  if (!value) {
    void requestClose();
  }
}

/**
 * «Перечитать серверную версию» в создании означает чистый лист: прежнего
 * снимка у нового паспорта нет, поэтому черновик пересоздаётся после подтверждения.
 */
async function reload(): Promise<void> {
  const confirmed = await confirmDialog(
    messageRef('core.projectPerechitatServernuyuVersiyuNesohranennye'),
    { okText: t('core.projectPerechitat') },
  );

  if (!confirmed) {
    return;
  }

  store.setConflict(null);
  store.setDraft(createDraft(null));
  fieldErrors.value = [];
  saveFailure.value = '';
}

function check(dirs: string[]): void {
  void checkRepositories(dirs);
}

function openRoutes(): void {
  void router.push('/routes');
}

function openRules(path: string): void {
  if (path) {
    void router.push(path);
  }
}

/**
 * «Открыть найденный»: создание с занятым идентификатором ведёт в паспорт
 * существующего проекта, черновик создания больше не нужен.
 */
function openFound(id: string): void {
  store.setDraft(null);
  store.setConflict(null);
  emit('update:open', false);

  if (id) {
    emit('openFound', id);
  }
}
</script>

