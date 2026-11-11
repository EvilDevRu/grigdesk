<template>
  <section class="access-profiles" :aria-label="t('settings.accessProfilesConnections')">
    <header class="access-profiles-header">
      <div class="access-profiles-heading">
        <h5>{{ t('settings.accessProfilesConnections') }}</h5>
        <p>{{ t('settings.accessProfilesScope') }}</p>
      </div>
      <UiButton size="compact" :disabled="pending || !list"
        :aria-label="t('settings.accessProfilesAdd')" @click="begin()">
        <template #leading><span aria-hidden="true">+</span></template>
        {{ t('settings.accessProfilesAdd') }}
      </UiButton>
    </header>
    <UiInlineMessage v-if="store.errors[providerId]" tone="danger" :heading="store.errors[providerId]">
      <template #actions>
        <UiButton :disabled="pending" @click="store.load(providerId)">
          {{ t('settings.accessProfilesRetry') }}
        </UiButton>
      </template>
    </UiInlineMessage>
    <p v-if="!list" class="access-profiles-note">{{ t('settings.accessProfilesLoading') }}</p>
    <template v-else>
      <p v-if="!list.profiles.length" class="access-profiles-empty">{{ t('settings.accessProfilesEmpty') }}</p>
      <article v-for="profile in list.profiles" :key="profile.id" class="access-profile-card"
        :class="{ 'is-active': profile.id === list.activeProfileId }" :data-profile-id="profile.id">
        <div class="access-profile-summary">
          <div class="access-profile-identity">
            <h6>{{ profile.name }}</h6>
            <span v-if="profile.id === list.activeProfileId" class="access-profile-active">
              <span aria-hidden="true">✓</span> {{ t('settings.accessProfilesActive') }}
            </span>
          </div>
          <p class="access-profile-method">{{ methodLabel(profile) }}</p>
          <p v-if="profile.authState === 'needs-auth'" class="access-profile-warning">
            {{ t('settings.accessProfilesNeedsAuth') }}
          </p>
        </div>
        <div class="access-profile-actions">
          <UiButton v-if="profile.id !== list.activeProfileId" size="compact"
            :disabled="pending || !list.switchAllowed || !!store.errors[providerId]"
            variant="outline" tone="accent" @click="activate(profile.id)">
            {{ t('settings.accessProfilesActivate') }}
          </UiButton>
          <div class="access-profile-tools">
            <UiIconButton size="compact" :disabled="pending" :label="t('settings.accessProfilesRestore')"
              v-tooltip="t('settings.accessProfilesRestore')"
              :tone="profile.authState === 'needs-auth' ? 'warning' : 'neutral'" @click="begin(profile)">
              <UiRefreshIcon />
            </UiIconButton>
            <UiIconButton size="compact" :disabled="pending" :label="t('settings.accessProfilesRename')"
              v-tooltip="t('settings.accessProfilesRename')" @click="rename(profile)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
                stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="m16 3 5 5-12 12-6 1 1-6Z M13 6l5 5" />
              </svg>
            </UiIconButton>
            <UiIconButton v-if="profile.id !== list.activeProfileId" size="compact"
              :disabled="pending" tone="danger"
              :label="t('settings.accessProfilesDelete')" v-tooltip="t('settings.accessProfilesDelete')"
              @click="remove(profile)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
                stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7" />
              </svg>
            </UiIconButton>
          </div>
        </div>
      </article>
      <p v-if="!list.switchAllowed" class="access-profiles-note" role="status">
        {{ t('settings.accessProfilesSwitchBusy') }}
      </p>
      <p v-if="list.profiles.length" class="access-profiles-note">
        {{ t('settings.accessProfilesImmediate') }}
      </p>
    </template>
    <AccessProfileDialog v-if="wizard" :key="`${providerId}:${editing?.id ?? 'new'}`"
      :provider-id="providerId" :profile="editing" :recovery-method-id="recovery?.methodId"
      @close="wizard = false" />
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import type { AccessProfile } from '../../../shared/chat/accessProfileContracts.ts';
import {
  UiButton, UiIconButton, UiInlineMessage, UiRefreshIcon, confirmDialog, promptDialog, t, vTooltip,
} from '../ui.ts';
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
 * Подпись отделяет способ входа от пользовательского имени подключения.
 * Тип берётся из capability, без списка поставщиков и разбора названия профиля.
 */
function methodLabel(profile: AccessProfile): string {
  const method = list.value?.methods.find((item) => item.id === profile.methodId);

  if (!method) {
    return '';
  }

  const kind = t(method.kind === 'cli' ? 'settings.accessProfilesCli' : 'settings.accessProfilesApiKey');

  return method.label === kind ? kind : `${kind} · ${method.label}`;
}

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
  await store.activate(props.providerId, id);
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
useSse((name) => store.refreshOnEvent(props.providerId, name));
</script>

<style scoped>
.access-profiles {
  display: grid;
  gap: 8px;
  min-width: 0;
  container-type: inline-size;
}
.access-profiles-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 4px;
}
.access-profiles-heading {
  flex: 1 1 180px;
  min-width: 0;
}
.access-profiles-heading h5,
.access-profile-identity h6 {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.access-profiles-heading p,
.access-profile-method,
.access-profiles-note {
  margin: 2px 0 0;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.6;
}
.access-profile-card {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px 12px;
  min-width: 0;
  padding: 9px 12px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: color-mix(in srgb, var(--surface-2) 35%, transparent);
}
.access-profile-card.is-active {
  border-color: color-mix(in srgb, var(--accent) 40%, var(--line));
  background: color-mix(in srgb, var(--accent) 5%, transparent);
}
.access-profile-identity {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 8px 12px;
}
.access-profile-active {
  color: var(--accent);
  font-size: 11px;
  white-space: nowrap;
}
.access-profile-warning {
  margin: 4px 0 0;
  color: var(--warn);
  font-size: 12px;
}
.access-profile-actions,
.access-profile-tools {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
.access-profile-tools {
  flex-wrap: nowrap;
  margin-left: auto;
}
.access-profiles-empty {
  margin: 0;
  padding: 24px 16px;
  border: 1px dashed var(--line-2);
  border-radius: 8px;
  color: var(--ink-mid);
  text-align: center;
}
@container (max-width: 480px) {
  .access-profile-card {
    grid-template-columns: minmax(0, 1fr);
    gap: 6px;
    padding: 8px 10px;
  }
  .access-profile-actions {
    justify-content: flex-end;
  }
}
</style>
