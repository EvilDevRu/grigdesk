<template>
  <UiDialog v-model:open="help.isOpen" data-role="help-dialog" size="workspace"
            :label="t('core.helpTitle')" :body-inset="false">
    <template #header>
      <h2>{{ t('core.helpTitle') }}</h2>
      <UiIconButton :label="t('core.close')" @click="help.isOpen = false">×</UiIconButton>
    </template>
    <HelpWorkspace :article-id="help.articleId" :fragment="help.fragment"
                   @navigate="(id, fragment) => help.open(id, fragment)" />
  </UiDialog>
</template>

<script setup lang="ts">
import { UiDialog, UiIconButton, t } from '../../ui.ts';
import { useHelpStore } from '../../stores/help.ts';
import HelpWorkspace from './HelpWorkspace.vue';

const help = useHelpStore();
</script>
