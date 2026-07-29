<script setup>
import { ref, computed, nextTick } from 'vue';
import { useChatStore } from '../../stores/chat.js';
import { useProvidersStore } from '../../stores/providers.js';
import ProviderIcon from '../../shared/ProviderIcon.vue';
import ToggleSwitch from '../../shared/ui/ToggleSwitch.vue';
import { confirmDialog } from '../../shared/ui/confirm.js';

// Телеграм-сайдбар чатов: поиск сверху, ниже — активные либо архивные чаты.
// Строка: аватар, название, сниппет последнего сообщения (или совпадения при поиске), время.
const chat = useChatStore();

const prov = useProvidersStore();
prov.load();

const q = ref('');
const showArchived = ref(false);
const archiveLabel = computed(() => `Показывать архив${chat.archived.length ? ` · ${chat.archived.length}` : ''}`);
const emptyLabel = computed(() => {
  if (q.value.trim()) return 'Ничего не найдено';
  return showArchived.value ? 'Архив пуст' : 'Нет активных чатов';
});
// Строки уже с моделью чата: кто отвечает (иконка исполнителя) и короткое имя модели.
// Резолвим здесь, а не в шаблоне — иначе поиск по реестру шёл бы на каждый рендер каждой строки.
const rows = computed(() => chat.list(q.value, showArchived.value).map((r) => {
  const { model, provider } = prov.modelOf(r.model);
  return { ...r, provider, modelName: model?.name || '' };
}));

// Буква — фоллбэк, пока реестр исполнителей не загрузился (иначе аватар пустой).
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

function newChat() {
  showArchived.value = false;
  chat.newSession();
}

function select(r) {
  chat.selectChat(r.id);
  // Выбор архивного чата восстанавливает его, поэтому возвращаемся к активному списку.
  if (r.archived) showArchived.value = false;
}

function restore(r) {
  chat.restoreArchived(r.id);
  showArchived.value = false;
}

async function del(r) {
  const permanent = r.archived;
  const ok = await confirmDialog(
    permanent
      ? `Удалить чат «${r.title}» безвозвратно? Восстановить его после этого не получится.`
      : `Переместить чат «${r.title}» в архив?`,
    {
      title: permanent ? 'Удалить чат навсегда' : 'Переместить в архив',
      okText: permanent ? 'Удалить' : 'В архив',
      danger: permanent,
    },
  );
  if (ok) chat.deleteChat(r.id);
}
</script>

<template>
  <aside class="cl">
    <div class="top">
      <div class="tools">
        <input v-model="q" class="q" :placeholder="showArchived ? 'Поиск в архиве' : 'Поиск'" />
        <button class="new" title="Новый чат" @click="newChat">＋</button>
      </div>
      <ToggleSwitch v-model="showArchived" :label="archiveLabel" />
    </div>
    <div class="rows">
      <div v-if="!rows.length" class="none muted">{{ emptyLabel }}</div>
      <div v-for="r in rows" :key="r.id" class="row" :class="{ cur: r.id === chat.activeId && !r.archived, wait: r.waiting }"
           @click="select(r)" @dblclick="startEdit(r)">
        <!-- Аватар — иконка исполнителя (кто отвечает в этом чате), а не буква названия.
             Во время работы цвет меняется целиком, а вращается только внешнее кольцо. -->
        <span class="ava" :class="{ live: r.sending }"
              :title="r.sending
                ? `${r.modelName || 'Модель по умолчанию'} · агент работает`
                : (r.modelName || 'Модель по умолчанию')">
          <ProviderIcon v-if="r.provider" :provider="r.provider" :size="19" />
          <template v-else>{{ letter(r) }}</template>
          <!-- Точка «непрочитано»: бейджи на кнопке и в сайдбаре считают именно такие чаты -->
          <span v-if="r.unread" class="udot" title="непрочитанный ответ"></span>
        </span>
        <div class="mid">
          <input v-if="editId === r.id" ref="editEl" v-model="editVal" class="edit"
                 @click.stop @keydown.enter="commitEdit" @keydown.esc="editId = null" @blur="commitEdit" />
          <template v-else>
            <div class="t1">
              <span class="name">{{ r.title }}</span>
              <!-- Агент упёрся в вопрос и стоит: чип важнее подписи модели, поэтому вместо неё -->
              <span v-if="r.waiting" class="wchip" title="агент ждёт твоего ответа — работа стоит">ждёт ответа</span>
              <span v-else-if="r.modelName" class="mdl">{{ r.modelName }}</span>
              <span class="ago muted">{{ ago(r.ts) }}</span>
            </div>
            <div class="t2 muted">
              <span v-if="r.draft" class="dr">черновик:</span>{{ r.snippet || 'Пустой чат' }}
            </div>
          </template>
        </div>
        <span v-if="editId !== r.id" class="acts">
          <button v-if="r.archived" class="restore"
                  title="Восстановить из архива"
                  aria-label="Восстановить чат из архива"
                  @click.stop="restore(r)">↩</button>
          <button title="Переименовать" @click.stop="startEdit(r)">✎</button>
          <button :class="{ danger: r.archived }"
                  :title="r.archived ? 'Удалить навсегда' : 'Переместить в архив'"
                  :aria-label="r.archived ? 'Удалить чат навсегда' : 'Переместить чат в архив'"
                  @click.stop="del(r)">✕</button>
        </span>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.cl { width: 300px; flex: none; display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--line); }

.top { display: flex; flex-direction: column; gap: 5px; padding: 10px; border-bottom: 1px solid var(--line); }
.tools { display: flex; gap: 7px; }
.top :deep(.tsw) { align-self: flex-start; }
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
/* Чат, где агент ждёт ответа: тёплая полоска слева — видно, что строка требует действия,
   даже когда список длинный (сам чип может уехать под многоточие названия). */
.row.wait { background: color-mix(in srgb, var(--warn, #e0a33a) 10%, transparent); }
.row.wait::before { content: ''; position: absolute; left: 0; top: 6px; bottom: 6px; width: 3px;
  border-radius: 0 3px 3px 0; background: var(--warn, #e0a33a); }
.row.wait.cur { background: color-mix(in srgb, var(--warn, #e0a33a) 18%, transparent); }

.ava { flex: none; width: 38px; height: 38px; border-radius: 50%; display: grid; place-items: center;
  background: var(--surface-2); border: 1px solid var(--line); color: var(--ink-mid);
  font-size: 15px; font-weight: 600; position: relative; }
/* «Агент работает»: цвет читается и без движения, кольцо добавляет ощущение процесса. */
.ava.live { color: color-mix(in srgb, var(--accent) 82%, #fff);
  background: color-mix(in srgb, var(--accent) 16%, var(--surface-2));
  border-color: color-mix(in srgb, var(--accent) 62%, var(--line));
  box-shadow: 0 0 12px color-mix(in srgb, var(--accent) 24%, transparent); }
.ava.live::after { content: ''; position: absolute; inset: -4px; border-radius: 50%;
  border: 2px solid color-mix(in srgb, var(--accent) 22%, transparent);
  border-top-color: var(--accent);
  border-right-color: color-mix(in srgb, var(--accent) 68%, transparent);
  animation: chat-live-spin .85s linear infinite; }
@keyframes chat-live-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .ava.live::after { animation: none; border-color: color-mix(in srgb, var(--accent) 72%, transparent); }
}
/* «Непрочитано» — точка на аватаре: не двигает разметку строки и не спорит с кольцом работы */
.udot { position: absolute; top: -1px; right: -1px; width: 10px; height: 10px; border-radius: 50%;
  background: var(--accent); box-shadow: 0 0 0 2px var(--surface); }

.mid { flex: 1; min-width: 0; }
.t1 { display: flex; align-items: baseline; gap: 6px; }
.name { flex: 1; min-width: 0; font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ago { flex: none; font-size: 11px; }
/* Модель чата — мелкой подписью рядом с названием; при нехватке места жертвуем ею, а не названием */
.mdl { flex: none; font-size: 10.5px; color: var(--ink-mid); border: 1px solid var(--line); border-radius: 5px;
  padding: 0 5px; max-width: 92px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* «Ждёт ответа» — чип на месте подписи модели: тёплый, заметный, но не кричащий */
.wchip { flex: none; font-size: 10.5px; font-weight: 600; color: var(--warn, #e0a33a); line-height: 1.6;
  border: 1px solid color-mix(in srgb, var(--warn, #e0a33a) 55%, transparent); border-radius: 5px; padding: 0 5px;
  background: color-mix(in srgb, var(--warn, #e0a33a) 14%, transparent); white-space: nowrap; }
/* Неотправленный текст — как в телеграме: пометка цветом, дальше сам текст */
.dr { color: var(--warn, #e0a33a); margin-right: 4px; }
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
.acts button:last-child:hover { color: var(--accent); }
.acts button.danger:hover { color: var(--bad); }
</style>
