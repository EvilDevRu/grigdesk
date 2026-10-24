<template>
  <div class="chat-loading-preview">
    <div class="preview-art" aria-hidden="true">
      <div class="preview-halo" />
      <div class="preview-message preview-message-back">
        <span class="preview-line" />
        <span class="preview-line preview-line-short" />
      </div>
      <div class="preview-message preview-message-front">
        <svg class="preview-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M20 11.5a8 8 0 0 1-8 8H5l-4 3v-11a8 8 0 0 1 8-8h3a8 8 0 0 1 8 8Z" />
          <path d="M7 10h7M7 14h4" stroke-linecap="round" />
        </svg>
        <span class="preview-dots"><i /><i /><i /></span>
      </div>
    </div>
    <h2>{{ t('core.chatLoadingPreviewTitle') }}</h2>
    <p>{{ t('core.chatLoadingPreviewHint') }}</p>
  </div>
</template>

<script setup lang="ts">
import { t } from '../../ui';
</script>

<style scoped>
.chat-loading-preview {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 32px 24px;
  text-align: center;
}
.preview-art {
  position: relative;
  flex: none;
  width: 200px;
  height: 150px;
  margin-bottom: 24px;
}
.preview-halo {
  position: absolute;
  inset: -32px;
  border-radius: 50%;
  background: radial-gradient(ellipse, color-mix(in srgb, var(--accent) 8%, transparent), transparent 70%);
}
.preview-message {
  position: absolute;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 12px;
  width: 140px;
  height: 82px;
  padding: 20px;
  border: 1px solid var(--line);
  border-radius: 16px;
  background: var(--surface);
}
.preview-message-back {
  top: 6px;
  right: 0;
  transform: rotate(7deg);
  background: var(--surface-2);
}
.preview-message-front {
  left: 0;
  bottom: 8px;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  border-color: color-mix(in srgb, var(--accent) 25%, var(--line));
  transform: rotate(-6deg);
}
.preview-line {
  width: 90%;
  height: 6px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--ink-mid) 15%, transparent);
}
.preview-line-short {
  width: 60%;
}
.preview-icon {
  width: 30px;
  height: 30px;
  color: var(--accent);
}
.preview-dots {
  display: flex;
  gap: 5px;
  color: var(--ink-mid);
}
.preview-dots i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
}
h2 {
  margin: 0;
  color: var(--ink);
  font-size: 17px;
  font-weight: 600;
  line-height: 1.5;
}
p {
  max-width: 260px;
  margin: 8px 0 0;
  color: var(--ink-mid);
  font-size: 13px;
  line-height: 1.7;
}
</style>
