<template>
  <section class="factory-config" data-test="factory-config" :data-profile="detail.id">
    <UiDisclosureButton v-model:open="expanded" :controls="bodyId" density="compact">
      {{ t('core.projectKonfiguratsiyaFabriki') }}
    </UiDisclosureButton>
    <div v-show="expanded" :id="bodyId" class="factory-config__body">
      <p v-if="session?.loading" role="status">{{ t('core.loading') }}</p>
      <p v-if="session?.loadError" class="bad" role="alert">{{ session.loadError }}</p>
      <p v-if="session?.saveError" class="bad" role="alert">{{ session.saveError }}</p>
      <p v-if="session?.notice === 'conflict'" data-test="config-conflict" role="status">
        {{ t('core.projectConfigConflict') }}
      </p>
      <p v-if="session?.notice === 'partial'" data-test="config-partial" role="status">
        {{ t('core.projectConfigPartial', { count: session.applied }) }}
      </p>
      <p v-if="session?.notice === 'unknown'" role="status">{{ t('core.projectConfigUnknown') }}</p>
      <p v-if="session?.notice === 'interrupted'" role="status">{{ t('core.projectConfigInterrupted') }}</p>
      <p v-if="session?.notice === 'saved'" role="status">{{ t('core.projectConfigSaved') }}</p>
      <template v-if="session?.snapshot">
        <p data-test="profile-capabilities">
          {{ t('core.projectConfigCapabilities') }}: {{ session.snapshot.capabilities.join(', ') || '—' }}
        </p>
        <UiField v-for="row in model.rows" :key="row.id" :label="rowLabel(row)"
                 data-context="workspace-property">
          <template v-if="row.editable">
            <UiInput :model-value="session.edits[row.id] ?? row.value ?? ''"
                     :disabled="locked" :data-test="`field-${row.name}`"
                     @update:model-value="edit(row, String($event ?? ''))" />
            <span class="factory-config__fact" :data-test="`fact-${row.name}`">
              {{ t('core.projectConfigActual') }}: {{ display(row.value) }}
            </span>
          </template>
          <span v-else :data-test="`readonly-${row.name}`">
            {{ display(row.value) }} — {{ readonlyReason(row) }}
          </span>
        </UiField>
        <ul v-if="plan?.blocked.length" class="factory-config__blocked" role="status">
          <li v-for="id in plan.blocked" :key="id">
            {{ id }}: {{ session.edits[id] }} — {{ t('core.projectConfigPendingUnavailable') }}
          </li>
        </ul>
      </template>
      <UiFormActions>
        <UiButton data-test="reload-config" data-context="workspace-form" :disabled="busy"
                  @click="session && reload(session)">{{ t('core.projectConfigReload') }}</UiButton>
        <UiButton data-test="discard-config" data-context="workspace-form" :disabled="locked || !dirty"
                  @click="discard">{{ t('core.projectConfigDiscard') }}</UiButton>
        <UiButton data-test="apply-config" data-context="workspace-form" :disabled="!canApply"
                  :loading="session?.saving" @click="openSummary">
          {{ t('core.projectPrimenitIzmeneniya') }}
        </UiButton>
      </UiFormActions>
    </div>
    <UiDialog :open="Boolean(confirmation)" :title="t('core.projectChtoIzmenitsya')"
              :busy="session?.saving" :persistent="session?.saving" size="content"
              @update:open="closeSummary">
      <ul data-test="config-summary" class="factory-config__summary">
        <li v-for="(row, index) in confirmation?.plan.summary ?? []" :key="index">
          {{ row.name }}: {{ display(row.before) }} → {{ display(row.after) }}
        </li>
      </ul>
      <template #footer>
        <UiFormActions>
          <UiButton :disabled="session?.saving" @click="closeSummary(false)">
            {{ t('core.cancel') }}
          </UiButton>
          <UiButton data-test="confirm-config" tone="accent" :disabled="locked"
                    :loading="session?.saving" @click="confirm">
            {{ t('core.projectPodtverditZapisi') }}
          </UiButton>
        </UiFormActions>
      </template>
    </UiDialog>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, shallowRef, useId, watch } from 'vue';

import { isRecord } from '../../../../shared/lib/objects.ts';
import { failureText } from '../../shared/apiClient.ts';
import {
  fetchProfileConfig, patchProfileRunners, patchProfileVariables,
} from '../../shared/profileConfigApi.ts';
import type { ProfileConfigView } from '../../shared/profileConfigApi.ts';
import {
  configFormModel, configSavePlan, reconcileConfigEdits,
} from './profileConfigForm.ts';
import type { ConfigFormRow, ConfigSavePlan } from './profileConfigForm.ts';
import {
  UiButton, UiDialog, UiDisclosureButton, UiField, UiFormActions, UiInput, t,
} from '../../ui';

interface ConfigSession {
  profile: string;
  snapshot: ProfileConfigView | null;
  edits: Record<string, string>;
  loading: boolean;
  saving: boolean;
  needsRefresh: boolean;
  readVersion: number;
  loadError: string;
  saveError: string;
  notice: '' | 'saved' | 'conflict' | 'partial' | 'unknown' | 'interrupted';
  applied: number;
}

const props = defineProps<{ detail: { id: string }; readonly?: boolean }>();
const sessions = new Map<string, ConfigSession>();
const session = shallowRef<ConfigSession | null>(null);
const expanded = ref(true);
const bodyId = `factory-config-${useId()}`;
const confirmation = shallowRef<{ session: ConfigSession; plan: ConfigSavePlan } | null>(null);
let selectionVersion = 0;
let alive = true;

const model = computed(() => session.value?.snapshot
  ? configFormModel(session.value.snapshot) : { rows: [], groups: [] });
const plan = computed(() => session.value?.snapshot
  ? configSavePlan(session.value.snapshot, session.value.edits) : null);
const dirty = computed(() => Object.keys(session.value?.edits ?? {}).length > 0);
const busy = computed(() => Boolean(session.value?.loading || session.value?.saving));
const locked = computed(() => Boolean(props.readonly || busy.value));
const canApply = computed(() => !locked.value && !session.value?.needsRefresh
  && Boolean(plan.value?.summary.length) && plan.value?.blocked.length === 0);

function display(value: string | null): string {
  return value === null ? t('core.projectConfigAbsent') : value || t('core.projectConfigEmpty');
}

function rowLabel(row: ConfigFormRow): string {
  return row.file ? `${row.file}: ${row.name}` : row.name;
}

/**
 * Read-only причина относится к типу ограничения, а не к динамическому тексту
 * shell. Серверный код причины никогда не интерпретируется как ключ перевода.
 */
function readonlyReason(row: ConfigFormRow): string {
  if (row.reason === 'runner') {
    return t('core.projectConfigRunnerReadonly');
  }
  if (row.reason === 'file') {
    return t('core.projectConfigFileReadonly');
  }

  return t('core.projectConfigVariableReadonly');
}

/**
 * Ввод хранится как намерение отдельно от серверного снимка. Пустая строка
 * для отсутствующей переменной — намерение создать её, а не отсутствие правки.
 */
function edit(row: ConfigFormRow, value: string): void {
  const current = session.value;

  if (!current || locked.value || !row.editable) {
    return;
  }
  if (row.value === value) {
    delete current.edits[row.id];
  } else {
    current.edits[row.id] = value;
  }
}

/**
 * Перечитывание обновляет факт, сохраняя неприменённое намерение. Последний
 * запрос выигрывает только внутри своей сессии; ответ чужого профиля не смешивается.
 */
async function reload(current: ConfigSession): Promise<void> {
  const version = ++current.readVersion;

  current.loading = true;
  current.loadError = '';

  try {
    const snapshot = await fetchProfileConfig(current.profile);

    if (!alive || version !== current.readVersion) {
      return;
    }

    current.edits = reconcileConfigEdits(snapshot, current.edits);
    current.snapshot = snapshot;
    current.needsRefresh = false;
  } catch (error) {
    if (alive && version === current.readVersion) {
      current.loadError = failureText(error, t('core.projectConfigReadError'));
      current.needsRefresh = true;
    }
  } finally {
    if (alive && version === current.readVersion) {
      current.loading = false;
    }
  }
}

/**
 * Смена профиля выбирает отдельную сессию ввода и закрывает старую сводку.
 * Уже отправленная операция завершается в своей сессии, новые записи не следуют.
 */
function selectProfile(profile: string): void {
  selectionVersion += 1;
  confirmation.value = null;


  let current = sessions.get(profile);

  if (!current) {
    current = reactive<ConfigSession>({
      profile,
      snapshot: null,
      edits: {},
      loading: false,
      saving: false,
      needsRefresh: true,
      readVersion: 0,
      loadError: '',
      saveError: '',
      notice: '',
      applied: 0,
    });
    sessions.set(profile, current);
  }

  session.value = current;

  if (!current.saving) {
    void reload(current);
  }
}

/**
 * Сводка фиксирует payload до подтверждения; последующая смена сессии
 * или readonly отменяет подтверждение, не отправляя скрытые новые значения.
 */
function openSummary(): void {
  if (canApply.value && session.value && plan.value) {
    confirmation.value = { session: session.value, plan: plan.value };
  }
}

function closeSummary(open: boolean): void {
  if (!open && !session.value?.saving) {
    confirmation.value = null;
  }
}

function discard(): void {
  if (session.value && !locked.value) {
    session.value.edits = {};
    confirmation.value = null;
  }
}

/**
 * Отправляет подтверждённый снимок последовательно. При любом отказе
 * перечитывает факт и сохраняет остаток; unknown outcome не повторяет автоматически.
 */
async function confirm(): Promise<void> {
  const accepted = confirmation.value;

  if (!accepted || !canApply.value || accepted.session !== session.value) {
    return;
  }

  const current = accepted.session;
  const version = selectionVersion;
  const stillSelected = (): boolean => alive && selectionVersion === version
    && session.value === current && !props.readonly;

  current.saving = true;
  current.needsRefresh = true;
  current.saveError = '';
  current.notice = '';
  current.applied = 0;

  try {
    for (const batch of accepted.plan.variables) {
      if (!stillSelected()) {
        current.notice = 'interrupted';

        return;
      }

      await patchProfileVariables(current.profile, batch.file, batch.changes);
    }

    if (!stillSelected()) {
      current.notice = 'interrupted';

      return;
    }
    if (accepted.plan.operations.length) {
      await patchProfileRunners(current.profile, accepted.plan.operations);
    }

    current.notice = 'saved';
  } catch (error) {
    const status = isRecord(error) ? error.status : undefined;
    const data = isRecord(error) && isRecord(error.data) ? error.data : null;
    const applied = data?.appliedOperations;

    current.applied = typeof applied === 'number' && Number.isSafeInteger(applied) && applied >= 0
      ? applied : 0;
    current.notice = status === 409 ? 'conflict'
      : status === 502 && typeof applied === 'number' ? 'partial' : 'unknown';
    current.saveError = failureText(error, t('core.projectConfigWriteError'));
  } finally {
    if (confirmation.value === accepted) {
      confirmation.value = null;
    }
    if (alive) {
      await reload(current);
    }

    current.saving = false;
  }
}

watch(() => props.detail.id, selectProfile, { immediate: true });
watch(() => props.readonly, (readonly) => {
  if (readonly) {
    // Возврат доступа не возобновляет прежнюю цепочку после pending PATCH.
    selectionVersion += 1;

    if (!session.value?.saving) {
      confirmation.value = null;
    }
  }
});
onBeforeUnmount(() => {
  alive = false;
  selectionVersion += 1;
});
</script>

<style scoped>
.factory-config,
.factory-config__body {
  display: grid;
  gap: 8px;
  min-width: 0;
}

.factory-config p {
  margin: 0;
  overflow-wrap: anywhere;
}

.factory-config__fact {
  display: block;
  color: var(--ink-mid);
  overflow-wrap: anywhere;
}

.factory-config__summary,
.factory-config__blocked {
  margin: 0;
  padding-inline-start: 20px;
  overflow-wrap: anywhere;
}
</style>
