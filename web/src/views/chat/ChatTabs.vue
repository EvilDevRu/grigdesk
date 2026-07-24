<script setup>
import { ref, computed, nextTick } from 'vue';
import { useChatStore } from '../../stores/chat.js';

// Лента вкладок чата. Переиспользуется в панели (компактно) и на странице (крупно).
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

// ── Поиск по чатам и сообщениям (открытые + архив закрытых) ──
const q = ref('');
const results = computed(() => chat.search(q.value));
function openResult(r) {
  if (r.archived) chat.restoreArchived(r.id);
  else chat.setActive(r.id);
  q.value = '';
}
</script>

<template>
  <div class="tabs" :class="variant">
    <div class="scroll">
      <button v-for="s in chat.sessions" :key="s.id" class="tab" :class="{ active: s.id === chat.activeId }"
              :title="chat.tabLabel(s) + ' · двойной клик — переименовать'"
              @click="chat.setActive(s.id)" @dblclick="startEdit(s)">
        <span v-if="s.sending" class="spin"></span>
        <span v-else class="tdot" :class="{ task: s.taskId }"></span>
        <input v-if="editId === s.id" ref="editEl" v-model="editVal" class="edit"
               @keydown.enter="commitEdit" @keydown.esc="editId = null" @blur="commitEdit" @click.stop />
        <span v-else class="lbl">{{ chat.tabLabel(s) }}</span>
        <span class="x" title="Закрыть вкладку (чат уйдёт в архив)" @click.stop="chat.closeSession(s.id)">✕</span>
      </button>
      <button class="new" title="Новая вкладка" @click="chat.newSession()">+</button>
    </div>
    <div v-if="variant === 'page'" class="find">
      <input v-model="q" placeholder="Поиск по чатам…" />
      <div v-if="q.trim()" class="drop">
        <div v-if="!results.length" class="none muted">Ничего не найдено</div>
        <button v-for="r in results" :key="r.id + (r.archived ? 'a' : '')" class="r" @click="openResult(r)">
          <span class="rt">{{ r.title }}<span v-if="r.archived" class="arch">архив</span></span>
          <span v-if="r.snippet" class="rs muted">{{ r.snippet }}</span>
        </button>
      </div>
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

/* Страница: вкладки сливаются с панелью ниже — активная без цветной обводки,
   неактивные и «+» — призрачные, без коробок в пустоте. */
.tabs.page { position: relative; z-index: 1; }
.tabs.page .scroll { padding: 0; align-items: flex-end; }
.tabs.page .tab { max-width: 240px; padding: 8px 10px 9px 12px; font-size: 13px;
  margin-bottom: -1px; background: transparent; border-color: transparent; border-bottom: none; border-radius: 10px 10px 0 0; }
.tabs.page .tab.active { background: var(--surface); border-color: var(--line); color: var(--ink); }
.tabs.page .new { width: 32px; height: 32px; margin: 0 0 3px 2px; background: transparent; border-color: transparent; }
.tabs.page .new:hover { background: var(--surface-2); }

/* Поиск: справа от вкладок, выпадающий список результатов */
.find { position: relative; margin-left: auto; flex: none; padding-bottom: 4px; }
.find input { width: 220px; height: 30px; background: var(--surface); border: 1px solid var(--line); border-radius: 8px;
  color: var(--ink); padding: 0 10px; font-size: 12.5px; outline: none; font-family: inherit; }
.find input::placeholder { color: var(--ink-mid); }
.find input:focus { border-color: var(--line-2); }
.drop { position: absolute; top: 36px; right: 0; width: 380px; max-height: 320px; overflow-y: auto;
  background: var(--surface); border: 1px solid var(--line-2); border-radius: 10px; padding: 4px; z-index: 30;
  box-shadow: 0 8px 24px rgba(0, 0, 0, .45); }
.none { padding: 9px 10px; font-size: 12.5px; }
.r { display: flex; flex-direction: column; gap: 2px; width: 100%; text-align: left; background: none; border: none;
  color: var(--ink); padding: 7px 9px; border-radius: 7px; cursor: pointer; font-size: 12.5px; }
.r:hover { background: var(--surface-2); }
.rt { font-weight: 600; display: inline-flex; align-items: center; gap: 6px; }
.arch { font-size: 10px; font-weight: 400; color: var(--warn); border: 1px solid color-mix(in srgb, var(--warn) 40%, transparent);
  padding: 0 5px; border-radius: 5px; }
.rs { font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
</style>
