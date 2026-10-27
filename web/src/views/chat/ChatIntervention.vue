<template>
  <section
    class="intervention ui-workspace"
    data-ui-workspace
    :data-tone="tone"
    :aria-labelledby="titleId"
  >
    <header class="intervention-head">
      <span class="intervention-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
          <template v-if="tone === 'permission'">
            <path d="M12 3 4.5 6v5.5c0 4.4 3.2 7.5 7.5 9.5 4.3-2 7.5-5.1 7.5-9.5V6L12 3Z" />
            <path d="m8.5 11.5 2.3 2.3 4.7-4.7" />
          </template>
          <template v-else>
            <path d="M5 4.5h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9l-6 4v-4a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Z" />
            <path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 1.5-2.5 1.5-2.5 3M12 14v1" />
          </template>
        </svg>
      </span>
      <h3 :id="titleId" class="intervention-title">{{ heading }}</h3>
      <span v-if="source" class="intervention-source">{{ source }}</span>
    </header>

    <div class="intervention-body" tabindex="0" :aria-labelledby="titleId">
      <slot />
    </div>

    <footer class="intervention-footer">
      <slot name="footer" />
    </footer>
  </section>
</template>

<script setup lang="ts">
import { useId } from 'vue';

withDefaults(defineProps<{
  heading: string;
  source?: string;
  tone?: 'permission' | 'question';
}>(), {
  source: '',
  tone: 'question',
});

const titleId = `chat-intervention-${useId()}`;
</script>

<style scoped>
.intervention {
  --intervention-accent: var(--accent);
  display: flex;
  flex: 0 1 auto;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  max-height: min(48dvh, 560px);
  margin: 10px 18px 4px;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--intervention-accent) 32%, var(--line));
  border-radius: var(--radius-md);
  background: var(--surface);
  container-type: inline-size;
}

.intervention[data-tone='permission'] {
  --intervention-accent: var(--warn);
}

.intervention-head {
  display: flex;
  flex: none;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  min-width: 0;
  padding: 11px 14px;
  border-bottom: 1px solid var(--line);
  background: color-mix(in srgb, var(--intervention-accent) 5%, var(--surface));
}

.intervention-icon {
  display: flex;
  flex: none;
  color: var(--intervention-accent);
}

.intervention-icon svg {
  width: 18px;
  height: 18px;
}

.intervention-title {
  min-width: 0;
  margin: 0;
  color: var(--ink);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.intervention-source {
  min-width: 0;
  max-width: 100%;
  padding: 2px 6px;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  color: var(--ink-mid);
  font-family: var(--mono, monospace);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.intervention-body {
  min-height: 0;
  padding: 12px 14px;
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}

.intervention-body:focus-visible {
  outline: 2px solid var(--intervention-accent);
  outline-offset: -2px;
}

.intervention-footer {
  flex: 0 1 auto;
  min-width: 0;
  min-height: 0;
  max-height: 190px;
  padding: 10px 14px;
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  border-top: 1px solid var(--line);
}

@container (max-width: 480px) {
  .intervention-head,
  .intervention-body,
  .intervention-footer {
    padding: 10px;
  }
}

@media (max-width: 600px) {
  .intervention {
    margin-inline: 8px;
    max-height: 52dvh;
  }
}
</style>
