<template>
  <section>
    <p v-if="store.errors[providerId]" role="alert">{{ store.errors[providerId] }}</p>
    <UiButton v-if="store.errors[providerId]" @click="store.load(providerId)">
      {{ t('settings.accessProfilesRetry') }}
    </UiButton>
    <p v-if="!list">{{ t('settings.accessProfilesLoading') }}</p>
    <template v-else>
      <p v-if="!list.profiles.length">{{ t('settings.accessProfilesEmpty') }}</p>
      <div v-for="profile in list.profiles" :key="profile.id">
        <span>{{ profile.name }}</span>
        <span v-if="profile.id === list.activeProfileId"> · {{ t('settings.accessProfilesActive') }}</span>
        <span v-if="profile.authState === 'needs-auth'"> · {{ t('settings.accessProfilesNeedsAuth') }}</span>
        <UiButton :disabled="pending || profile.id === list.activeProfileId"
          @click="activate(profile.id)">{{ t('settings.accessProfilesActivate') }}</UiButton>
        <UiButton :disabled="pending" @click="rename(profile)">
          {{ t('settings.accessProfilesRename') }}
        </UiButton>
        <UiButton :disabled="pending" @click="begin(profile)">
          {{ t('settings.accessProfilesRestore') }}
        </UiButton>
        <UiButton :disabled="pending || profile.id === list.activeProfileId" @click="remove(profile)">
          {{ t('settings.accessProfilesDelete') }}
        </UiButton>
      </div>
    </template>
    <UiButton :disabled="pending || !list" @click="begin()">{{ t('settings.accessProfilesAdd') }}</UiButton>
    <AccessProfileDialog v-if="wizard" :key="`${providerId}:${editing?.id ?? 'new'}`"
      :provider-id="providerId" :profile="editing" :recovery-method-id="recovery?.methodId"
      @close="wizard = false" />
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import type { AccessProfile } from '../../../shared/chat/accessProfileContracts.ts';
import { UiButton, confirmDialog, promptDialog, t } from '../ui.ts';
import { useAccessProfilesStore } from '../stores/accessProfiles.ts';
import { useSse } from '../composables/useSse.ts';
import AccessProfileDialog from './AccessProfileDialog.vue';

const props = defineProps<{ providerId: string }>();
const store = useAccessProfilesStore();
const list = computed(() => store.lists[props.providerId]);
const pending = computed(() => store.pending[props.providerId]);
const wizard = ref(false);
const editing = ref<AccessProfile>();
const recovery = computed(() => {
  const operation = store.unresolved[props.providerId];

  if (operation?.route !== '/attempts') {
    return null;
  }

  try {
    const [profileId, methodId] = JSON.parse(operation.target) as unknown[];

    return {
      profileId: typeof profileId === 'string' ? profileId : null,
      methodId: typeof methodId === 'string' ? methodId : '',
    };
  } catch {
    return null;
  }
});

/**
 * Восстановление шага использует общий SSE и серверную попытку.
 * Переход между исполнителями не переносит секреты или попытки другому владельцу.
 */
async function reload() {
  await store.load(props.providerId);

  if (store.attempts[props.providerId]) {
    editing.value = list.value?.profiles.find((item) =>
      item.id === store.attempts[props.providerId]?.profileId);
    wizard.value = true;
  }
}

/**
 * Другой мастер не получает попытку профиля с потерянным ответом.
 * Сначала восстанавливается исходный владелец шага, затем разрешается новый ввод.
 */
async function begin(profile?: AccessProfile) {
  await store.load(props.providerId);

  const current = store.attempts[props.providerId];
  const running = current
    && !['saved', 'failed', 'cancelled', 'expired', 'interrupted'].includes(current.state);

  if (!running && store.unresolved[props.providerId]) {
    if (recovery.value && list.value) {
      editing.value = list.value.profiles.find((item) => item.id === recovery.value?.profileId);
      wizard.value = !recovery.value.profileId || !!editing.value;
    }

    return;
  }

  if (!running && store.errors[props.providerId]) {
    return;
  }

  editing.value = running ? list.value?.profiles.find((item) => item.id === current.profileId) : profile;

  if (!running) {
    store.attempts[props.providerId] = null;
  }

  wizard.value = true;
}

async function activate(id: string) {
  await store.mutate(props.providerId, `/${id}/activate`, { expectedRevision: list.value?.revision });
}

/**
 * Имя меняется отдельной CAS-операцией и не переписывает доступ.
 * Общий диалог сохраняет единое поведение клавиатуры и мобильного окна.
 */
async function rename(profile: AccessProfile) {
  const name = await promptDialog({
    title: t('settings.accessProfilesProfileName'),
    text: t('settings.accessProfilesProfileName'),
    value: profile.name,
    okText: t('settings.accessProfilesSave'),
  });

  if (name !== null) {
    await store.mutate(props.providerId, `/${profile.id}`, {
      name,
      expectedRevision: profile.revision,
    }, 'PATCH');
  }
}

/**
 * Сервер повторно проверяет использование профиля после подтверждения удаления.
 * Диалог не даёт обойти CAS конкурентного окна.
 */
async function remove(profile: AccessProfile) {
  if (await confirmDialog(t('settings.accessProfilesDeleteQuestion'), {
    okText: t('settings.accessProfilesDelete'),
  })) {
    await store.mutate(props.providerId, `/${profile.id}`, {
      expectedRevision: profile.revision,
    }, 'DELETE');
  }
}

watch(() => props.providerId, reload, { immediate: true });
watch(() => store.attempts[props.providerId]?.id, () => {
  const current = store.attempts[props.providerId];

  if (current) {
    editing.value = list.value?.profiles.find((item) => item.id === current.profileId);
  }
});
useSse((name) => {
  if (name === 'hello' || name === 'providers-update' || name === 'access-profiles') {
    void store.load(props.providerId);
  }
});
</script>
