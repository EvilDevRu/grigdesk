<template>
  <div class="text md" v-html="html"></div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { mdToHtml } from '../../shared/md.ts';
import { chatFileLinkHref } from '../../features/code/links.ts';

const props = defineProps<{ text: string }>();

// Резолвер читает реактивную карту файлов внутри computed.
// Изменение карты обновляет ссылки даже при прежнем тексте сообщения.
const html = computed(() => mdToHtml(props.text, { resolveHref: chatFileLinkHref }));
</script>
