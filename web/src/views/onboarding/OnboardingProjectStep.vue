<template>
  <section v-if="store.draft">
    <h2>{{ t('core.onboardingAddProject') }}</h2>
    <UiField :label="t('core.onboardingProjectTitle')">
      <UiInput :model-value="store.draft.title" :disabled="locked" :maxlength="120"
        @update:model-value="title" />
    </UiField>
    <p>{{ t('core.onboardingServerPath') }}</p>
    <UiInlineMessage v-if="locked" tone="warning">{{ t('core.onboardingPendingProject') }}</UiInlineMessage>
    <div v-for="repo in store.draft.repositories" :key="repo.name" class="repository">
      <UiField :label="t('core.onboardingFolder')">
        <UiInput :model-value="repo.source" :disabled="locked" :maxlength="1024"
          @update:model-value="source(repo.name, String($event ?? ''))" @blur="check(repo.name)" />
      </UiField>
      <div class="repository-actions">
        <UiButton wrap v-if="picker" :disabled="locked" @click="pick(repo.name)">
          {{ t('core.onboardingChooseFolder') }}
        </UiButton>
        <UiButton wrap v-if="store.draft.repositories.length > 1" :disabled="locked"
          variant="ghost" @click="remove(repo.name)">{{ t('core.onboardingRemoveFolder') }}</UiButton>
      </div>
      <p v-if="checks[repo.name]?.pending">{{ t('core.onboardingCheckingFolder') }}</p>
      <UiInlineMessage v-if="checks[repo.name]?.result?.reason" tone="warning">
        {{ t(checks[repo.name]?.result?.state === 'unborn'
          ? 'core.onboardingUnborn' : checks[repo.name]?.result?.state === 'detached'
            ? 'core.onboardingDetached' : 'core.onboardingInvalidFolder') }}
      </UiInlineMessage>
      <UiField :label="t('core.onboardingBranch')">
        <UiSelect :model-value="repo.baseBranch ?? ''" :disabled="locked || checks[repo.name]?.pending"
          @update:model-value="branch(repo.name, String($event ?? ''))">
          <option value="">{{ t('core.onboardingChooseBranch') }}</option>
          <option v-for="item in checks[repo.name]?.result?.branches ?? []"
            :key="item.name" :value="item.name" :disabled="!item.compatible">
            {{ item.name }}{{ !item.compatible ? ` — ${t('core.onboardingIncompatible')}` : '' }}
          </option>
        </UiSelect>
      </UiField>
    </div>
    <UiButton wrap :disabled="locked || store.draft.repositories.length >= 16" @click="add">
      {{ t('core.onboardingAddFolder') }}
    </UiButton>
    <UiInlineMessage v-if="pickerError" tone="warning">{{ t('core.onboardingPickerFailed') }}</UiInlineMessage>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';

import { t, UiButton, UiField, UiInput, UiSelect, UiInlineMessage } from '../../ui';
import type {
  OnboardingDraft, RepositoryInspection,
} from '../../../../shared/runtime/onboardingContracts.ts';
import { useOnboardingStore } from '../../stores/onboarding.ts';
import { useShellStore } from '../../stores/shell.ts';
import { inspectOnboardingRepository } from '../../shared/onboardingApi.ts';
import { shellAction } from '../../shared/shellClient.ts';

const emit = defineEmits<{ ready: [value: boolean] }>();
const store = useOnboardingStore();
const shell = useShellStore();
const checks = reactive<Record<string, {
  source: string;
  pending: boolean;
  result: RepositoryInspection | null;
}>>({});
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const pickerError = ref(false);
const locked = computed(() => !!store.snapshot?.active?.projectIntent);
const picker = computed(() => shell.present && shell.profile?.kind === 'local'
  && shell.capabilities.includes('selectDirectory'));
const ready = computed(() => !!store.draft?.title.trim() && store.draft.repositories.every((repo) => {
  const check = checks[repo.name];

  return !check?.pending && check?.result?.branches.some((item) =>
    item.compatible && item.name === repo.baseBranch);
}));
let alive = true;

/**
 * Каждая правка создаёт отдельный draft для очереди и сохраняет соседние ответы.
 * Имя строки стабильно и не зависит от удаления других папок.
 */
function edit(change: (draft: OnboardingDraft) => void): void {
  if (!store.draft || locked.value) {
    return;
  }

  const draft: OnboardingDraft = JSON.parse(JSON.stringify(store.draft));

  change(draft);
  store.update(draft);
}

function title(value: unknown): void {
  edit((draft) => {
    draft.title = String(value ?? '');
  });
}

/**
 * Новый путь сразу сбрасывает выбранную ветку и проверку предыдущего каталога.
 * Проверка склеивает ввод, autosave ответов при этом начинается сразу.
 */
function source(name: string, value: string): void {
  edit((draft) => {
    const repo = draft.repositories.find((item) => item.name === name);

    if (repo) {
      repo.source = value;
      repo.baseBranch = null;
    }
  });
  checks[name] = {
    source: value,
    pending: true,
    result: null,
  };
  clearTimeout(timers.get(name));
  timers.set(name, setTimeout(() => {
    void check(name);
  }, 200));
}

/**
 * Поздняя проверка применяется только к тому же пути, строке и подключению.
 * Текущая совместимая ветка выбирается при локальном вводе без явного ответа.
 * Фоновое обновление списка веток не записывает ответы из другого окна.
 */
async function check(name: string, selectCurrentBranch = true): Promise<void> {
  clearTimeout(timers.get(name));
  timers.delete(name);

  const repo = store.draft?.repositories.find((item) => item.name === name);
  const path = repo?.source;
  const scope = store.scope;

  if (!path || locked.value) {
    checks[name] = {
      source: path ?? '',
      pending: false,
      result: null,
    };

    return;
  }

  checks[name] = {
    source: path,
    pending: true,
    result: null,
  };

  try {
    const result = await inspectOnboardingRepository(path);
    const current = store.draft?.repositories.find((item) => item.name === name);

    if (!alive || store.scope !== scope || current?.source !== path) {
      return;
    }

    checks[name] = {
      source: path,
      pending: false,
      result,
    };

    if (selectCurrentBranch && !current.baseBranch && result.branches.some((item) => item.compatible
      && item.name === result.currentBranch)) {
      branch(name, result.currentBranch!);
    }
  } catch {
    if (alive && store.scope === scope
      && store.draft?.repositories.find((item) => item.name === name)?.source === path) {
      checks[name] = {
        source: path,
        pending: false,
        result: {
          state: 'invalid',
          currentBranch: null,
          branches: [],
          reason: 'request_failed',
        },
      };
    }
  }
}

function branch(name: string, value: string): void {
  edit((draft) => {
    const repo = draft.repositories.find((item) => item.name === name);

    if (repo) {
      repo.baseBranch = value || null;
    }
  });
}

/**
 * Удалённый номер строки не переиспользуется в текущем наборе ответов.
 * Ограничение количества совпадает с будущим образцом профиля.
 */
function add(): void {
  edit((draft) => {
    let number = 1;

    while (draft.repositories.some((repo) => repo.name === `repo${number}`)) {
      number += 1;
    }

    draft.repositories.push({
      name: `repo${number}`,
      source: '',
      baseBranch: null,
    });
  });
}

function remove(name: string): void {
  edit((draft) => {
    draft.repositories = draft.repositories.filter((repo) => repo.name !== name);
  });
}

/**
 * Только local-capability открывает системный диалог без начального пути или URL.
 * Отмена и смена машины оставляют введённый серверный путь без изменений.
 */
async function pick(name: string): Promise<void> {
  const scope = store.scope;
  const profileId = shell.profile?.id;

  if (!picker.value || !profileId) {
    return;
  }

  try {
    const result = await shellAction('POST', '/directory/select', { profileId });
    const selected = result as { path?: unknown };

    if (alive && store.scope === scope && shell.profile?.id === profileId
      && typeof selected.path === 'string') {
      source(name, selected.path);
      await check(name);
    }
  } catch {
    pickerError.value = true;
  }
}

/**
 * Черновик из другого окна приносит пути и выбранные ветки, но не результаты проверки Git.
 * Перечитываем только изменившиеся папки, сохраняя ответы сервера без встречного autosave.
 */
function synchronizeRepositories(): void {
  const repositories = store.draft?.repositories ?? [];

  for (const name of Object.keys(checks)) {
    if (!repositories.some((repo) => repo.name === name)) {
      clearTimeout(timers.get(name));
      timers.delete(name);
      delete checks[name];
    }
  }

  for (const repo of repositories) {
    if (checks[repo.name]?.source !== repo.source) {
      void check(repo.name, false);
    }
  }
}

watch(() => store.draft?.repositories.map(({ name, source }) => [name, source]), synchronizeRepositories);
watch(ready, (value) => emit('ready', !!value), { immediate: true });
onMounted(() => {
  for (const repo of store.draft?.repositories ?? []) {
    void check(repo.name);
  }
});
onBeforeUnmount(() => {
  alive = false;

  for (const timer of timers.values()) {
    clearTimeout(timer);
  }
});
</script>

<style scoped>
.repository {
  display: grid;
  gap: 12px;
  margin: 24px 0;
  min-width: 0;
}

.repository-actions {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}
</style>
