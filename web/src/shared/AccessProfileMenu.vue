<template>
  <div>
    <span>{{ activeName }}</span>
    <UiButton v-for="profile in list?.profiles ?? []" :key="profile.id"
      :disabled="store.pending[providerId] || profile.id === list?.activeProfileId"
      @click="activate(profile.id)">{{ profile.name }}</UiButton>
    <p v-if="store.errors[providerId]" role="alert">{{ store.errors[providerId] }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, watch } from 'vue';

import { UiButton } from '../ui.ts';
import { useAccessProfilesStore } from '../stores/accessProfiles.ts';
import { useSse } from '../composables/useSse.ts';

const props = defineProps<{ providerId: string }>();
const store = useAccessProfilesStore();
const list = computed(() => store.lists[props.providerId]);
const activeName = computed(() => list.value?.profiles.find((item) => item.id === list.value?.activeProfileId)
  ?.name ?? '');

async function activate(id: string) {
  await store.mutate(props.providerId, `/${id}/activate`, { expectedRevision: list.value?.revision });
}

watch(() => props.providerId, () => store.load(props.providerId), { immediate: true });
useSse((name) => {
  if (name === 'hello' || name === 'providers-update' || name === 'access-profiles') {
    void store.load(props.providerId);
  }
});
</script>
