<template>
  <section class="gw-launcher">
    <header class="gw-launcher__head">
      <h2>{{ t('core.workflowRunHistory') }}</h2>
      <UiButton data-workflow-launch @click="openDialog">{{ t('core.workflowLaunch') }}</UiButton>
    </header>

    <p v-if="unavailable" class="gw-launcher__error" role="status">{{ t('core.workflowLoadFailed') }}</p>

    <ul v-if="store.runs.length" class="gw-launcher__runs">
      <li v-for="item in store.runs" :key="item.id">
        <button type="button" class="gw-launcher__run" :data-workflow-run="item.id" @click="store.openRun(item.id)">
          <strong>{{ item.title }}</strong>
          <span>{{ item.status }}</span>
        </button>
      </li>
    </ul>
    <p v-else-if="!unavailable" class="gw-launcher__empty">{{ t('core.workflowEmptyRuns') }}</p>
    <UiButton v-if="store.runsCursor" variant="ghost" data-workflow-runs-more @click="store.loadRuns(store.runsCursor)">
      {{ t('core.workflowResultMore') }}
    </UiButton>

    <p v-if="actionError" class="gw-launcher__error" role="alert">{{ actionError }}</p>

    <GraphWorkflowRun
      v-if="store.run"
      :run="store.run"
      :selection-details="store.details"
      :busy="store.pending"
      @select="store.openNode($event)"
      @action="onAction"
      @result="store.openResult(store.run!.id)"
    />

    <section v-if="store.result" class="gw-launcher__result">
      <h3>{{ t('core.workflowResultTitle') }}</h3>
      <p v-if="store.resultNotice" role="status">{{ store.resultNotice }}</p>
      <p v-if="store.result.incomplete" role="status">{{ t('core.workflowResultIncomplete') }}</p>
      <article v-for="row in store.result.rows" :key="row.key" class="gw-launcher__row">
        <h4>{{ row.title }}</h4>
        <p>{{ row.text }}</p>
      </article>
      <p v-if="store.result.missing.length" class="gw-launcher__missing">
        {{ t('core.workflowMissing') }}: {{ store.result.missing.map((item) => item.nodeId).join(', ') }}
      </p>
      <UiButton
        v-if="store.result.nextCursor"
        data-workflow-result-more
        :disabled="store.resultLoading"
        @click="store.loadMoreResult()"
      >{{ t('core.workflowResultMore') }}</UiButton>
    </section>

    <UiDialog v-model:open="dialogOpen" size="content" :title="t('core.workflowLaunch')">
      <div class="gw-launcher__form">
        <span data-workflow-launch-template>
          <UiSelect v-model="templateId" :aria-label="t('core.workflowSelectTemplate')">
            <option value="">—</option>
            <option v-for="item in store.templates" :key="item.id" :value="item.id">{{ item.title }}</option>
          </UiSelect>
        </span>
        <span v-if="requiresModel" data-workflow-launch-model>
          <UiSelect v-model="modelKey" :aria-label="t('core.workflowSelectModel')">
            <option value="">—</option>
            <option v-for="item in store.models" :key="item.provider + '/' + item.model" :value="item.provider + '/' + item.model">
              {{ item.label }}
            </option>
          </UiSelect>
        </span>
        <p v-if="requiresModel && !store.models.length" class="gw-launcher__error">{{ t('core.workflowNoModels') }}</p>
        <UiFilePicker
          multiple
          :accept="accept"
          data-workflow-launch-files
          @change="onFiles"
        />
        <p v-if="fileError || startError" class="gw-launcher__error" role="alert">
          {{ fileError || startError }}
        </p>
      </div>
      <template #footer>
        <UiButton
          data-workflow-launch-start
          :disabled="!canStart || store.pending"
          @click="start"
        >{{ t('core.workflowLaunch') }}</UiButton>
      </template>
    </UiDialog>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';

import { t, UiButton, UiDialog, UiFilePicker, UiSelect } from '../../ui';
import GraphWorkflowRun from './GraphWorkflowRun.vue';
import { useGraphWorkflowsStore } from '../../stores/graphWorkflows.ts';
import { isRecord } from '../../../../shared/lib/objects.ts';
import { ApiError } from '../../shared/apiClient.ts';

const store = useGraphWorkflowsStore();
const route = useRoute();
const dialogOpen = ref(false);
const templateId = ref('');
const modelKey = ref('');
const files = ref<Array<{ name: string; text: string }>>([]);
const fileError = ref<string | null>(null);
const unavailable = ref(false);
const starting = ref(false);
const startError = ref<string | null>(null);
const actionError = ref<string | null>(null);
const template = computed(() => store.templates.find((item) => item.id === templateId.value));
const requiresModel = computed(() => template.value?.requiresModel !== false);

let attempt: {
  id: string;
  templateId: string;
  expectedRevision: string;
  modelRef: { provider: string; model: string };
  files: typeof files.value;
} | undefined;

const accept = computed(() => template.value?.inputKind === 'transcript' ? '.txt,.json' : '.txt,.md');

const canStart = computed(() => Boolean(template.value && (!requiresModel.value || modelKey.value)
  && files.value.length && !fileError.value && !starting.value));

/**
 * Диалог запуска читает каталог, модели и историю один раз при открытии.
 * Пустой список проектов Git не мешает графовому маршруту.
 */
function openDialog(): void {
  dialogOpen.value = true;
  void store.loadModels().catch(() => {});
  void store.loadTemplates().then(() => {
    const wanted = route?.query?.workflow;

    if (!templateId.value && typeof wanted === 'string'
      && store.templates.some((item) => item.id === wanted)) {
      templateId.value = wanted;
    }
  }).catch(() => {
    unavailable.value = true;
  });
}

/**
 * Файлы проверяются по размеру до чтения и декодируются строгим UTF-8.
 * Вход встречи и документов различается только расширением и числом файлов.
 */
async function onFiles(selected: File[]): Promise<void> {
  fileError.value = null;
  files.value = [];

  const limit = template.value?.inputKind === 'transcript' ? 1 : 20;

  if (selected.length < 1 || selected.length > limit) {
    fileError.value = t('core.workflowErrorInputLimit');

    return;
  }

  let total = 0;

  for (const file of selected) {
    if (file.size > 64 * 1024 || total + file.size > 256 * 1024) {
      fileError.value = t('core.workflowErrorInputLimit');

      return;
    }

    total += file.size;
  }

  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const loaded: Array<{ name: string; text: string }> = [];

    for (const file of selected) {
      loaded.push({ name: file.name, text: decoder.decode(await file.arrayBuffer()) });
    }

    files.value = loaded;
  } catch {
    fileError.value = t('core.workflowErrorInputLimit');
  }
}

/**
 * Старт принимает UUID клиента и точную редакцию шаблона.
 * Принятый прогон открывается сразу; отказ формы сохраняет выбор.
 */
async function start(): Promise<void> {
  const selected = template.value;

  if (!selected || !canStart.value || store.pending) {
    return;
  }

  const separator = modelKey.value.indexOf('/');
  const provider = requiresModel.value ? modelKey.value.slice(0, separator) : '';
  const model = requiresModel.value ? modelKey.value.slice(separator + 1) : '';

  if (!attempt || attempt.templateId !== selected.id || attempt.modelRef.provider !== provider
    || attempt.modelRef.model !== model || attempt.files !== files.value) {
    attempt = {
      id: crypto.randomUUID(),
      templateId: selected.id,
      expectedRevision: selected.revision,
      modelRef: { provider, model },
      files: files.value,
    };
  }

  starting.value = true;
  startError.value = null;

  try {
    await store.startRun(attempt);
    attempt = undefined;
    dialogOpen.value = false;
  } catch (caught) {
    if (caught instanceof ApiError && caught.status === 409) {
      attempt = undefined;
    }

    startError.value = caught instanceof ApiError && isRecord(caught.data)
      && caught.data.error === 'workflow_model_unsupported'
      ? t('core.workflowModelUnsupported')
      : caught instanceof ApiError ? caught.message : t('core.workflowLoadFailed');
  } finally {
    starting.value = false;
  }
}

/**
 * 409 даёт понятный текст и перечитывание прогона.
 * Панель и комментарий пользователя сохраняются.
 */
async function onAction(payload: Record<string, unknown>): Promise<void> {
  actionError.value = null;

  try {
    await store.act(payload);
  } catch (caught) {
    if (caught instanceof ApiError && caught.status === 409) {
      actionError.value = t('core.workflowConflict');
      await store.refreshCurrent(true);

      return;
    }

    actionError.value = caught instanceof ApiError && isRecord(caught.data)
      && caught.data.error === 'active_workflow_limit'
      ? t('core.workflowActiveLimit')
      : caught instanceof ApiError ? caught.message : t('core.workflowLoadFailed');
  }
}

onMounted(() => {
  store.subscribe();
  void store.loadRuns().catch(() => {
    unavailable.value = true;
  });
});

onBeforeUnmount(() => {
  store.dispose();
});
</script>

<style scoped>
.gw-launcher {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.gw-launcher__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.gw-launcher__runs {
  display: flex;
  flex-direction: column;
  gap: 6px;
  list-style: none;
  margin: 0;
  padding: 0;
}

.gw-launcher__run {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  padding: 8px;
  border: 1px solid var(--ui-border, #d0d7de);
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
}

.gw-launcher__form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.gw-launcher__error {
  color: var(--ui-danger, #b42318);
}

.gw-launcher__row {
  padding: 8px 0;
  border-bottom: 1px solid var(--ui-border, #d0d7de);
}
</style>