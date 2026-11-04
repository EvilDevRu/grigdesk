<template>
  <HelpBrowser :bundle="state.bundle" :status="state.status" :error="state.error"
               :article-id="articleId" :fragment="fragment" :can-ask="chat.loaded"
               @navigate="(id, hash) => $emit('navigate', id, hash)" @retry="loader.reload" @ask="ask" />
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { t } from '../../ui.ts';
import { api } from '../../shared/apiClient.ts';
import { createHelpLoader } from '../../shared/helpLoader.ts';
import type { HelpLoadState } from '../../shared/helpLoader.ts';
import { useAuthStore } from '../../stores/auth.ts';
import { useChatStore } from '../../stores/chat.ts';
import { useHelpStore } from '../../stores/help.ts';
import { useShellStore } from '../../stores/shell.ts';
import HelpBrowser from './HelpBrowser.vue';

withDefaults(defineProps<{
  articleId?: string;
  fragment?: string;
}>(), {
  articleId: 'overview', fragment: ''
});
defineEmits<{
  navigate: [
    id: string,
    fragment: string
  ];
}>();

const router = useRouter();
const auth = useAuthStore();
const chat = useChatStore();
const help = useHelpStore();
const shell = useShellStore();
const state = ref<HelpLoadState>({
  status: 'loading',
  bundle: null,
  error: ''
});
const loader = createHelpLoader(() => api.get('/api/help'), (value) => {
  state.value = value;
});
/**
 * Справка становится черновиком нового разговора и не инициирует платный ход.
 * Прежний разговор и его неотправленный текст не изменяются.
 */
async function ask(id: string): Promise<void> {
  const bundle = state.value.bundle;
  const article = bundle?.articles.find((entry) => entry.id === id);

  if (!article || !bundle || !chat.loaded) {
    return;
  }

  const created = chat.newSession({
    title: t('core.helpQuestionTitle', {
      title: article.title
    }),
    draft: t('core.helpQuestionDraft', {
      title: article.title,
      id,
      version: bundle.version
    })
  });

  if (created) {
    help.isOpen = false;
    await router.push('/chats');
  }
}

watch(() => [auth.authenticated, auth.clientScope, shell.profile?.id, shell.status, shell.present], () => {
  loader.cancel();

  if (auth.authenticated && auth.clientScope && (!shell.present || shell.status === 'online')) {
    void loader.reload();
  }
}, {
  immediate: true
});
onBeforeUnmount(loader.cancel);
</script>
