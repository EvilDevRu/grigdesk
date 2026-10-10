<template>
  <section v-if="activity.items.length || activity.omitted" class="chat-activity" data-touch-density="compact">
    <UiButton
      class="activity-toggle"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      <UiIcon name="activity" />
      <span>{{ label }}</span>
      <span aria-hidden="true">{{ expanded ? '⌄' : '›' }}</span>
    </UiButton>
    <div v-if="expanded" class="activity-items">
      <p v-if="activity.omitted" class="mobile-muted">Ранних шагов скрыто: {{ activity.omitted }}</p>
      <div
        v-for="(item, index) in activity.items"
        :key="item.id + ':' + index"
        class="activity-item"
        :data-state="item.state"
      >
        <div v-if="item.kind === 'text'" class="activity-reply">
          <UiIcon name="chats" />
          <UiMarkdown :text="item.text" />
        </div>
        <template v-else>
          <UiButton
            class="activity-step"
            :aria-expanded="Boolean(open[item.id])"
            @click="open[item.id] = !open[item.id]"
          >
            <UiIcon :name="activityIcon(item)" class="activity-icon" />
            <strong :aria-label="item.title">{{ item.title }}</strong>
            <span class="activity-preview" :data-kind="item.kind" :aria-label="item.text">
              {{ item.text }}
            </span>
            <span class="activity-state" aria-hidden="true">
              {{ item.state === 'error' ? '!' : item.state === 'running' ? '◌' : '✓' }}
            </span>
            <span v-if="item.state === 'error'" class="mobile-danger">Ошибка</span>
            <span aria-hidden="true">{{ open[item.id] ? '⌄' : '›' }}</span>
          </UiButton>
          <div v-if="open[item.id]" class="activity-detail">
            <UiMarkdown v-if="item.kind === 'think'" :text="item.text" />
            <pre v-else>{{ item.text }}</pre>
            <pre v-if="item.result" class="activity-result">{{ item.result }}</pre>
            <p v-if="item.state === 'running'" role="status">Выполняется…</p>
          </div>
        </template>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';

import type { ChatActivity } from '../api/contract.ts';
import { UiButton, UiIcon, UiMarkdown } from '../ui.ts';
import { activityIcon } from './chatActivityView.ts';

const props = defineProps<{
  activity: ChatActivity;
  live?: boolean;
}>();
const expanded = ref(Boolean(props.live));
const open = ref<Record<string, boolean>>({});
const label = computed(() => {
  const actions = props.activity.items.filter((item) => item.kind === 'tool').length;
  const thinking = props.activity.items.filter((item) => item.kind === 'think').length;

  return actions || thinking ? `${actions} действий · ${thinking} размышл.` : 'Ход агента';
});
</script>
