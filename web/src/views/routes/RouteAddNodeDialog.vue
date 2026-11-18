<template>
  <UiDialog open size="workspace" :title="t('core.routeDobavitEtap')"
            data-test="route-add-dialog" @close="emit('close')">
    <p v-if="loading" role="status" data-test="add-roles-loading">
      {{ t('core.routeZagruzhaemKatalogRoley') }}
    </p>
    <div v-else-if="error">
      <p role="alert">{{ t('core.routeKatalogRoleyNeZagruzhen') }}</p>
      <UiButton data-test="add-roles-retry" @click="emit('retry')">
        {{ t('core.routePovtoritZagruzku') }}
      </UiButton>
    </div>
    <p v-else-if="!roles.length" data-test="add-roles-empty">
      {{ t('core.routeKatalogRoleyPust') }}
    </p>
    <div v-else class="route-add-dialog__cards">
      <div v-for="role in roles" :key="role.id">
        <UiButton block wrap :data-test="`add-role-${role.id}`"
                  :disabled="unavailableRoleIds.includes(role.id)" @click="choose(role)">
          <span class="route-add-dialog__role">
            <strong>{{ t(`core.stageWizardRole_${role.id}`) }}</strong>
            <span>{{ t(`core.stageWizardHint_${role.id}`) }}</span>
          </span>
        </UiButton>
        <p v-if="unavailableRoleIds.includes(role.id)">
          {{ t('core.stageWizardReason_recheck_unavailable') }}
        </p>
      </div>
    </div>
    <label v-if="custom" class="route-add-dialog__own">
      <span>{{ t('core.routeSvoyaInstruktsiya') }}</span>
      <UiTextarea v-model="description" rows="4" data-test="add-custom-description" />
    </label>
    <p v-if="commandError" role="alert" data-test="add-command-error">{{ commandError }}</p>
    <template #footer>
      <UiButton data-test="add-close" @click="emit('close')">
        {{ t('core.cancel') }}
      </UiButton>
      <UiButton v-if="custom" data-test="add-custom-confirm"
                :disabled="loading || error || !description.trim()" @click="confirmCustom">
        {{ t('core.stageWizardApply') }}
      </UiButton>
    </template>
  </UiDialog>
</template>

<script setup lang="ts">
import { ref } from 'vue';

import type { StageRoleAnswers, StageRoleTemplate }
  from '../../../../shared/pipeline/routeStageWizardContracts.ts';
import { UiButton, UiDialog, UiTextarea, t } from '../../ui';

const props = withDefaults(defineProps<{
  roles: StageRoleTemplate[];
  loading?: boolean;
  error?: boolean;
  unavailableRoleIds?: string[];
  commandError?: string;
}>(), {
  loading: false,
  error: false,
  unavailableRoleIds: () => [],
  commandError: '',
});
const emit = defineEmits<{
  close: [];
  retry: [];
  choose: [template: StageRoleTemplate, answers: StageRoleAnswers];
}>();

const description = ref('');
const custom = ref<StageRoleTemplate | null>(null);

/**
 * Простая роль применяется одним выбором; «Своё» открывает поле ввода.
 * Никакая инструкция не записывается до отдельного подтверждения заполненного текста.
 */
function choose(role: StageRoleTemplate): void {
  if (props.loading || props.error || props.unavailableRoleIds.includes(role.id)) {
    return;
  }
  if (role.id === 'custom') {
    custom.value = role;

    return;
  }

  emit('choose', role, { ...role.defaults });
}

/**
 * Передаёт оба аргумента выбора с целым пользовательским текстом.
 * Преобразование Vue proxy в plain snapshot выполняет граница команд рабочей области.
 */
function confirmCustom(): void {
  if (custom.value && description.value.trim() && !props.loading && !props.error) {
    emit('choose', custom.value, { ...custom.value.defaults, description: description.value });
  }
}
</script>

<style scoped>
.route-add-dialog__cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr));
  gap: 8px;
}

.route-add-dialog__role {
  display: grid;
  gap: 4px;
  text-align: start;
}

.route-add-dialog__own {
  display: grid;
  gap: 8px;
  margin-top: 12px;
}
</style>
