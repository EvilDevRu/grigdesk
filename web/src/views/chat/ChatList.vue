<script setup>
import { ref, computed, nextTick } from 'vue';
import { useChatStore } from '../../stores/chat.js';
import { confirmDialog } from '../../shared/ui/confirm.js';

// Телеграм-сайдбар чатов: поиск сверху, ниже — все чаты (открытые + архив) свежие сверху.
// Строка: аватар, название, сниппет последнего сообщения (или совпадения при поиске), время.
const chat = useChatStore();

const q = ref('');
const rows = computed(() => chat.list(q.value));

// Аватар: устойчивый цвет из названия, буква (для задач — #)
const HUES = [212, 340, 25, 130, 275, 45, 180, 95];
function hue(t) {
  let h = 0;
  for (const c of t) h = (h * 31 + c.charCodeAt(0)) % 9973;
  return HUES[h % HUES.length];
}
function letter(r) { return r.taskId ? '#' : (r.title[0] || '?').toUpperCase(); }

// Относительное время как в телеге
function ago(ts) {
  if (!ts) return '';
  const d = Date.now() - ts;
  if (d < 60e3) return 'сейчас';
  if (d < 3600e3) return `${Math.floor(d / 60e3)}м`;
  if (d < 86400e3) return `${Math.floor(d / 3600e3)}ч`;
  if (d < 7 * 86400e3) return `${Math.floor(d / 86400e3)}д`;
  return new Date(ts).toLocaleDateString('ru', { day: '2-digit', month: '2-digit' });
}

// Инлайн-переименование по карандашу (или двойному клику по строке)
const editId = ref(null);
const editVal = ref('');
const editEl = ref(null);
async function startEdit(r) {
  editId.value = r.id;
  editVal.value = r.title;
  await nextTick();
  // ref внутри v-for собирается в массив
  const el = Array.isArray(editEl.value) ? editEl.value[0] : editEl.value;
  el?.focus();
  el?.select();
}
function commitEdit() {
  if (editId.value) chat.renameChat(editId.value, editVal.value.trim());
  editId.value = null;
}
async function del(r) {
  if (await confirmDialog(`Удалить чат «${r.title}» безвозвратно?`, { danger: true, okText: 'Удалить' })) chat.deleteChat(r.id);
}
</script>

<template>
  <aside class="cl">
    <div class="top">
      <input v-model="q" class="q" placeholder="Поиск" />
      <button class="new" title="Новый чат" @click="chat.newSession()">＋</button>
    </div>
    <div class="rows">
      <div v-if="!rows.length" class="none muted">Ничего не найдено</div>
      <div v-for="r in rows" :key="r.id" class="row" :class="{ cur: r.id === chat.activeId && !r.archived }"
           @click="chat.selectChat(r.id)" @dblclick="startEdit(r)">
        <span class="ava" :style="{ background: `hsl(${hue(r.title)} 42% 46%)` }">
          <span v-if="r.sending" class="spin"></span>
          <template v-else>{{ letter(r) }}</template>
        </span>
        <div class="mid">
          <input v-if="editId === r.id" ref="editEl" v-model="editVal" class="edit"
                 @click.stop @keydown.enter="commitEdit" @keydown.esc="editId = null" @blur="commitEdit" />
          <template v-else>
            <div class="t1">
              <span class="name">{{ r.title }}</span>
              <span class="ago muted">{{ ago(r.ts) }}</span>
            </div>
            <div class="t2 muted">{{ r.snippet || 'Пустой чат' }}</div>
          </template>
        </div>
        <span v-if="editId !== r.id" class="acts">
          <button title="Переименовать" @click.stop="startEdit(r)">✎</button>
          <button title="Удалить безвозвратно" @click.stop="del(r)">✕</button>
        </span>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.cl { width: 300px; flex: none; display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--line); }

.top { display: flex; gap: 7px; padding: 10px; border-bottom: 1px solid var(--line); }
.q { flex: 1; min-width: 0; height: 32px; background: var(--ground); border: 1px solid var(--line); border-radius: 16px;
  color: var(--ink); padding: 0 13px; font-size: 12.5px; outline: none; font-family: inherit; }
.q::placeholder { color: var(--ink-mid); }
.q:focus { border-color: var(--line-2); }
.new { flex: none; width: 32px; height: 32px; border-radius: 50%; background: var(--surface-2); border: 1px solid var(--line);
  color: var(--ink-mid); font-size: 16px; line-height: 1; cursor: pointer; }
.new:hover { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); }

.rows { flex: 1; overflow-y: auto; padding: 5px; }
.none { padding: 12px; font-size: 12.5px; text-align: center; }

.row { position: relative; display: flex; align-items: center; gap: 9px; padding: 7px 8px; border-radius: 10px; cursor: pointer; }
.row:hover { background: var(--surface-2); }
.row.cur { background: color-mix(in srgb, var(--accent) 18%, transparent); }

.ava { flex: none; width: 38px; height: 38px; border-radius: 50%; display: grid; place-items: center;
  color: #fff; font-size: 15px; font-weight: 600; }

.mid { flex: 1; min-width: 0; }
.t1 { display: flex; align-items: baseline; gap: 6px; }
.name { flex: 1; min-width: 0; font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ago { flex: none; font-size: 11px; }
.t2 { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 1px; }
.edit { width: 100%; height: 30px; background: var(--ground); border: 1px solid var(--line-2); border-radius: 7px;
  color: var(--ink); font-size: 13px; padding: 0 8px; outline: none; font-family: inherit; }

/* Действия — поверх времени, только на ховере */
.acts { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); display: none; gap: 3px; }
.row:hover .acts { display: inline-flex; }
.row:hover .ago { visibility: hidden; }
.acts button { width: 24px; height: 24px; border-radius: 6px; border: none; background: var(--ground);
  color: var(--ink-mid); font-size: 12px; cursor: pointer; display: grid; place-items: center; }
.acts button:hover { color: var(--ink); background: var(--surface-2); }
.acts button:last-child:hover { color: var(--bad); }
</style>
