<template>
  <div class="profile" data-role="project-profile">
    <dl class="facts">
      <div>
        <dt>{{ t('core.projectProfilFabriki') }}</dt>
        <dd><span class="profile-value" :class="{ found: detail.profile.present }">
          {{ detail.profile.present ? t('core.projectNayden') : t('core.projectNet') }}
        </span></dd>
      </div>
      <div>
        <dt>{{ t('core.routes') }}</dt>
        <dd>
          <span v-if="detail.routes.length">{{ detail.routes.join(', ') }}</span>
          <span v-else class="hint">{{ t('core.projectOpublikovannyhMarshrutovNet') }}</span>
          <UiButton variant="ghost" tone="accent" data-context="workspace-toolbar"
            data-role="project-routes" @click="emit('openRoutes')"> {{ t('core.projectOtkrytMarshruty') }} <template #trailing><ProjectIcon name="arrow" /></template>
          </UiButton>
        </dd>
      </div>
    </dl>
    <p v-if="!detail.profile.present" class="hint"> {{ t('core.projectProfilPoyavitsyaKogdaEgo') }} </p>
    <p v-if="detail.profile.mismatch.length" class="warn"> {{ t('core.projectKlyuchi') }} {{ mismatchKeys }} {{ t('core.projectObyavlenyVPasporteNo') }} </p>
  </div>
</template>

<script setup lang="ts">
// Состояние профиля фабрики у проекта: есть ли он, откуда взяты пути и что
// опубликовано в каталоге маршрутов. Править здесь нечего — это чтение.
import { computed } from 'vue';

import { UiButton, t } from '../../ui';
import ProjectIcon from './ProjectIcon.vue';
import type { ProjectDetail } from '../../../../shared/runtime/projectsContracts';

const props = defineProps<{ detail: ProjectDetail }>();

const emit = defineEmits<{ openRoutes: [] }>();

const mismatchKeys = computed(() => props.detail.profile.mismatch
  .map((repo) => repo.key)
  .join(', '));
</script>

<style scoped>
.profile {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  overflow-wrap: anywhere;
}

.facts {
  display: grid;
  gap: 4px;
  margin: 0;
}

.facts > div {
  display: grid;
  grid-template-columns: var(--workspace-label-column) minmax(0, 1fr);
  align-items: center;
  gap: var(--workspace-column-gap);
  min-height: 28px;
}

.facts dt {
  color: var(--workspace-label-color);
  font-size: 12px;
  line-height: 18px;
}

.facts dd {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin: 0;
  min-width: 0;
}

.profile-value {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.found::before {
  content: '';
  width: 5px;
  height: 5px;
  border-radius: var(--radius-round);
  background: var(--good);
}

.hint, .warn {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--ink-mid);
}

.warn {
  color: var(--warn);
}

@container project-detail (max-width: 480px) {
  .facts > div {
    grid-template-columns: 114px minmax(0, 1fr);
    gap: 10px;
  }

}

@container project-detail (max-width: 320px) {
  .facts > div {
    grid-template-columns: minmax(0, 1fr);
    gap: 3px;
  }

}
</style>
