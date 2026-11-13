<template>
  <aside class="cl"
    :data-perf-pending="!chat.loaded && (!chat.loadError || chat.loading) ? '' : undefined"
    :data-perf-error="!chat.loaded && chat.loadError && !chat.loading ? '' : undefined">
    <div class="top">
      <div class="tools">
        <div class="search">
          <UiSearchInput
            v-model="q"
            size="compact"
            :placeholder="showArchived ? t('core.chatPoiskVArhive') : t('core.search')"
          />
        </div>
        <UiCreateButton
          class="new"
          :label="t('core.chatNovyyChat')"
          :disabled="!chat.loaded"
          @click="newChat"
        />
      </div>
      <div class="archive-toggle">
        <UiSwitch v-model="showArchived">{{ archiveLabel }}</UiSwitch>
      </div>
    </div>

    <div ref="rowsHost" class="rows" @scroll.passive="onRowsScroll">
      <div v-if="!chat.loaded" class="list-pending">
        <section class="load-state" :class="{ 'load-state-error': chat.loadError }">
          <div class="load-status" role="status" aria-live="polite" aria-atomic="true">
            <span class="load-mark" aria-hidden="true">
              <UiSpinner v-if="!chat.loadError || chat.loading" decorative />
              <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
                <path d="M12 8v5m0 3v.1" stroke-linecap="round" />
                <circle cx="12" cy="12" r="9" />
              </svg>
            </span>
            <div class="load-copy">
              <strong class="load-title" :class="{ 'ui-loading-state__hidden': !chat.loadError }">
                {{ t(chat.loadError ? 'core.chatListLoadFailed' : 'core.chatListLoading') }}
              </strong>
              <p v-if="chat.loadError" class="load-reason">
                {{ resolveUiText(chat.loadErrorMessage || '') }}
              </p>
              <p v-if="chat.loadError && chat.loading" class="load-retry-status">
                {{ t('core.chatListLoading') }}
              </p>
            </div>
          </div>
          <p class="load-hint">{{ t('core.chatStoreNotLoaded') }}</p>
          <UiButton v-if="chat.loadError" :disabled="chat.loading" @click="chat.retryLoad()">
            {{ t('core.chatListRetry') }}
          </UiButton>
        </section>

        <div v-if="!chat.loadError" class="list-skeleton" aria-hidden="true">
          <div v-for="index in 6" :key="index" class="skeleton-row">
            <UiSkeleton shape="circle" class="skeleton-avatar"
                        width="var(--chat-avatar-size)" height="var(--chat-avatar-size)" />
            <span class="skeleton-copy">
              <UiSkeleton class="skeleton-title" height="9px" />
              <UiSkeleton class="skeleton-snippet" height="7px" />
            </span>
            <UiSkeleton class="skeleton-time" height="6px" />
          </div>
        </div>
      </div>
      <div v-else-if="!paging.loaded" class="load-state" role="status">
        <p>{{ paging.error || t('core.chatPageLoading') }}</p>
        <UiButton v-if="paging.error" :disabled="paging.loading"
                  @click="chat.ensureChatPage(q, showArchived)">{{ t('core.chatPageRetry') }}</UiButton>
      </div>
      <div v-else-if="q.trim() && (chat.search?.loading || chat.search?.error)" class="load-state">
        <p role="status">{{ chat.search.error || t('core.chatSearchLoading') }}</p>
        <UiButton v-if="chat.search.error" @click="chat.searchChats(q, showArchived)">
          {{ t('core.chatListRetry') }}
        </UiButton>
      </div>
      <div v-else-if="!rows.length && !paging.hasMore" class="none muted">{{ emptyLabel }}</div>
      <div
        v-for="r in rows"
        :key="r.id"
        :data-chat-id="r.id"
        v-memo="[
          r.title, r.snippet, r.modelName, r.provider, r.provider?.color, r.taskId,
          r.archived, r.draft, r.sending, r.compacting, r.unread, r.waiting, r.sleep,
          r.id === chat.activeId, r.id === editId, r.id === editId ? editVal : '', ago(r.ts),
        ]"
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
              v-tooltip="t('core.chatNeprochitannyyOtvet')"
            />
          </span>
          <span class="mid">
            <UiInput
              ref="editEl"
              v-model="editVal"
              class="edit"
              :aria-label="t('core.chatNazvanieChata')"
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
              v-tooltip="t('core.chatNeprochitannyyOtvet')"
            />
          </span>

          <span class="mid">
            <span class="t1">
              <span class="name">{{ r.title }}</span>
              <span
                v-if="r.waiting"
                class="wchip"
                v-tooltip="t('core.chatAgentZhdetTvoegoOtveta')"
              > {{ t('core.chatZhdetOtveta') }} </span>
              <span v-else-if="r.modelName" class="mdl">{{ r.modelName }}</span>
              <span class="ago muted">{{ ago(r.ts) }}</span>
            </span>
            <span class="t2 muted">
              <span v-if="r.draft" class="dr">{{ t('core.chatChernovik') }}</span>{{
                r.snippet || t('core.chatPustoyChat')
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
              :label="t('core.chatDostatChatIzArhiva')"
              v-tooltip="t('core.chatDostatIzArhiva')"
              tone="accent"
              @click="restore(r)"
            >
              ↩
            </UiIconButton>
            <UiIconButton
              data-context="chat-list-action"
              role="rail"
              :label="t('core.chatPereimenovatChat')"
              v-tooltip="t('core.machineRename')"
              @click="startEdit(r)"
            >
              ✎
            </UiIconButton>
            <UiIconButton
              data-context="chat-list-action"
              role="rail"
              :label="r.archived ? t('core.chatUdalitChatNavsegda') : t('core.chatPeremestitChatVArhiv')"
              v-tooltip="r.archived ? t('core.chatUdalitNavsegda') : t('core.chatPeremestitVArhiv')"
              :tone="r.archived ? 'danger' : 'accent'"
              @click="del(r)"
            >
              ✕
            </UiIconButton>
          </span>
          <!-- Палец: наведения нет, поэтому действия собраны в меню с полными подписями. -->
          <span class="acts-menu">
            <UiPopover has-popup="menu" placement="bottom-end" :aria-label="t('core.chatDeystviyaTitle', { title: r.title })">
              <template #trigger>
                <UiIconButton data-context="chat-list-action" role="rail" :label="t('core.chatDeystviyaTitle', { title: r.title })">
                  ⋯
                </UiIconButton>
              </template>
              <template #default="{ close }">
                <div class="ui-action-menu">
                  <UiButton v-if="r.archived" role="menuitem" variant="ghost"
                            @click="close('action'); restore(r)">{{ t('core.chatDostatIzArhiva') }}</UiButton>
                  <UiButton role="menuitem" variant="ghost"
                            @click="close('action'); startEdit(r)">{{ t('core.machineRename') }}</UiButton>
                  <UiButton role="menuitem" variant="ghost" :tone="r.archived ? 'danger' : 'neutral'"
                            @click="close('action'); del(r)">
                    {{ r.archived ? t('core.chatUdalitNavsegda') : t('core.chatPeremestitVArhiv') }}
                  </UiButton>
                </div>
              </template>
            </UiPopover>
          </span>
        </span>
      </div>
      <div v-if="chat.loaded && paging.loaded && (paging.loading || paging.error || paging.hasMore)"
           class="load-state" role="status" aria-live="polite">
        <p v-if="paging.loading">{{ t('core.chatPageLoading') }}</p>
        <p v-else-if="paging.error">{{ paging.error }}</p>
        <UiButton v-if="paging.needsRefresh" :disabled="paging.loading"
                  @click="chat.refreshChatPage(q, showArchived)">{{ t('core.chatPageRefresh') }}</UiButton>
        <UiButton v-else :disabled="paging.loading" @click="chat.loadChatPage(q, showArchived)">
          {{ t(paging.error ? 'core.chatPageRetry' : 'core.chatPageMore') }}
        </UiButton>
      </div>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { UiSkeleton, t, messageRef, uiLocale } from '../../ui';

import type { ChatListRow } from '../../shared/chatContracts.ts';
import type { UiFieldHandle } from '../../ui.ts';
import type { ChatSleepingSession } from '../../../../shared/chat/chatBackgroundTasks.ts';

import { onUnmounted, computed, nextTick, ref, watch } from 'vue';
import { captureChatScrollAnchor } from '../../shared/chatScrollAnchor.ts';
import { useChatStore } from '../../stores/chat.ts';
import { useProvidersStore } from '../../stores/providers.ts';
import ProviderIcon from '../../shared/ProviderIcon.vue';
import ChatSleepBadge from './ChatSleepBadge.vue';
import { useChatSleeping } from '../../composables/useChatSleeping.ts';
import {
  confirmDialog, UiButton, UiPopover, UiIconButton, UiCreateButton, UiInput, UiPressable,
  UiSearchInput, UiSpinner, UiSwitch, resolveUiText, vTooltip,
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

prov.load(false, { cached: true, reason: 'mount' });

const q = ref('');
const showArchived = ref(false);
const rowsHost = ref<HTMLElement | null>(null);
const paging = computed(() => chat.pageFor(q.value, showArchived.value));
let searchTimer: ReturnType<typeof setTimeout> | null = null;
let scopeEpoch = 0;
let restoringScope = false;

watch([q, showArchived], ([query, archived], previous) => {
  clearTimeout(searchTimer ?? undefined);

  const epoch = ++scopeEpoch;

  if (previous?.[0] !== undefined && rowsHost.value) {
    chat.pageFor(previous[0], previous[1]).scrollTop = rowsHost.value.scrollTop;
  }

  restoringScope = true;
  chat.beginChatSearch(query, archived);

  /**
   * Возврат к scope восстанавливает его scroll только после принятой порции.
   * Быстрый переход к другому поиску отменяет применение прежнего положения.
   */
  const load = async () => {
    await chat.searchChats(query, archived);
    await nextTick();

    if (epoch === scopeEpoch) {
      if (rowsHost.value) {
        rowsHost.value.scrollTop = paging.value.scrollTop;
      }

      restoringScope = false;
    }
  };

  if (query.trim()) {
    searchTimer = setTimeout(() => void load(), 250);
  } else {
    void load();
  }
}, { immediate: true });

onUnmounted(() => clearTimeout(searchTimer ?? undefined));

/**
 * Контейнер сообщает собственную прокрутку и загружает одну следующую порцию.
 * Кнопка продолжения остаётся доступной, когда строк недостаточно для overflow.
 */
function onRowsScroll() {
  const element = rowsHost.value;
  const page = paging.value;

  if (!element || restoringScope) {
    return;
  }

  page.scrollTop = element.scrollTop;

  if (page.loaded && page.hasMore && !page.loading && !page.error
    && element.scrollHeight - element.clientHeight - element.scrollTop <= 240) {
    void chat.loadChatPage(q.value, showArchived.value);
  }
}

const archiveLabel = computed(() => (
  t('core.chatPokazyvatArhivArchivedchatcount', { archivedChatCount: chat.archivedChatCount
          ? ` · ${chat.archivedChatCount}`
          : '' })
));
const emptyLabel = computed(() => {
  if (q.value.trim()) {
    return t('core.inboxNoResults');
  }

  return showArchived.value ? t('core.chatArhivPust') : t('core.chatNetAktivnyhChatov');
});

// Строки уже с моделью чата: кто отвечает (иконка исполнителя) и короткое имя модели.
// Резолвим здесь, а не в шаблоне — иначе поиск по реестру шёл бы на каждый рендер каждой строки.
const rows = computed(() => {
  if (!chat.loaded) {
    return [];
  }

  return chat.list(q.value, showArchived.value).map((r: ChatListRow) => {
    const { model, provider } = prov.modelOf(r.modelRef || r.model);

    return {
      ...r,
      provider,
      modelName: model?.name || '',
      sleep: sleepingSessions.value[r.id],
    };
  });
});

watch(() => rows.value.map((row) => row.id).join('\0'), async () => {
  if (!rowsHost.value || restoringScope) {
    return;
  }

  const restore = captureChatScrollAnchor(rowsHost.value, '[data-chat-id]');
  const atTop = rowsHost.value.scrollTop <= 1;
  const epoch = scopeEpoch;

  await nextTick();

  if (!rowsHost.value || restoringScope || epoch !== scopeEpoch) {
    return;
  }
  if (atTop) {
    rowsHost.value.scrollTop = 0;
  } else {
    restore();
  }
});

// Memo строки перечисляет всё, что рисует её поддерево, включая выбор и инлайн-редактор.
// Копия строки при обновлении другого чата не должна пересоздавать все controls списка.

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
  const modelName = row.modelName || t('core.chatModelPoUmolchaniyu');

  if (row.compacting) {
    return t('core.chatModelnameSzhimayuKontekst', { modelName: modelName });
  }
  if (row.sending) {
    return t('core.chatModelnameAgentRabotaet', { modelName: modelName });
  }

  return modelName;
}

/**
 * Относительное время сохраняет компактный телеграмный формат строки.
 * После недели календарная дата устойчивее постоянно растущего числа дней.
 */
const calendarDate = computed(
  () => new Intl.DateTimeFormat(uiLocale.value, { day: '2-digit', month: '2-digit' }),
);

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
    return t('core.chatSeychas');
  }
  if (elapsed < 3600e3) {
    return t('core.chatFloorelapsed60e3M', { floorelapsed60e3: Math.floor(elapsed / 60e3) });
  }
  if (elapsed < 86400e3) {
    return t('core.chatFloorelapsed3600e3Ch', { floorelapsed3600e3: Math.floor(elapsed / 3600e3) });
  }
  if (elapsed < 7 * 86400e3) {
    return t('core.chatFloorelapsed86400e3D', { floorelapsed86400e3: Math.floor(elapsed / 86400e3) });
  }

  return calendarDate.value.format(new Date(ts));
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

/**
 * Создание разрешено только после подтверждённого списка с сервера.
 * Мобильная область открывается, когда стор действительно создал разговор.
 */
function newChat() {
  if (!chat.loaded || !chat.newSession()) {
    return;
  }

  showArchived.value = false;
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
      ? messageRef('core.chatUdalitChatTitleBezvozvratno', { title: r.title })
      : messageRef('core.chatPeremestitChatTitleV', { title: r.title }),
    {
      title: permanent ? t('core.chatUdalitChatNavsegda') : t('core.chatPeremestitVArhiv'),
      okText: permanent ? t('core.taskDelete') : t('core.chatVArhiv'),
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
.top { display: flex; flex-direction: column; justify-content: center; gap: 4px;
  min-height: var(--chat-head-h); flex: none; padding: 8px 10px; border-bottom: 1px solid var(--line); }
.tools { display: flex; align-items: center; gap: 7px; }
.search { flex: 1; min-width: 0; }
/* Flex-контейнер убирает место под текстовую базовую линию inline-flex переключателя.
   Иначе шапка списка перерастает общий минимум и её нижняя граница образует ступеньку. */
.archive-toggle { display: flex; align-self: flex-start; }
.new { flex: none; }

.rows { flex: 1; overflow-y: auto; overflow-anchor: none; padding: 5px; }
.none { padding: 12px; font-size: 12.5px; text-align: center; }

.list-pending {
  padding-top: 12px;
}
.load-state {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 14px 20px;
}
.load-status {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.load-mark {
  display: grid;
  place-items: center;
  flex: none;
  width: 32px;
  height: 32px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--accent) 9%, transparent);
  color: var(--accent);
}
.load-mark svg {
  width: 20px;
  height: 20px;
}
.load-state-error .load-mark {
  background: color-mix(in srgb, var(--warn) 10%, transparent);
  color: var(--warn);
}
.load-copy {
  min-width: 0;
}
.load-title {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.load-hint,
.load-reason,
.load-retry-status {
  margin: 0;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.load-reason,
.load-retry-status {
  margin-top: 3px;
}
.list-skeleton {
  padding: 0 8px;
  pointer-events: none;
  mask-image: linear-gradient(to bottom, #000 15%, transparent 100%);
}
.skeleton-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: var(--chat-list-row-h);
  padding: 8px 6px;
}
.skeleton-avatar {
  width: var(--chat-avatar-size);
  flex: none;
}
.skeleton-copy {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: 9px;
}
.skeleton-title {
  width: 68%;
}
.skeleton-snippet {
  width: 90%;
}
.skeleton-time {
  align-self: flex-start;
  width: 22px;
  margin-top: 8px;
}
.skeleton-row:nth-child(even) .skeleton-title {
  width: 50%;
}
.skeleton-row:nth-child(3n) .skeleton-snippet {
  width: 65%;
}
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

@media (max-width: 600px) {
  .top {
    min-height: 0;
    padding: 6px 12px;
    gap: 4px;
  }
  .rows { padding: 4px 6px; }
  .row { gap: 8px; padding: 8px 6px; }
  .name { font-size: 15px; }
  .t2 { font-size: 13px; margin-top: 4px; }
  .mdl { max-width: 72px; }
}
</style>
