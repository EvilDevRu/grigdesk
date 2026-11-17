<template>
  <UiDialog :open="true" :title="profile ? t('settings.accessProfilesEdit')
    : t('settings.accessProfilesAdd')" size="compact"
    data-ui-workspace :busy="pending" :dismissible="!pending" @close="cancel">
    <div class="access-profile-form">
      <p v-if="store.errors[providerId]" role="alert">{{ store.errors[providerId] }}</p>
      <template v-if="!attempt">
        <UiField :label="t('settings.accessProfilesProfileName')">
          <UiInput v-model="name" :disabled="pending"
            :aria-label="t('settings.accessProfilesProfileName')" />
        </UiField>
        <UiField :label="t('settings.accessProfilesMethod')">
          <UiSelect v-model="methodId" :disabled="pending || !!profile || !!recoveryMethodId"
            :aria-label="t('settings.accessProfilesMethod')">
            <option v-for="item in methods" :key="item.id" :value="item.id">{{ item.label }}</option>
          </UiSelect>
        </UiField>
        <p v-if="method?.limitation">{{ method.limitation }}</p>
        <UiField v-for="field in initialFields" :key="field.id" :label="field.label"
          :hint="profile && field.kind === 'secret' ? t('settings.accessProfilesKeepKey') : undefined">
          <UiPasswordInput v-if="field.kind === 'secret'" :model-value="draft.get(field.id)"
            :aria-label="field.label" autocomplete="new-password" :disabled="pending"
            @update:model-value="draft.set(field.id, String($event ?? ''))" />
          <UiInput v-else :model-value="draft.get(field.id)" :aria-label="field.label" :disabled="pending"
            @update:model-value="draft.set(field.id, String($event ?? ''))" />
        </UiField>
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
    </div>
    <template #footer>
      <UiButton data-context="workspace-form-wrap" :disabled="pending" @click="cancel">
        {{ attempt?.state === 'saved' ? t('settings.accessProfilesClose') : t('settings.accessProfilesCancel') }}
      </UiButton>
      <UiButton v-if="!attempt || ['fields', 'enter-code'].includes(attempt.step.kind)"
        data-context="workspace-form-wrap" variant="solid" tone="accent"
        :disabled="pending || !draftReady || !canProceed" @click="proceed">
        {{ !attempt && (profile || initialFields.length) ? t('settings.accessProfilesSave')
          : t('settings.accessProfilesContinue') }}
      </UiButton>
      <UiButton v-if="attempt?.step.kind === 'choice'" data-context="workspace-form-wrap"
        variant="solid" tone="accent" :disabled="pending" @click="confirm">
        {{ t('settings.accessProfilesConfirm') }}
      </UiButton>
      <UiButton v-if="attempt && ['failed', 'expired', 'interrupted'].includes(attempt.state)"
        data-context="workspace-form-wrap" variant="solid" tone="accent"
        :disabled="pending" @click="retry">{{ t('settings.accessProfilesRetry') }}</UiButton>
    </template>
  </UiDialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import type { AccessAttempt, AccessProfile } from '../../../shared/chat/accessProfileContracts.ts';
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
  reauthenticate?: boolean;
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
const submitting = ref(false);
const name = computed({ get: () => draft.get('name'), set: (value) => draft.set('name', value) });
const methodId = computed({ get: () => props.recoveryMethodId ?? draft.get('methodId'),
  set: (value) => draft.set('methodId', value) });

void draft.ready.then(() => {
  draftReady.value = true;
});

const attempt = computed(() => store.attempts[props.providerId]);
const method = computed(() => methods.value.find((item) =>
  item.id === (attempt.value?.methodId ?? methodId.value)));
const pending = computed(() => submitting.value || store.pending[props.providerId]);
const initialFields = computed(() => method.value?.kind === 'api-key' ? method.value.fields : []);
const canProceed = computed(() => {
  if (attempt.value) {
    return true;
  }

  return !!name.value.trim() && !!method.value
    && (!!props.profile || initialFields.value.every((field) => !!draft.get(field.id).trim()));
});
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
 * Пустой ключ существующего профиля оставляет доступ нетронутым: меняется только имя.
 * Новый ключ проходит прежние серверные шаги; имя применяется вместе с подтверждённым доступом.
 */
async function proceed() {
  if (pending.value || !canProceed.value) {
    return;
  }

  submitting.value = true;

  try {
    await draft.ready;

    const current = attempt.value;

    if (current) {
      const fields = current.step.kind === 'enter-code' ? [{ id: 'code' }]
        : current.step.fields ?? method.value?.fields ?? [];
      const input = Object.fromEntries(fields.map((field) => [field.id, draft.get(field.id)]));

      clearInputs();
      await submitFields(current, input);

      return;
    }

    const input = Object.fromEntries(initialFields.value.map((field) => [field.id, draft.get(field.id)]));
    const hasInput = Object.values(input).some((value) => !!value.trim());

    if (props.profile && !hasInput && !(props.reauthenticate && method.value?.kind === 'cli')) {
      if (name.value.trim() !== props.profile.name) {
        await store.mutate(props.providerId, `/${props.profile.id}`, {
          name: name.value,
          expectedRevision: props.profile.revision,
        }, 'PATCH');
      }

      if (!store.errors[props.providerId]) {
        draft.clear();
        emit('close');
      }

      return;
    }

    clearInputs();
    await store.mutate(props.providerId, '/attempts', {
      name: name.value,
      methodId: methodId.value,
      ...(props.profile ? {
        profileId: props.profile.id,
        expectedRevision: props.profile.revision,
      } : {}),
    });

    const created = store.attempts[props.providerId];

    if (!created || store.errors[props.providerId] || store.unresolved[props.providerId]) {
      return;
    }

    draft.discard('name');
    draft.discard('methodId');

    if (hasInput && created.step.kind === 'fields') {
      await submitFields(created, input);
    }
  } finally {
    submitting.value = false;
  }
}

/**
 * Ввод отправляется единственному серверному шагу с его ревизией.
 * Секреты уже удалены из черновика и не сохраняются для повторной доставки.
 */
async function submitFields(current: AccessAttempt, input: Record<string, string>) {
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
  if (pending.value) {
    return;
  }

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

<style scoped>
.access-profile-form {
  display: grid;
  gap: 12px;
}
.access-profile-form p {
  margin: 0;
}
</style>
