<template>
  <RichMarkdown class="text md" :text="text" :resolve-href="chatFileLinkHref"
                :resolve-image-href="imageHref" />
</template>

<script setup lang="ts">
import RichMarkdown from '../../shared/markdown/RichMarkdown.vue';
import { chatFileLinkHref } from '../../features/code/links.ts';
import { chatImageHref } from './chatImages.ts';

const props = defineProps<{
  text: string;
  chatId?: string;
}>();

// Путь на диске ищется сервером в текущей рабочей области именно этого разговора.
const imageHref = (href: string) => chatImageHref(href, props.chatId || '');
</script>
