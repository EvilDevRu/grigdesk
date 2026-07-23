<script setup>
import { useChatStore } from '../../stores/chat.js';

// Лента вкладок чата. Переиспользуется в панели (компактно) и на странице (крупно).
defineProps({ variant: { type: String, default: 'panel' } });
const chat = useChatStore();
</script>

<template>
  <div class="tabs" :class="variant">
    <div class="scroll">
      <button v-for="s in chat.sessions" :key="s.id" class="tab" :class="{ active: s.id === chat.activeId }"
              :title="chat.tabLabel(s)" @click="chat.setActive(s.id)">
        <span v-if="s.sending" class="spin"></span>
        <span v-else class="tdot" :class="{ task: s.taskId }"></span>
        <span class="lbl">{{ chat.tabLabel(s) }}</span>
        <span class="x" title="Закрыть вкладку" @click.stop="chat.closeSession(s.id)">✕</span>
      </button>
    </div>
    <button class="new" title="Новая вкладка" @click="chat.newSession()">+</button>
  </div>
</template>

<style scoped>
.tabs { display: flex; align-items: center; gap: 6px; min-width: 0; }
.scroll { display: flex; gap: 5px; overflow-x: auto; scrollbar-width: none; padding: 1px; min-width: 0; }
.scroll::-webkit-scrollbar { display: none; }
.tab { display: inline-flex; align-items: center; gap: 7px; flex: none; max-width: 190px;
  background: var(--surface-2); border: 1px solid var(--line); color: var(--ink-mid);
  border-radius: 9px; padding: 6px 8px 6px 10px; font-size: 12.5px; cursor: pointer; transition: background .12s, color .12s, border-color .12s; }
.tab:hover { color: var(--ink); }
.tab.active { background: color-mix(in srgb, var(--accent) 15%, transparent); border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); color: var(--ink); }
.tdot { width: 7px; height: 7px; border-radius: 50%; background: var(--ink-mid); flex: none; }
.tdot.task { background: var(--accent); }
.lbl { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.x { flex: none; opacity: .5; font-size: 11px; width: 15px; height: 15px; display: inline-grid; place-items: center; border-radius: 4px; }
.x:hover { opacity: 1; background: color-mix(in srgb, var(--bad) 25%, transparent); color: #fff; }
.new { flex: none; width: 30px; height: 30px; border-radius: 8px; background: var(--surface-2); border: 1px solid var(--line);
  color: var(--ink-mid); font-size: 18px; line-height: 1; cursor: pointer; }
.new:hover { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); }

.tabs.page .tab { max-width: 240px; padding: 8px 10px 8px 12px; font-size: 13px; border-radius: 10px 10px 0 0; }
.tabs.page .new { width: 34px; height: 34px; }
</style>
