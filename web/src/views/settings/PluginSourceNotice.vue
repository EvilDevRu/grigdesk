<template>
  <UiInlineMessage
    data-source-notice
    :data-membership="membership"
    :tone="membership === 'external' || membership === 'unverified' ? 'warning' : 'neutral'"
  >
    <strong>{{ caption }}</strong>
    <p v-if="membership === 'external' || membership === 'unverified'">
      {{ t('settings.marketplaceSourceRisk') }}
    </p>
    <p>{{ source }}</p>
  </UiInlineMessage>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import { UiInlineMessage, t } from '../../ui.ts';
import type { MessageKey } from '../../../../shared/i18n/catalogs.ts';
import type { SourceMembership } from '../../../../shared/plugins/pluginCatalogPolicy.ts';

const props = defineProps<{ membership: SourceMembership; source: string }>();
const keys: Record<SourceMembership, MessageKey> = {
  official: 'settings.marketplaceOfficial',
  community: 'settings.marketplaceCommunity',
  external: 'settings.marketplaceUnknownSource',
  unverified: 'settings.marketplaceUnverifiedSource',
  manual: 'settings.marketplaceManual',
};
const caption = computed(() => t(keys[props.membership]));
</script>

<style scoped>
p {
  overflow-wrap: anywhere;
}
</style>
