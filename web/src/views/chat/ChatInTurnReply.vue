<template>
  <div v-if="block?.text?.trim()" class="chat-in-turn-reply" data-role="chat-in-turn-reply">
    <span class="chat-in-turn-reply__title">Агент · ответ во время хода</span>
    <div class="text md" v-html="mdToHtml(block.text, { resolveHref: chatFileLinkHref })"></div>
    <span v-if="!block.complete" class="chat-in-turn-reply__draft">Пишет…</span>
    <span v-if="block.truncated" class="chat-in-turn-reply__draft">Ответ сокращён</span>
  </div>
</template>

<script setup>
import { mdToHtml } from '../../shared/md.ts';
import { chatFileLinkHref } from '../../features/code/links.ts';

defineProps({ block: { type: Object, required: true } });
</script>

<style scoped>
.chat-in-turn-reply { margin: .55rem 0; padding: .55rem .75rem; border-left: 2px solid var(--accent, #8b7cf6); }
.chat-in-turn-reply__title, .chat-in-turn-reply__draft { display: block; font-size: .76rem; opacity: .7; }
.chat-in-turn-reply .text { margin-top: .3rem; }
</style>
