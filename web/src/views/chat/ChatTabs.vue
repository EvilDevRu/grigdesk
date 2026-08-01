<script setup>
import { ref, nextTick } from 'vue';
import { useChatStore } from '../../stores/chat.js';

// Лента вкладок чата — используется в плавающей панели (на странице «Агенты» — сайдбар ChatList).
defineProps({ variant: { type: String, default: 'panel' } });
const chat = useChatStore();

// ── Переименование вкладки: двойной клик по названию ──
const editId = ref(null);
const editVal = ref('');
const editEl = ref(null);
async function startEdit(s) {
  editId.value = s.id;
  editVal.value = chat.tabLabel(s);
  await nextTick();
  // ref внутри v-for собирается в массив
  const el = Array.isArray(editEl.value) ? editEl.value[0] : editEl.value;
  el?.focus();
  el?.select();
}
function commitEdit() {
  if (editId.value) chat.setTitle(editId.value, editVal.value.trim());
  editId.value = null;
}
</script>

<template>
  <div class="tabs" :class="variant">
    <div class="scroll">
      <button v-for="s in chat.sessions" :key="s.id" class="tab" :class="{ active: s.id === chat.activeId }"
              :title="chat.tabLabel(s) + ' · двойной клик — переименовать'"
              @click="chat.setActive(s.id)" @dblclick="startEdit(s)">
        <span v-if="s.sending || s.compacting" class="spin"></span>
        <span v-else class="tdot" :class="{ task: s.taskId }"></span>
        <input v-if="editId === s.id" ref="editEl" v-model="editVal" class="edit"
               @keydown.enter="commitEdit" @keydown.esc="editId = null" @blur="commitEdit" @click.stop />
        <span v-else class="lbl">{{ chat.tabLabel(s) }}</span>
        <span class="x" title="Закрыть вкладку (чат уйдёт в архив)" @click.stop="chat.closeSession(s.id)">✕</span>
      </button>
      <button class="new" title="Новая вкладка" @click="chat.newSession()">+</button>
    </div>
  </div>
</template>

<style scoped>
.tabs { display: flex; align-items: center; gap: 6px; min-width: 0; }
.scroll { display: flex; gap: 5px; overflow-x: auto; scrollbar-width: none; padding: 1px; min-width: 0; align-items: center; }
.scroll::-webkit-scrollbar { display: none; }
.tab { display: inline-flex; align-items: center; gap: 7px; flex: none; max-width: 190px;
  background: var(--surface-2); border: 1px solid var(--line); color: var(--ink-mid);
  border-radius: 9px; padding: 6px 8px 6px 10px; font-size: 12.5px; cursor: pointer; transition: background .12s, color .12s, border-color .12s; }
.tab:hover { color: var(--ink); }
.tab.active { background: color-mix(in srgb, var(--accent) 15%, transparent); border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); color: var(--ink); }
.tdot { width: 7px; height: 7px; border-radius: 50%; background: var(--ink-mid); flex: none; }
.tdot.task { background: var(--accent); }
.lbl { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.edit { width: 120px; background: var(--ground); border: 1px solid var(--line-2); border-radius: 6px;
  color: var(--ink); font-size: 12.5px; padding: 2px 6px; outline: none; font-family: inherit; }
.x { flex: none; opacity: .5; font-size: 11px; width: 15px; height: 15px; display: inline-grid; place-items: center; border-radius: 4px; }
.x:hover { opacity: 1; background: color-mix(in srgb, var(--bad) 25%, transparent); color: #fff; }
.new { flex: none; width: 30px; height: 30px; border-radius: 8px; background: var(--surface-2); border: 1px solid var(--line);
  color: var(--ink-mid); font-size: 18px; line-height: 1; cursor: pointer; }
.new:hover { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); }
</style>
