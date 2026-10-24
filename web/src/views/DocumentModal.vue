<template>
  <!-- Картинки и видео показывает MediaViewer во весь экран; здесь только документы. -->
  <UiDialog
    :open="Boolean(preview.href)"
    class="document-dialog"
    layer="document"
    initial-focus="#document-dialog-title"
    size="workspace"
    :label="title"
    :body-inset="false"
    fade-only
    @update:open="onDialogOpenChange"
    @click="onDocumentClick"
  >
    <template #header="{ close }">
      <div class="document-dialog__header">
        <div class="document-dialog__title">
          <span id="document-dialog-title" tabindex="-1">{{ title }}</span>
        </div>
        <UiIconButton
          role="embedded"
          label="Закрыть документ"
          v-tooltip="'Закрыть (Esc)'"
          @click="close('action')"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.9"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </UiIconButton>
      </div>
    </template>

    <div v-if="resolving" class="document-state">
      <UiSpinner decorative />
      Проверяю ссылку…
    </div>
    <div v-else-if="resolveError" class="document-state error">
      {{ resolveError }}
    </div>
    <DocumentPanel
      v-else
      class="document-panel"
      :source="source"
      :path="documentPath"
      :anchor="anchor"
      :line="line"
      @loaded="documentValue = $event"
    />
  </UiDialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { UiDialog, UiIconButton, UiSpinner, vTooltip } from '../ui';
import { documentsApi } from '../shared/documentsApi.ts';
import { useDocumentPreviewStore } from '../stores/documentPreview.ts';
import DocumentPanel from '../features/documents/DocumentPanel.vue';
import {
  documentLinkFromClick,
  parseDocumentRouteHref,
} from '../features/documents/links.ts';

interface LoadedDocument {
  name?: string;
  displayPath?: string;
}

const preview = useDocumentPreviewStore();
const source = ref('');
const documentPath = ref('');
const anchor = ref('');
const line = ref(0);
const documentValue = ref<LoadedDocument | null>(null);
const resolving = ref(false);
const resolveError = ref('');
let generation = 0;

const title = computed(
  () =>
    documentValue.value?.name ||
    documentPath.value.split('/').filter(Boolean).at(-1) ||
    'Документ',
);

/**
 * Новый preview не должен на один кадр показывать метаданные предыдущего документа.
 * Все производные поля сбрасываются синхронно до начала возможного resolve-запроса.
 */
function clearDocument(): void {
  source.value = '';
  documentPath.value = '';
  anchor.value = '';
  line.value = 0;
  documentValue.value = null;
  resolveError.value = '';
}

watch(
  () => preview.href,
  async (href) => {
    const currentGeneration = ++generation;

    clearDocument();
    resolving.value = false;

    if (!href) {
      return;
    }

    const target = parseDocumentRouteHref(href);

    if (!target) {
      resolveError.value = 'Некорректная ссылка на документ';

      return;
    }

    anchor.value = target.anchor;
    line.value = target.line;

    if (!target.open) {
      source.value = target.source;
      documentPath.value = target.path;

      return;
    }

    resolving.value = true;

    try {
      const resolved = await documentsApi.resolve(target.open, target.scope);

      if (currentGeneration !== generation) {
        return;
      }

      source.value = resolved.ref.source;
      documentPath.value = resolved.ref.path;
    } catch (error) {
      if (currentGeneration === generation) {
        resolveError.value =
          error instanceof Error
            ? error.message
            : 'Ссылка на документ недоступна';
      }
    } finally {
      if (currentGeneration === generation) {
        resolving.value = false;
      }
    }
  },
  { immediate: true },
);

/**
 * Ссылки внутри markdown должны заменить содержимое текущего viewer-а без навигации страницы.
 * Обрабатываем только распознанный document href, остальные клики остаются нетронутыми.
 */
function onDocumentClick(event: MouseEvent): void {
  const href = documentLinkFromClick(event);

  if (!href) {
    return;
  }

  event.preventDefault();
  preview.show(href);
}

function onDialogOpenChange(open: boolean): void {
  if (!open) {
    preview.close();
  }
}
</script>

<style scoped>
.document-dialog {
  width: min(1120px, calc(100vw - 40px));
}

.document-dialog__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  width: 100%;
  min-height: 30px;
}

.document-dialog__title {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  color: var(--ink);
  font-size: 13px;
  font-weight: 650;
}

.document-dialog__title span,
.document-dialog__title small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.document-dialog__title small {
  color: var(--ink-mid);
  font-size: 10px;
  font-weight: 400;
}

.document-panel {
  flex: 1;
  min-height: 0;
}

.document-state {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  color: var(--ink-mid);
  text-align: center;
}

.document-state.error {
  color: var(--bad);
}
</style>
