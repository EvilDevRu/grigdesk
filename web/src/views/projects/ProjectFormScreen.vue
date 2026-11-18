<template>
  <div class="form-content">
    <UiInlineMessage
      v-if="chat && !chat.loaded && !creating && detail && !detail.archivedAt && !readonly"
      :tone="chat.loadError ? 'warning' : 'neutral'"
    >
      <template v-if="chat.loadError">
        <strong>{{ t('core.chatListLoadFailed') }}</strong>
        <div>{{ resolveUiText(chat.loadErrorMessage || '') }}</div>
        <UiButton :disabled="chat.loading" @click="chat.retryLoad()">
          {{ t('core.chatListRetry') }}
        </UiButton>
      </template>
      <div v-if="!chat.loadError || chat.loading">{{ t('core.chatListLoading') }}</div>
      <div>{{ t('core.chatStoreNotLoaded') }}</div>
    </UiInlineMessage>
    <ProjectForm
      v-if="draftPresent && store.draft"
      ref="form"
      v-model="store.draft"
      :detail="creating ? null : detail"
      :creating="creating"
      :dialog="dialog"
      :form-id="formId"
      :allow-id-edit="saveFailure === 'exists' || saveFailure === 'tombstoned'"
      :saving="saving"
      :dirty="dirty"
      :server-errors="serverErrors"
      :checks="store.checks"
      :busy="busy"
      :readonly="readonly"
      :lifecycle-failure="lifecycleFailure"
      :dependencies="dependencies"
      @save="save"
      @cancel="emit('cancel')"
      @check="emit('check', $event)"
      @select-repo="emit('selectRepo', $event)"
      @open-routes="emit('openRoutes')"
      @archive="emit('archive')"
      @restore="emit('restore')"
      @remove="emit('remove')"
      @retry-dependencies="emit('retryDependencies')"
      @open-rules="emit('openRules', $event)"
    >
      <template #notices>
        <div
          v-if="store.error && !store.conflict && saveFailure !== 'exists'"
          class="form-notice"
          role="alert"
        >
          <UiInlineMessage tone="danger">{{ store.error }}</UiInlineMessage>
          <UiButton
            v-if="!creating && !detail"
            data-role="project-detail-retry"
            @click="emit('retryDetail')"
          > {{ t('core.pluginNotificationsRetry') }} </UiButton>
        </div>
        <ProjectConflict
          v-if="draftPresent && store.conflict"
          class="form-notice"
          :conflict="store.conflict"
          :busy="saving"
          @reload="emit('reload')"
          @overwrite="emit('overwrite')"
        />

        <div v-if="saveFailure === 'exists'" class="form-notice" data-role="project-save-failure">
          <UiInlineMessage tone="warning">
            <p class="sub">{{ t('core.projectProektSTakimIdentifikatorom') }}</p>
            <UiButton data-role="project-open-found" variant="text" @click="emit('openFound', submittedId)">
              {{ t('core.projectOtkrytNaydennyyProekt') }}
            </UiButton>
          </UiInlineMessage>
        </div>

      </template>
    </ProjectForm>
    <div v-else class="form-notice">
      <template v-if="store.error">
        <UiInlineMessage tone="danger">{{ store.error }}</UiInlineMessage>
        <UiButton v-if="!creating" data-role="project-detail-retry" @click="emit('retryDetail')"> {{ t('core.pluginNotificationsRetry') }} </UiButton>
      </template>
      <UiLoadingState v-else :label="t('core.projectZagruzkaProekta')" variant="document">
        <div class="passport-loading">
          <UiSkeletonLayout layout="form" :header="false" />
        </div>
      </UiLoadingState>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, useTemplateRef } from 'vue';

import { UiSkeletonLayout, t, resolveUiText } from '../../ui';
import type { UiText } from '../../ui';

// Содержимое экрана паспорта: уведомления, форма и заглушка загрузки.
// Общий для раздела «Проекты» и модалки создания из списка чатов: разметка и
// стили живут здесь, а состояние и операции передаёт владелец экрана.
import {
  UiButton, UiInlineMessage, UiLoadingState,
} from '../../ui';
import { useProjectsStore } from '../../actions/projects';
import type { ProjectDependencies, ProjectDetail } from '../../../../shared/runtime/projectsContracts';
import ProjectConflict from './ProjectConflict.vue';
import ProjectForm from './ProjectForm.vue';

// Стор чатов приходит пропом: прямой импорт тянул бы router со всеми разделами
// в тестовые бандлы экрана, где чаты подменены заглушкой на другой глубине пути.
interface ChatNoticeState {
  loaded: boolean;
  loading: boolean;
  loadError: unknown;
  loadErrorMessage?: UiText | null;
  retryLoad: () => void;
}

defineProps<{
  creating: boolean;
  dialog?: boolean;
  formId?: string;
  detail: ProjectDetail | null;
  draftPresent: boolean;
  saving: boolean;
  dirty: boolean;
  serverErrors: Array<{ path: string; message: string }>;
  busy: boolean;
  readonly?: boolean;
  lifecycleFailure: string;
  dependencies: ProjectDependencies | null;
  saveFailure: string;
  chat: ChatNoticeState | null;
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
  reload: [];
  overwrite: [];
  retryDetail: [];
  openFound: [id: string];
}>();

const store = useProjectsStore();
const submittedId = ref('');
const form = useTemplateRef('form');

function save(): void {
  // Ссылка на найденный проект относится к отправленному ID, даже если черновик уже исправили.
  submittedId.value = store.draft?.id ?? '';
  emit('save');
}

defineExpose({
  canSave: computed(() => form.value?.canSave ?? false),
  saveStatus: computed(() => form.value?.saveStatus ?? ''),
});
</script>

<style scoped>
.form-content {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  min-width: 0;
  container: project-detail / inline-size;
}

.form-notice {
  margin-bottom: 16px;
  overflow-wrap: anywhere;
}

.form-content > .form-notice {
  padding: 20px;
  overflow: auto;
}

.passport-loading {
  --skeleton-form-columns: var(--workspace-label-column) minmax(0, 1fr);
  --skeleton-form-column-gap: var(--workspace-column-gap);
  max-width: calc(940px - var(--workspace-selection-column) - var(--workspace-actions-column)
    - 2 * var(--workspace-column-gap));
  width: calc(100% - var(--workspace-selection-column) - var(--workspace-actions-column)
    - 2 * var(--workspace-column-gap));
}

.passport-loading :deep(.ui-skeleton-layout__copy) {
  grid-template-columns: var(--skeleton-form-columns);
  column-gap: var(--skeleton-form-column-gap);
}

@container project-detail (max-width: 660px) {
  .passport-loading {
    width: 100%;
  }
}

@container project-detail (max-width: 480px) {
  .passport-loading {
    --skeleton-form-columns: minmax(0, 1fr);
  }

  .form-content > .form-notice:has(.passport-loading) {
    padding: 16px 12px;
  }
}
</style>
