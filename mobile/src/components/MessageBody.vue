<template>
  <div class="mobile-message-body">
    <template v-for="(part, index) in message.parts" :key="index">
      <UiMarkdown v-if="part.type === 'text' && message.role === 'assistant'" :text="part.text" />
      <p v-else-if="part.type === 'text'" class="mobile-prose">{{ part.text }}</p>
      <div v-else-if="part.type === 'code'" class="mobile-code-box">
        <span v-if="part.lang" class="mobile-muted">{{ part.lang }}</span>
        <pre>{{ part.text }}</pre>
      </div>
      <MediaImage v-else :chat-id="chatId" :media-ref="part.ref" :alt="part.alt" />
      <p v-if="'truncated' in part && part.truncated" class="mobile-muted">
        Продолжение текста — в кокпите.
      </p>
    </template>
    <MediaImage
      v-for="media in message.media"
      :key="media.ref"
      :chat-id="chatId"
      :media-ref="media.ref"
      :alt="media.alt"
    />
  </div>
</template>

<script setup lang="ts">
import type { MobileMessage } from '../api/contract.ts';
import MediaImage from './MediaImage.vue';
import { UiMarkdown } from '../ui.ts';

defineProps<{
  chatId: string;
  message: MobileMessage;
}>();
</script>
