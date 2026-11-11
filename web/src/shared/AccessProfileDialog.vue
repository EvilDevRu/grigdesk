<template>
  <UiDialog :open="true" :title="profile ? t('settings.accessProfilesRestore')
    : t('settings.accessProfilesAdd')" size="compact"
    @close="emit('close')">
    <p v-if="store.errors[providerId]" role="alert">{{ store.errors[providerId] }}</p>
    <template v-if="!attempt">
      <UiField :label="t('settings.accessProfilesProfileName')">
        <UiInput v-model="name" :aria-label="t('settings.accessProfilesProfileName')" />
      </UiField>
      <UiField :label="t('settings.accessProfilesMethod')">
        <UiSelect v-model="methodId" :disabled="!!profile || !!recoveryMethodId"
          :aria-label="t('settings.accessProfilesMethod')">
          <option v-for="item in methods" :key="item.id" :value="item.id">{{ item.label }}</option>
        </UiSelect>
      </UiField>
      <p v-if="method?.limitation">{{ method.limitation }}</p>
    </template>
    <template v-else>
      <p>{{ attempt.name }}</p>
      <p v-if="attempt.step.kind === 'choice'">{{ choiceMessage }}</p>
      <p v-else-if="attempt.state === 'saved'">{{ t('settings.accessProfilesSaved') }}</p>
      <p v-else-if="attempt.error" role="alert">{{ t(accessProfileErrorKey(attempt.error.code)) }}</p>
      <p v-else-if="attempt.step.kind === 'waiting'">{{ t('settings.accessProfilesWaiting') }}</p>
      <p v-else-if="attempt.step.kind === 'verifying'">{{ t('settings.accessProfilesVerifying') }}</p>
      <p v-else-if="attempt.step.kind === 'result'">{{ attempt.step.message }}</p>
      <UiActionLink v-if="safeUrl" :href="safeUrl" target="_blank" rel="noopener noreferrer">
        {{ t('settings.accessProfilesAuthorize') }}
      </UiActionLink>
      <template v-if="attempt.step.kind === 'display-code'">
        <p>{{ t('settings.accessProfilesCodeToSite') }}</p>
        <p>{{ attempt.step.code }}</p>
        <UiButton @click="copyCode">{{ t('settings.accessProfilesCopy') }}</UiButton>
      </template>
      <UiField v-if="attempt.step.kind === 'enter-code'"
        :label="attempt.step.label ?? t('settings.accessProfilesCodeFromSite')">
        <UiPasswordInput :model-value="draft.get('code')"
          :aria-label="attempt.step.label ?? t('settings.accessProfilesCodeFromSite')"
          autocomplete="off" @update:model-value="draft.set('code', String($event ?? ''))" />
      </UiField>
      <template v-if="attempt.step.kind === 'fields'">
        <UiField v-for="field in attempt.step.fields ?? method?.fields ?? []" :key="field.id"
          :label="field.label">
          <UiPasswordInput v-if="field.kind === 'secret'" :model-value="draft.get(field.id)"
            :aria-label="field.label" autocomplete="new-password"
            @update:model-value="draft.set(field.id, String($event ?? ''))" />
          <UiInput v-else :model-value="draft.get(field.id)" :aria-label="field.label"
            @update:model-value="draft.set(field.id, String($event ?? ''))" />
        </UiField>
      </template>
    </template>
    <template #footer>
      <UiButton v-if="!attempt || ['fields', 'enter-code'].includes(attempt.step.kind)"
        :disabled="pending || !draftReady" @click="proceed">{{ t('settings.accessProfilesContinue') }}</UiButton>
      <UiButton v-if="attempt?.step.kind === 'choice'" :disabled="pending" @click="confirm">
        {{ t('settings.accessProfilesConfirm') }}
      </UiButton>
      <UiButton v-if="attempt && ['failed', 'expired', 'interrupted'].includes(attempt.state)"
        :disabled="pending" @click="retry">{{ t('settings.accessProfilesRetry') }}</UiButton>
      <UiButton :disabled="pending" @click="cancel">{{ t('settings.accessProfilesCancel') }}</UiButton>
    </template>
  </UiDialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import type { AccessProfile } from '../../../shared/chat/accessProfileContracts.ts';
import { UiActionLink, UiButton, UiDialog, UiField, UiInput, UiPasswordInput, UiSelect, t } from '../ui.ts';
import { useAccessProfilesStore } from '../stores/accessProfiles.ts';
import { api } from './apiClient.ts';
import { useSettingsStore } from '../stores/settings.ts';
import { accessProfileDraft } from '../features/settings/accessProfileDraft.ts';
import { accessProfileErrorKey } from './accessProfileMessages.ts';

const props = defineProps<{
  providerId: string;
  profile?: AccessProfile;
  recoveryMethodId?: string;
}>();
const emit = defineEmits<{ close: [] }>();
const store = useAccessProfilesStore();
const methods = computed(() => store.lists[props.providerId]?.methods ?? []);
const settings = useSettingsStore();
const draft = accessProfileDraft(settings, props.providerId, props.profile?.id ?? 'new', methods.value, {
  name: props.profile?.name ?? '',
  methodId: props.profile?.methodId ?? methods.value[0]?.id ?? '',
});
const draftReady = ref(false);
const name = computed({ get: () => draft.get('name'), set: (value) => draft.set('name', value) });
const methodId = computed({ get: () => props.recoveryMethodId ?? draft.get('methodId'),
  set: (value) => draft.set('methodId', value) });

void draft.ready.then(() => {
  draftReady.value = true;
});

const attempt = computed(() => store.attempts[props.providerId]);
const method = computed(() => methods.value.find((item) =>
  item.id === (attempt.value?.methodId ?? methodId.value)));
const pending = computed(() => store.pending[props.providerId]);
const choiceMessage = computed(() => attempt.value?.step.reason === 'account_unknown'
  ? t('settings.accessProfilesAccountUnknown') : attempt.value?.step.reason === 'account_mismatch'
    ? t('settings.accessProfilesAccountMismatch') : attempt.value?.step.message);
const safeUrl = computed(() => {
  try {
    const url = new URL(attempt.value?.step.url ?? '');

    return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
  } catch {
    return '';
  }
});

/**
 * Секретный ввод принадлежит только экземпляру окна, вне Pinia и storage.
 * Потеря входа и смена шага удаляют его до следующего действия человека.
 */
function clearInputs() {
  draft.clear(true);
}

/**
 * Создание и ввод являются отдельными идемпотентными операциями.
 * Серверное сохранение не вызывает автоматическую активацию.
 */
async function proceed() {
  if (pending.value) {
    return;
  }

  const current = attempt.value;

  if (!current) {
    await draft.ready;
    await store.mutate(props.providerId, '/attempts', {
      name: name.value,
      methodId: methodId.value,
      ...(props.profile ? { profileId: props.profile.id } : {}),
    });

    if (store.attempts[props.providerId]) {
      draft.discard('name');
      draft.discard('methodId');
    }

    return;
  }

  const fields = current.step.kind === 'enter-code' ? [{ id: 'code' }]
    : current.step.fields ?? method.value?.fields ?? [];
  const input = Object.fromEntries(fields.map((field) => [field.id, draft.get(field.id)]));

  clearInputs();
  await store.mutate(props.providerId, `/attempts/${current.id}/steps/${current.step.id}`, {
    expectedRevision: current.revision,
    input,
  });
}

/**
 * Подтверждение связано с точным шагом, восстановленным с сервера.
 * Неизвестность аккаунта не превращается в клиентский флаг успешного входа.
 */
async function confirm() {
  const current = attempt.value;

  if (current) {
    await store.mutate(props.providerId, `/attempts/${current.id}/steps/${current.step.id}`, {
      expectedRevision: current.revision,
      input: { choice: 'confirm' },
    });
  }
}

/**
 * Отмена сначала подтверждается сервером; закрытие окна не считается успехом login.
 * Уже сохранённый результат остаётся доступным в списке без повторной мутации.
 */
async function cancel() {
  draft.clear();

  if (store.unresolved[props.providerId]) {
    await store.load(props.providerId);

    if (store.unresolved[props.providerId]) {
      return;
    }
  }

  const current = attempt.value;

  if (current && !['saved', 'failed', 'expired', 'interrupted', 'cancelled'].includes(current.state)) {
    await store.mutate(props.providerId, `/attempts/${current.id}/cancel`, {
      expectedRevision: current.revision,
    });

    if (!['saved', 'failed', 'expired', 'interrupted', 'cancelled'].includes(attempt.value?.state ?? '')) {
      return;
    }
  }

  emit('close');
}

async function retry() {
  await store.mutate(props.providerId, `/attempts/${attempt.value?.id}/retry`, {});
}

async function copyCode() {
  await navigator.clipboard.writeText(attempt.value?.step.code ?? '');
}

settings.bindSession(`access-profile-input:${props.providerId}:${props.profile?.id ?? 'new'}`,
  () => api.onUnauthorized(clearInputs));

watch(() => attempt.value?.step.id, clearInputs);
</script>
