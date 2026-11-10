<template>
  <UiButton variant="ghost" data-action="code-branches" :disabled="disabled"
            :aria-label="t('core.codeBranchChoose')" @click="openDialog">
    ⎇ {{ branch || t('core.codeBranchChoose') }}
  </UiButton>
  <UiDialog v-model:open="open" :title="t('core.codeBranchTitle')" size="workspace">
    <div class="branch-content">
      <p>{{ t('core.codeBranchDescription') }}</p>
      <code class="branch-path">{{ context.treePath }}</code>
      <UiLoadingState v-if="loading && !snapshot" :label="t('core.codeBranchLoading')" />
      <UiInlineMessage v-if="error" tone="danger">{{ error }}</UiInlineMessage>
      <template v-if="snapshot">
        <p data-action="branch-actual">
          {{ t('core.codeBranchActual', {
            branch: snapshot.actualBranch || '—', commit: snapshot.actualCommit.slice(0, 10) || '—',
          }) }}
        </p>
        <UiField :label="t('core.codeBranchChoose')">
          <UiSelect v-model="selected" searchable :disabled="running || busy"
                    data-action="branch-choice">
            <optgroup v-for="kind in kinds" :key="kind.id" :label="t(kind.label)">
              <option v-for="item in snapshot.branches.filter((entry) => entry.kind === kind.id)"
                      :key="item.ref" :value="item.ref"
                      :disabled="Boolean(item.occupied && !item.current)"
                      :data-description="item.commit.slice(0, 10)">
                {{ item.name }}{{ item.current ? ` · ${t('core.codeBranchCurrent')}` : '' }}
              </option>
            </optgroup>
          </UiSelect>
        </UiField>
        <div class="branch-actions">
          <UiButton data-action="switch-branch" :disabled="!selected || running || busy"
                    :loading="busy" @click="switchTo(selected)">
            {{ t('core.codeBranchSwitch') }}
          </UiButton>
          <UiButton data-action="return-branch" variant="ghost" :disabled="!returnRef || running || busy"
                    @click="switchTo(returnRef)">
            {{ t('core.codeBranchReturn', { branch: snapshot.settings.returnBranch }) }}
          </UiButton>
          <UiButton variant="ghost" :disabled="loading || busy" @click="load(false)">
            {{ t('core.codeBranchRefresh') }}
          </UiButton>
        </div>
        <UiInlineMessage v-if="snapshot.job" :tone="snapshot.job.status === 'failed' ? 'danger' : 'neutral'"
                         data-action="branch-job" aria-live="polite">
          {{ jobLabel }} · {{ snapshot.job.branch }} · {{ snapshot.job.commit.slice(0, 10) }}
          <span v-if="snapshot.job.message">{{ snapshot.job.message }}</span>
        </UiInlineMessage>
        <a v-if="readyUrl" :href="readyUrl" target="_blank" rel="noopener noreferrer">
          {{ t('core.codeBranchOpen') }}
        </a>
        <details v-if="snapshot.log">
          <summary>{{ t('core.codeBranchLog') }}</summary>
          <pre class="branch-log">{{ snapshot.log }}</pre>
        </details>
        <details>
          <summary>{{ t('core.codeBranchSettings') }}</summary>
          <div class="branch-settings">
            <p>{{ t('core.codeBranchCommandsHint') }}</p>
            <UiField v-for="field in fields" :key="field.id" :label="t(field.label)">
              <UiInput v-if="field.id === 'returnBranch' || field.id === 'url'"
                       v-model="settings[field.id]" :data-action="`branch-setting-${field.id}`" />
              <UiTextarea v-else v-model="settings[field.id]" :data-action="`branch-setting-${field.id}`" />
            </UiField>
            <UiButton data-action="save-branch-settings" :disabled="busy || running" @click="save">
              {{ t('core.codeBranchSave') }}
            </UiButton>
          </div>
        </details>
      </template>
    </div>
    <template #footer>
      <UiButton variant="ghost" @click="open = false">{{ t('core.codeBranchClose') }}</UiButton>
    </template>
  </UiDialog>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';

import {
  UiButton, UiDialog, UiField, UiInlineMessage, UiInput, UiLoadingState, UiSelect, UiTextarea,
  confirmDialog, showToast, t,
} from '../../ui';
import { codeApi, codeErrorMessage } from '../../shared/codeApi.ts';
import { DEFAULT_CODE_BRANCH_SETTINGS } from '../../../../shared/plugins/code/codeBranchContracts.ts';
import type {
  CodeBranchOverview, CodeBranchSettings,
} from '../../../../shared/plugins/code/codeBranchContracts.ts';
import type { CodeRequestContext } from '../../../../shared/plugins/code/codeContracts.ts';

const props = defineProps<{
  context: CodeRequestContext;
  branch: string;
  disabled?: boolean;
}>();
const emit = defineEmits<{ changed: [] }>();

const open = ref(false);
const snapshot = ref<CodeBranchOverview | null>(null);
const settings = ref<CodeBranchSettings>({ ...DEFAULT_CODE_BRANCH_SETTINGS });
const selected = ref('');
const loading = ref(false);
const busy = ref(false);
const error = ref('');
let timer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
let requestId = 0;

const kinds = [
  { id: 'local', label: 'core.codeBranchLocal' },
  { id: 'remote', label: 'core.codeBranchRemote' },
] as const;
const fields = [
  { id: 'returnBranch', label: 'core.codeBranchBase' },
  { id: 'stop', label: 'core.codeBranchStopCommand' },
  { id: 'prepare', label: 'core.codeBranchPrepareCommand' },
  { id: 'build', label: 'core.codeBranchBuildCommand' },
  { id: 'start', label: 'core.codeBranchStartCommand' },
  { id: 'check', label: 'core.codeBranchCheckCommand' },
  { id: 'url', label: 'core.codeBranchUrl' },
] as const;
const stepLabels = {
  checking: 'core.codeBranchStepChecking',
  stop: 'core.codeBranchStepStop',
  switch: 'core.codeBranchStepSwitch',
  prepare: 'core.codeBranchStepPrepare',
  build: 'core.codeBranchStepBuild',
  start: 'core.codeBranchStepStart',
  check: 'core.codeBranchStepCheck',
  done: 'core.codeBranchSucceeded',
} as const;

const running = computed(() => snapshot.value?.job?.status === 'running');
const returnRef = computed(() => {
  const data = snapshot.value;

  if (!data) {
    return '';
  }

  const local = data.branches.find((item) => item.ref === `refs/heads/${data.settings.returnBranch}`);
  const remote = data.branches.filter((item) => item.kind === 'remote'
    && item.name.slice(item.name.indexOf('/') + 1) === data.settings.returnBranch);

  return local?.ref || (remote.length === 1 ? remote[0]!.ref : '');
});
const jobLabel = computed(() => {
  const job = snapshot.value?.job;

  return job?.status === 'failed'
    ? t('core.codeBranchFailed') : t(stepLabels[job?.step || 'checking']);
});
const readyUrl = computed(() => {
  const data = snapshot.value;

  if (!data || data.job?.status !== 'succeeded' || data.actualBranch !== data.job.branch
    || data.actualCommit !== data.job.commit) {
    return '';
  }

  return /^https?:\/\//u.test(data.job.url) ? data.job.url : '';
});

/**
 * Таймер принадлежит только этому контексту и не размножает параллельные GET.
 * Закрытие диалога не останавливает задание и получение его итогового уведомления.
 */
function schedulePoll() {
  clearTimeout(timer);

  if (!disposed && running.value) {
    timer = setTimeout(() => void load(false), 2_000);
  }
}

/**
 * Поздний ответ закрытого компонента не меняет новый проект или рабочую папку.
 * Polling обновляет журнал, сохраняя несохранённый ввод команд в форме.
 */
async function load(withSettings: boolean) {
  const own = ++requestId;
  const previous = snapshot.value?.job;

  loading.value = true;

  try {
    const data = await codeApi.branches(props.context);

    if (disposed || own !== requestId) {
      return;
    }

    snapshot.value = data;
    error.value = '';

    if (withSettings) {
      settings.value = { ...data.settings };
      selected.value = data.branches.find((item) => item.current)?.ref || '';
    }
    if (previous?.status === 'running' && data.job?.status !== 'running') {
      emit('changed');
      showToast({
        id: `code-branch-${data.job?.id}`,
        tone: data.job?.status === 'succeeded' ? 'accent' : 'danger',
        title: data.job?.status === 'succeeded' ? t('core.codeBranchSucceeded')
          : data.job?.message || t('core.codeBranchFailed'),
      });
    }
  } catch (failure) {
    if (!disposed && own === requestId) {
      error.value = codeErrorMessage(failure, t('core.codeBranchLoadFailed'));
    }
  } finally {
    if (!disposed && own === requestId) {
      loading.value = false;
      schedulePoll();
    }
  }
}

function openDialog() {
  open.value = true;
  void load(true);
}

/**
 * Сохранение команд отделено от запуска: оно не выполняет shell и не меняет checkout.
 * После успеха форма показывает подтверждённый сервером снимок.
 */
async function save() {
  busy.value = true;

  try {
    snapshot.value = await codeApi.branchSettings(props.context, settings.value);
    error.value = '';
    showToast({ id: 'code-branch-settings', title: t('core.codeBranchSaved') });
  } catch (failure) {
    error.value = codeErrorMessage(failure, t('core.codeBranchLoadFailed'));
  } finally {
    busy.value = false;
  }
}

/**
 * Подтверждение называет конкретную ветку, коммит и папку единственного стенда.
 * Настройки из несохранённого черновика не могут незаметно попасть в запуск.
 */
async function switchTo(ref: string) {
  const target = snapshot.value?.branches.find((item) => item.ref === ref);
  const expectedHead = snapshot.value?.actualCommit || '';

  if (!target || running.value || busy.value) {
    return;
  }

  busy.value = true;

  try {
    const approved = await confirmDialog(t('core.codeBranchConfirm', {
      branch: target.name,
      commit: target.commit.slice(0, 10),
      root: props.context.treePath,
    }));

    if (!approved || disposed) {
      return;
    }

    snapshot.value = await codeApi.switchBranch(props.context, ref, target.commit, expectedHead);
    error.value = '';
    schedulePoll();
  } catch (failure) {
    error.value = codeErrorMessage(failure, t('core.codeBranchLoadFailed'));
  } finally {
    busy.value = false;
  }
}

onBeforeUnmount(() => {
  disposed = true;
  requestId += 1;
  clearTimeout(timer);
});
</script>

<style scoped>
.branch-content, .branch-settings { display: grid; gap: 12px; min-width: 0; }
.branch-content p { margin: 0; }
.branch-path { overflow-wrap: anywhere; color: var(--ink-mid); }
.branch-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.branch-log { max-height: 280px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
.branch-settings { margin-top: 12px; }
</style>
