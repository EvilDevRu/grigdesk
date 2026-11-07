<template>
  <section class="settings-section">
    <header v-if="heading || description" class="settings-section-heading">
      <h4 v-if="heading">{{ heading }}</h4>
      <p v-if="description">{{ description }}</p>
    </header>
    <div class="settings-section-content"><slot /></div>
  </section>
</template>

<script setup lang="ts">
defineProps<{ heading?: string; description?: string }>();
</script>

<style scoped>
.settings-section {
  min-width: 0;
  width: 100%;
}
.settings-section-heading {
  display: grid;
  gap: 5px;
  padding: 8px 0 0;
}
.settings-section-heading h4 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.5;
}
.settings-section-heading p {
  max-width: 70ch;
  margin: 0;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.6;
}
.settings-section-content {
  display: grid;
  justify-items: stretch;
  gap: 12px;
  min-width: 0;
  padding-top: 8px;
}
.settings-section-content > :deep(.ui-button),
.settings-section-content > :deep(.ui-disclosure-button) {
  justify-self: start;
  max-width: 100%;
}
.settings-section-content > :deep(p) {
  margin: 0;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.settings-section-content > :deep([data-settings-field] + [data-settings-field]) {
  margin-top: -12px;
}
.settings-section-content > :deep(.ui-progress) {
  width: 100%;
}
</style>
