<template>
  <aside class="cl">
    <div class="top">
      <div class="tools">
        <div class="search">
          <UiSearchInput
            v-model="q"
            :placeholder="showArchived ? 'Поиск в архиве' : 'Поиск'"
          />
        </div>
        <UiIconButton
          class="new"
          data-context="chat-list-new"
          label="Новый чат"
          v-tooltip="'Новый чат'"
          tone="accent"
          @click="newChat"
        >
          ＋
        </UiIconButton>
      </div>
      <div class="archive-toggle">
        <UiSwitch v-model="showArchived">{{ archiveLabel }}</UiSwitch>
      </div>
    </div>

    <div class="rows">
      <div v-if="!rows.length" class="none muted">{{ emptyLabel }}</div>
      <div
        v-for="r in rows"
        :key="r.id"
        class="row"
        :class="{
          archived: r.archived,
          cur: r.id === chat.activeId,
          wait: r.waiting,
        }"
      >
        <template v-if="editId === r.id">
          <span
            class="ava"
            :class="{
              live: r.sending,
              brand: Boolean(r.provider?.color),
            }"
            :style="r.provider?.color ? { '--prov': r.provider.color } : null"
            v-tooltip="avatarTitle(r)"
          >
            <ProviderIcon
              v-if="r.provider"
              :provider="r.provider"
              :size="19"
            />
            <template v-else>{{ letter(r) }}</template>
            <ChatSleepBadge
              v-if="r.sleep && !r.sending && !r.compacting"
              :tasks="r.sleep.backgroundTasks"
            />
            <span
              v-if="r.unread"
              class="udot"
              v-tooltip="'непрочитанный ответ'"
            />
          </span>
          <span class="mid">
            <UiInput
              ref="editEl"
              v-model="editVal"
              class="edit"
              aria-label="Название чата"
              @keydown.enter="commitEdit"
              @keydown.esc="editId = null"
              @blur="commitEdit"
            />
          </span>
        </template>

        <UiPressable
          v-else
          class="row-hit"
          :pressed="r.id === chat.activeId"
          @click="select(r)"
          @dblclick="startEdit(r)"
        >
          <!-- Аватар показывает исполнителя; кольцо работы вращается отдельно от знака. -->
          <span
            class="ava"
            :class="{
              live: r.sending,
              brand: Boolean(r.provider?.color),
            }"
            :style="r.provider?.color ? { '--prov': r.provider.color } : null"
            v-tooltip="avatarTitle(r)"
          >
            <ProviderIcon
              v-if="r.provider"
              :provider="r.provider"
              :size="19"
            />
            <template v-else>{{ letter(r) }}</template>
            <ChatSleepBadge
              v-if="r.sleep && !r.sending && !r.compacting"
              :tasks="r.sleep.backgroundTasks"
            />
            <span
              v-if="r.unread"
              class="udot"
              v-tooltip="'непрочитанный ответ'"
            />
          </span>

          <span class="mid">
            <span class="t1">
              <span class="name">{{ r.title }}</span>
              <span
                v-if="r.waiting"
                class="wchip"
                v-tooltip="'агент ждёт твоего ответа — работа стоит'"
              >
                ждёт ответа
              </span>
              <span v-else-if="r.modelName" class="mdl">{{ r.modelName }}</span>
              <span class="ago muted">{{ ago(r.ts) }}</span>
            </span>
            <span class="t2 muted">
              <span v-if="r.draft" class="dr">черновик:</span>{{
                r.snippet || 'Пустой чат'
              }}
            </span>
          </span>
        </UiPressable>

        <span v-if="editId !== r.id" class="acts">
          <!-- Мышь: кнопки появляются при наведении, действие — одним нажатием. -->
          <span class="acts-quick">
            <UiIconButton
              v-if="r.archived"
              data-context="chat-list-action"
              role="rail"
              label="Достать чат из архива"
              v-tooltip="'Достать из архива'"
              tone="accent"
              @click="restore(r)"
            >
              ↩
            </UiIconButton>
            <UiIconButton
              data-context="chat-list-action"
              role="rail"
              label="Переименовать чат"
              v-tooltip="'Переименовать'"
              @click="startEdit(r)"
            >
              ✎
            </UiIconButton>
            <UiIconButton
              data-context="chat-list-action"
              role="rail"
              :label="r.archived ? 'Удалить чат навсегда' : 'Переместить чат в архив'"
              v-tooltip="r.archived ? 'Удалить навсегда' : 'Переместить в архив'"
              :tone="r.archived ? 'danger' : 'accent'"
              @click="del(r)"
            >
              ✕
            </UiIconButton>
          </span>
          <!-- Палец: наведения нет, поэтому действия собраны в меню с полными подписями. -->
          <span class="acts-menu">
            <UiPopover has-popup="menu" placement="bottom-end" :aria-label="`Действия: ${r.title}`">
              <template #trigger>
                <UiIconButton data-context="chat-list-action" role="rail" :label="`Действия: ${r.title}`">
                  ⋯
                </UiIconButton>
              </template>
              <template #default="{ close }">
                <div class="ui-action-menu">
                  <UiButton v-if="r.archived" role="menuitem" variant="ghost"
                            @click="close('action'); restore(r)">Достать из архива</UiButton>
                  <UiButton role="menuitem" variant="ghost"
                            @click="close('action'); startEdit(r)">Переименовать</UiButton>
                  <UiButton role="menuitem" variant="ghost" :tone="r.archived ? 'danger' : 'neutral'"
                            @click="close('action'); del(r)">
                    {{ r.archived ? 'Удалить навсегда' : 'Переместить в архив' }}
                  </UiButton>
                </div>
              </template>
            </UiPopover>
          </span>
        </span>
      </div>
    </div>
  </aside>
</template>

<script setup lang="ts">
import type { ChatListRow } from '../../shared/chatContracts.ts';
import type { UiFieldHandle } from '../../ui.ts';
import type { ChatSleepingSession } from '../../../../shared/chat/chatBackgroundTasks.ts';

import { computed, nextTick, ref, watch } from 'vue';
import { useChatStore } from '../../stores/chat.ts';
import { useProvidersStore } from '../../stores/providers.ts';
import ProviderIcon from '../../shared/ProviderIcon.vue';
import ChatSleepBadge from './ChatSleepBadge.vue';
import { useChatSleeping } from '../../composables/useChatSleeping.ts';
import {
  confirmDialog,
  UiButton,
  UiPopover,
  UiIconButton,
  UiInput,
  UiPressable,
  UiSearchInput,
  UiSwitch,
  vTooltip,
} from '../../ui';

// Телеграм-сайдбар чатов: поиск сверху, ниже — активные либо архивные чаты.
// Строка: аватар, название, сниппет последнего сообщения (или совпадения при поиске), время.
type ListRow = ChatListRow & { modelName: string; sleep?: ChatSleepingSession };

const chat = useChatStore();
// open — «чат выбран, покажи его». Нужен мобильной раскладке, где список и чат делят одну
// колонку: следить за activeId там мало — повторный тык по уже активному чату его не меняет.
const emit = defineEmits(['open']);

const prov = useProvidersStore();
const { sessions: sleepingSessions } = useChatSleeping();

prov.load();

const q = ref('');
const showArchived = ref(false);
const archiveLabel = computed(() => (
  `Показывать архив${chat.archived.length ? ` · ${chat.archived.length}` : ''}`
));
const emptyLabel = computed(() => {
  if (q.value.trim()) {
    return 'Ничего не найдено';
  }

  return showArchived.value ? 'Архив пуст' : 'Нет активных чатов';
});

// Строки уже с моделью чата: кто отвечает (иконка исполнителя) и короткое имя модели.
// Резолвим здесь, а не в шаблоне — иначе поиск по реестру шёл бы на каждый рендер каждой строки.
const rows = computed(() => chat.list(q.value, showArchived.value).map((r: ChatListRow) => {
  const { model, provider } = prov.modelOf(r.modelRef || r.model);

  return {
    ...r,
    provider,
    modelName: model?.name || '',
    sleep: sleepingSessions.value[r.id],
  };
}));

// Отправка из архивного разговора сама возвращает его в активные. В этот момент
// переключаем и левый список: иначе открытый чат уже активный, а сайдбар продолжает
// показывать архив, из которого его строка только что исчезла.
watch(
  () => chat.archived.some((session: { id: string }) => session.id === chat.activeId),
  (archived, wasArchived) => {
    if (showArchived.value && wasArchived && !archived) {
      showArchived.value = false;
    }
  },
);

// Буква — фоллбэк, пока реестр исполнителей не загрузился (иначе аватар пустой).
function letter(row: ListRow) {
  return row.taskId ? '#' : (row.title[0] || '?').toUpperCase();
}

/**
 * Заголовок аватара называет модель и текущее состояние чата.
 * Сжатие имеет отдельную подпись при том же индикаторе занятости.
 */
function avatarTitle(row: ListRow) {
  const modelName = row.modelName || 'Модель по умолчанию';

  if (row.compacting) {
    return `${modelName} · сжимаю контекст`;
  }
  if (row.sending) {
    return `${modelName} · агент работает`;
  }

  return modelName;
}

/**
 * Относительное время сохраняет компактный телеграмный формат строки.
 * После недели календарная дата устойчивее постоянно растущего числа дней.
 */
const calendarDate = new Intl.DateTimeFormat('ru', { day: '2-digit', month: '2-digit' });

/**
 * Форматтер принадлежит смонтированному списку и создаётся один раз, а не для каждой строки.
 * При пересортировке сохраняется прежний календарный и относительный формат времени.
 */
function ago(ts: number) {
  if (!ts) {
    return '';
  }

  const elapsed = Date.now() - ts;

  if (elapsed < 60e3) {
    return 'сейчас';
  }
  if (elapsed < 3600e3) {
    return `${Math.floor(elapsed / 60e3)}м`;
  }
  if (elapsed < 86400e3) {
    return `${Math.floor(elapsed / 3600e3)}ч`;
  }
  if (elapsed < 7 * 86400e3) {
    return `${Math.floor(elapsed / 86400e3)}д`;
  }

  return calendarDate.format(new Date(ts));
}

const editId = ref<string | null>(null);
const editVal = ref('');
const editEl = ref<UiFieldHandle<HTMLInputElement> | UiFieldHandle<HTMLInputElement>[] | null>(null);

/**
 * Инлайн-редактор заменяет primary pressable, поэтому после рендера фокусируем
 * exposed handle поля из текущей строки и выделяем прежнее название целиком.
 */
async function startEdit(r: ListRow) {
  editId.value = r.id;
  editVal.value = r.title;

  await nextTick();

  // ref внутри v-for собирается в массив
  const el = Array.isArray(editEl.value) ? editEl.value[0] : editEl.value;

  el?.focus();
  el?.select?.();
}

function commitEdit() {
  if (editId.value) {
    chat.renameChat(editId.value, editVal.value.trim());
  }

  editId.value = null;
}

function newChat() {
  showArchived.value = false;
  chat.newSession();
  emit('open');
}

function select(r: ListRow) {
  chat.selectChat(r.id);
  emit('open');
}

function restore(r: ListRow) {
  chat.restoreArchived(r.id);
  showArchived.value = false;
}

/**
 * Активный чат сначала архивируется, архивный удаляется безвозвратно.
 * Диалог сохраняет эту разницу в тексте и danger-семантике до мутации store.
 */
async function del(r: ListRow) {
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

  if (ok) {
    chat.deleteChat(r.id);
  }
}
</script>

<style scoped>
/* Ширину задаёт раскладка страницы: `--chat-list-w` ставит ChatsView, когда человек
   двигал разделитель. Пока не двигал — переменной нет, и ширину целиком решает CSS
   вместе со своими медиазапросами (второго источника правды о ширине экрана не заводим). */
.cl { width: var(--chat-list-w, 300px); flex: none; display: flex; flex-direction: column; min-height: 0;
  border-right: 1px solid var(--line); }

/* Высота шапки — общий с открытым чатом токен (--chat-head-h): содержимое здесь и справа
   разное, и без общей высоты две разделительные линии идут на разном уровне. Содержимое
   центрируем по вертикали — тогда запас высоты не выглядит «прибитым» к верху. */
.top { display: flex; flex-direction: column; justify-content: center; gap: 5px;
  min-height: var(--chat-head-h); flex: none; padding: 0 10px; border-bottom: 1px solid var(--line); }
.tools { display: flex; align-items: center; gap: 7px; }
.search { flex: 1; min-width: 0; }
.archive-toggle { align-self: flex-start; }
.new { flex: none; }

.rows { flex: 1; overflow-y: auto; padding: 5px; }
.none { padding: 12px; font-size: 12.5px; text-align: center; }

/* Фон строки — непрозрачный `--row-bg` поверх фона списка (`--surface`): тем же цветом
   кнопки действий закрывают конец названия и время, не отличаясь от самой строки. */
.row { position: relative; display: flex; align-items: center; gap: 9px; padding: 4px 8px;
  min-height: var(--chat-list-row-h); border-radius: 10px; --row-bg: var(--surface); background: var(--row-bg); }
.row-hit { display: flex; flex: 1; align-items: center; gap: 9px; width: 100%; min-width: 0; text-align: left; }
.row:hover { --row-bg: var(--surface-2); }
.row.cur { --row-bg: color-mix(in srgb, var(--accent) 18%, var(--surface)); }
/* Чат, где агент ждёт ответа: тёплая полоска слева — видно, что строка требует действия,
   даже когда список длинный (сам чип может уехать под многоточие названия). */
.row.wait { --row-bg: color-mix(in srgb, var(--warn, #e0a33a) 10%, var(--surface)); }
.row.wait::before { content: ''; position: absolute; left: 0; top: 6px; bottom: 6px; width: 3px;
  border-radius: 0 3px 3px 0; background: var(--warn, #e0a33a); }
.row.wait.cur { --row-bg: color-mix(in srgb, var(--warn, #e0a33a) 18%, var(--surface)); }

.ava { flex: none; width: var(--chat-avatar-size); height: var(--chat-avatar-size); border-radius: 50%; display: grid; place-items: center;
  background: var(--surface-2); border: 1px solid var(--line); color: var(--ink-mid);
  font-size: 15px; font-weight: 600; position: relative; }
/* Знак исполнителя — в цвете исполнителя. Одинаково-серые аватары в списке из двадцати
   строк не различаются вовсе: чат приходилось искать по подписи модели, а сам знак
   работал украшением. Фирменные цвета рассчитаны на светлый фон, поэтому на тёмном
   подмешиваем белый (знак) и фон карточки (заливка с рамкой) — иначе тёмно-фиолетовый
   Kimi на #1c222c читается пятном. Чат без знака (реестр ещё не приехал, буква-фоллбэк)
   остаётся нейтральным: `--prov` там не задан. */
.ava.brand { color: color-mix(in srgb, var(--prov) 72%, #fff);
  background: color-mix(in srgb, var(--prov) 17%, var(--surface-2));
  border-color: color-mix(in srgb, var(--prov) 45%, var(--line)); }
/* Полную силу цвета получают только чаты, которые сейчас чего-то стоят: открытый,
   работающий и вставший на вопросе. Остальные приглушены — иначе список из двадцати
   строк горит ровным ковром и выделять в нём нечего.
   Приглушаем ОБЕСЦВЕЧИВАНИЕМ (подмешиваем нейтральный `--ink-mid`), а не затемнением
   и не прозрачностью. Обе «очевидные» альтернативы роняют знак ниже порога графики
   3:1 к своей заливке, причём первым всегда Kimi — его фиолетовый и так самый тёмный
   (замер: `opacity: .72` → 2.98, подмешивание тёмной нейтрали → 2.87). Обесцвечивание,
   наоборот, контраст даже поднимает: нейтраль светлее тёмных фирменных цветов.
   Текущие числа — знак 3.6–5.6:1 к заливке, отличие от полной силы ΔE 13.5–18.1
   (рядом видно), различимость исполнителей между собой ΔE ≥ 26.8. */
.row:not(.cur):not(.wait) .ava.brand:not(.live) {
  color: color-mix(in srgb, var(--prov) 50%, var(--ink-mid));
  background: color-mix(in srgb, var(--prov) 9%, var(--surface-2));
  border-color: color-mix(in srgb, var(--prov) 26%, var(--line)); }
/* «Агент работает»: цвет читается и без движения, кольцо добавляет ощущение процесса.
   Цвет тут исполнительский (`--prov`), а не общий акцент: иначе работающие чаты снова
   сливались бы между собой — ровно в тот момент, когда их и различают. */
.ava.live { color: color-mix(in srgb, var(--prov, var(--accent)) 82%, #fff);
  background: color-mix(in srgb, var(--prov, var(--accent)) 16%, var(--surface-2));
  border-color: color-mix(in srgb, var(--prov, var(--accent)) 62%, var(--line));
  box-shadow: 0 0 12px color-mix(in srgb, var(--prov, var(--accent)) 24%, transparent); }
.ava.live::after { content: ''; position: absolute; inset: -4px; border-radius: 50%;
  border: 2px solid color-mix(in srgb, var(--prov, var(--accent)) 22%, transparent);
  border-top-color: var(--prov, var(--accent));
  border-right-color: color-mix(in srgb, var(--prov, var(--accent)) 68%, transparent);
  animation: chat-live-spin .85s linear infinite; }
@keyframes chat-live-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .ava.live::after { animation: none; border-color: color-mix(in srgb, var(--prov, var(--accent)) 72%, transparent); }
}
/* «Непрочитано» — точка на аватаре: не двигает разметку строки и не спорит с кольцом работы */
.udot { position: absolute; top: -1px; right: -1px; width: 10px; height: 10px; border-radius: 50%;
  background: var(--accent); box-shadow: 0 0 0 2px var(--surface); }

.mid { display: block; flex: 1; min-width: 0; }
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
.t2 { display: block; font-size: 12px; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; margin-top: 1px; }
.edit { width: 100%; }

/* Палец: одно постоянное место меню «⋯», ширина названия не меняется при касании и фокусе. */
.acts { display: flex; flex: none; align-items: center; }
.acts-quick { display: none; }

/* Мышь: меню не нужно, три кнопки всплывают при наведении поверх правого края строки
   (время и подпись модели). Место под них не резервируется и отступ строки не растёт —
   иначе название сужалось бы и прыгало при каждом проходе курсора по списку.
   Фокус с клавиатуры показывает кнопки так же, как наведение. */
@media (hover: hover) and (pointer: fine) {
  .acts { position: absolute; top: 4px; right: 8px; bottom: 4px; pointer-events: none; }
  .acts-menu { display: none; }
  .acts-quick { display: flex; align-items: center; gap: 3px; height: 100%; padding-left: 14px;
    background: linear-gradient(to right, transparent, var(--row-bg) 12px); opacity: 0; }
  .row:hover .acts-quick, .row:focus-within .acts-quick { opacity: 1; }
  /* Кликабельны только сами кнопки: полоса растушёвки слева пропускает нажатие в строку. */
  .row:hover .acts-quick > *, .row:focus-within .acts-quick > * { pointer-events: auto; }
}

/* Планшет-альбом: список уже, но остаётся на экране рядом с чатом */
@media (min-width: 900px) and (max-width: 1099px) { .cl { width: var(--chat-list-w, 232px); } }

/* Узкий экран: список занимает всю колонку (чат показывается вместо него — см. ChatsView) */
@media (max-width: 899px) {
  .cl { width: 100%; border-right: none; }
  .rows { padding: 5px 5px calc(6px + env(safe-area-inset-bottom, 0px)); }
}
</style>
