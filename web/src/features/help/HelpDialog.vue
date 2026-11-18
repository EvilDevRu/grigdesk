<template>
  <UiDialog v-model:open="help.isOpen" data-role="help-dialog" size="workspace"
            :label="t('core.helpTitle')" :body-inset="false"
            :close-label="t('core.close')">
    <template #header>
      <h2 class="help-dialog-title"><UiHelpIcon />{{ t('core.helpTitle') }}</h2>
    </template>
    <HelpWorkspace :article-id="help.articleId" :fragment="help.fragment" embedded
                   @navigate="(id, fragment) => help.open(id, fragment)" />
  </UiDialog>
</template>

<script setup lang="ts">
import { UiDialog, UiHelpIcon, t } from '../../ui.ts';
import { useHelpStore } from '../../stores/help.ts';
import HelpWorkspace from './HelpWorkspace.vue';

const help = useHelpStore();
</script>

<style scoped>
.help-dialog-title {
  display: inline-flex;
  flex: 1;
  align-items: center;
  gap: 8px;
}

.help-dialog-title svg {
  width: 16px;
  height: 16px;
  color: var(--ink-mid);
}
</style>
