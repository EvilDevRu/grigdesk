<template>
  <div v-if="rows.length" class="steps" :class="{ live, section }">
    <!-- Сохранённая лента свёрнута: сначала ответ, детали — по клику -->
    <UiDisclosureButton
      v-if="!live"
      class="summary-disclosure"
      density="compact"
      :open="open"
      :controls="`${baseId}-list`"
      :aria-label="section ? `Действия агента: ${summary}` : undefined"
      @update:open="open = $event"
    >
      <span v-if="section" class="head activity-summary">
        <svg class="ico" width="15" height="15" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
          <path d="M4 6h16M4 12h16M4 18h10" />
        </svg>
        <span class="sum">{{ summary }}</span>
      </span>
      <span v-else class="sum">Ход агента: {{ summary }}</span>
    </UiDisclosureButton>
    <div v-if="open || live" :id="`${baseId}-list`" class="list">
      <div v-for="r in rows" :key="r.rowKey" class="step" :class="[r.k, isNested(r) ? 'nested' : '']">
        <!-- Размышление -->
        <template v-if="r.k === 'think'">
          <UiDisclosureButton
            class="step-disclosure"
            density="compact"
            :open="Boolean(expanded[r.rowKey])"
            :controls="`${baseId}-${r.rowKey}`"
            :disabled="!hasBody(r)"
            @update:open="toggle(r)"
          >
            <span class="head think">
              <span class="ico">✻</span>
              <span class="ttl">
                Размышление<template v-if="r.secs"> · {{ r.secs }} с</template>
              </span>
            </span>
          </UiDisclosureButton>
          <pre v-if="expanded[r.rowKey]" :id="`${baseId}-${r.rowKey}`" class="body">{{ r.text }}</pre>
        </template>

        <!-- Промежуточный текст агента -->
        <div v-else-if="r.k === 'text'" class="say">{{ r.text }}</div>

        <!-- Вызов инструмента + его результат -->
        <template v-else-if="r.k === 'tool'">
          <UiDisclosureButton
            class="step-disclosure"
            density="compact"
            :open="Boolean(expanded[r.rowKey])"
            :controls="`${baseId}-${r.rowKey}`"
            :disabled="!hasBody(r)"
            @update:open="toggle(r)"
          >
            <span class="head" :class="kindOf(r.name).cls">
              <span class="ico">{{ kindOf(r.name).ico }}</span>
              <span class="nm">{{ toolLabel(r.name) }}</span>
              <span class="ttl">{{ r.title }}</span>
              <span v-if="r.diff || hasRichDiff(r)" class="stat">{{ diffStat(r) }}</span>
              <span v-else-if="r.lines" class="stat">{{ r.lines }} стр.</span>
              <span v-if="r.res" class="mark" :class="{ bad: !r.res!.ok }">
                {{ r.res.ok ? '✓' : '✕' }}
              </span>
              <span v-else-if="live" class="mark run">…</span>
            </span>
          </UiDisclosureButton>
          <div v-if="expanded[r.rowKey]" :id="`${baseId}-${r.rowKey}`" class="body-wrap">
            <div v-if="pathOf(r)" class="path">{{ pathOf(r) }}</div>
            <!-- Рассмотренная картинка идёт через защищённый маршрут рабочей папки чата.
                 Обычный щелчок по ней перехватывает чат и открывает общий просмотрщик. -->
            <template v-if="imageOf(r)">
              <div v-if="brokenImages.has(imageOf(r))" class="step-image-missing">Изображение недоступно</div>
              <a v-else class="step-image" :href="imageOf(r)" target="_blank" rel="noopener">
                <img :src="imageOf(r)" :alt="r.title || 'Изображение'" loading="lazy"
                     @error="brokenImages.add(imageOf(r))" />
              </a>
            </template>
            <!-- В компактной строке команда сокращена; в раскрытии видны начало и конец. -->
            <pre v-if="r.command" class="body command">{{ r.command }}</pre>
            <!-- Один вызов инструмента может изменить несколько файлов. -->
            <div v-if="changesOf(r).length" class="changes">
              <div v-for="(change, c) in changesOf(r)" :key="`${change.path || ''}:${c}`" class="change">
                <div v-if="change.path" class="path">{{ change.path }}</div>
                <div v-if="hasChangeDiff(change)" class="diff">
                  <div class="dhead"><span>было</span><span>стало</span></div>
                  <div v-for="(d, k) in splitChangeOf(change)" :key="k" class="drow">
                    <div class="dcell" :class="d.l?.t || 'nil'">{{ d.l ? d.l.text || ' ' : '' }}</div>
                    <div class="dcell" :class="d.r?.t || 'nil'">{{ d.r ? d.r.text || ' ' : '' }}</div>
                  </div>
                </div>
              </div>
            </div>
            <!-- Дифф правки в две колонки: слева убранное, справа добавленное -->
            <div v-if="r.diff && !hasRichDiff(r)" class="diff">
              <div class="dhead"><span>было</span><span>стало</span></div>
              <div v-for="(d, k) in splitOf(r)" :key="k" class="drow">
                <div class="dcell" :class="d.l?.t || 'nil'">{{ d.l ? d.l.text || ' ' : '' }}</div>
                <div class="dcell" :class="d.r?.t || 'nil'">{{ d.r ? d.r.text || ' ' : '' }}</div>
              </div>
            </div>
            <pre v-if="r.preview" class="body">{{ r.preview }}</pre>
            <pre v-if="resTextOf(r)" class="body res" :class="{ bad: !r.res!.ok }">{{ resTextOf(r) }}</pre>
          </div>
        </template>

        <!-- Итог вызова, чья строка не дожила до этой ленты -->
        <template v-else-if="r.k === 'res'">
          <UiDisclosureButton
            class="step-disclosure"
            density="compact"
            :open="Boolean(expanded[r.rowKey])"
            :controls="`${baseId}-${r.rowKey}`"
            :disabled="!r.text"
            @update:open="toggle(r)"
          >
            <span class="head other">
              <span class="ico">•</span>
              <span class="nm">Итог</span>
              <span class="ttl">действие вытеснено из ленты</span>
              <span v-if="r.lines" class="stat">{{ r.lines }} стр.</span>
              <span class="mark" :class="{ bad: !r.ok }">{{ r.ok ? '✓' : '✕' }}</span>
            </span>
          </UiDisclosureButton>
          <pre
            v-if="expanded[r.rowKey] && r.text"
            :id="`${baseId}-${r.rowKey}`"
            class="body res"
            :class="{ bad: !r.ok }"
          >{{ r.text }}</pre>
        </template>

        <!-- Служебное: старт хода, ретраи, сжатие контекста -->
        <div v-else-if="r.k === 'start'" class="note start">
          старт · модель <b>{{ modelLabel(r.model) || '?' }}</b><template v-if="r.mode"> · режим {{ r.mode }}</template>
        </div>
        <div v-else-if="r.k === 'note'" class="note" :class="r.level">
          {{ r.text }}<template v-if="r.times! > 1"> ×{{ r.times }}</template>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { PropType } from 'vue';
import type { ChatStep, ChatChange } from '../../shared/chatContracts.ts';

import { ref, reactive, computed, useId, watch } from 'vue';
import { STEP_IMAGE_TEXT } from '../../../../shared/chat/chatSteps.ts';
import { lineDiff, splitRows, unifiedDiff } from '../../shared/diff.ts';
import { api } from '../../shared/apiClient.ts';
import { UiDisclosureButton } from '../../ui';
import { chatWorkdirImageHref } from './chatImages.ts';
import { foldChatSteps, nestChatStepRows } from './chatStepRows.ts';
import type { StepRow } from './chatStepRows.ts';

// Лента хода агента: размышления, вызовы инструментов и их результаты —
// то же, что видно в чате VS Code. Живая (пока агент работает) и сохранённая
// (в истории сообщения) ленты рисуются одним компонентом.
const props = defineProps({
  steps: { type: Array as PropType<ChatStep[]>, default: () => [] },
  live: { type: Boolean, default: false }, // ход идёт прямо сейчас
  section: { type: Boolean, default: false }, // участок общей ленты между репликами
  displayedAssistantIds: { type: Array as PropType<string[]>, default: () => [] },
  // Подпись модели в шаге «старт»: id → имя из каталога. Реестр знает чат, а не лента,
  // поэтому функция приходит снаружи; без неё показывается id как есть.
  modelLabel: {
    type: Function as PropType<(id?: string) => unknown>,
    default: (id: string | undefined) => id,
  },
  // Разговор, из рабочей папки которого сервер отдаёт рассмотренные агентом картинки.
  chatId: { type: String, default: '' },
});

// Свёрнутая по умолчанию сохранённая лента (в живой всё видно сразу).
const open = ref(props.live);
const expanded = ref<Record<string, boolean>>({}); // устойчивый ключ строки → раскрыта ли
// Адреса, которые сервер или браузер не отдали. Ключ — адрес, а не номер строки: окно
// ленты сдвигает номера, а повторное раскрытие не перезапрашивает уже битый файл.
const brokenImages = reactive(new Set<string>());
const baseId = `chat-steps-${useId().replaceAll(':', '')}`;

// После финала тот же участок становится свёрнутой историей.
// Его стабильный ключ сохраняет место, но не прежнюю высоту живой ленты.
watch(() => props.live, (live) => {
  open.value = live;
});

// Склейка и длительности используют порядок прихода, а показ собирает детей под вызовом.
// История остаётся неизменной; ключи раскрытия не зависят от позиции в готовом списке.
const rows = computed(() => nestChatStepRows(foldChatSteps(
  props.steps || [],
  new Set(props.displayedAssistantIds),
)));

const toolCount = computed(() => rows.value.filter((r) => r.k === 'tool').length);
const summary = computed(() => {
  const think = rows.value.filter((r) => r.k === 'think').length;
  const parts = [];

  if (toolCount.value) {
    parts.push(`${toolCount.value} действ.`);
  }
  if (think) {
    parts.push(`${think} размышл.`);
  }

  return parts.join(' · ') || `${rows.value.length} шаг.`;
});

// Дифф правки считаем лениво — только для раскрытого шага.
function diffOf(row: StepRow) {
  return lineDiff(row.diff?.old, row.diff?.new);
}

function changesOf(row: StepRow) {
  return Array.isArray(row.changes)
    ? row.changes.filter((change) => change && typeof change === 'object')
    : [];
}

function changeDiffOf(change: ChatChange) {
  if (typeof change.diff === 'string') {
    return unifiedDiff(change.diff, change.kind);
  }

  return lineDiff(change.diff?.old, change.diff?.new);
}
// Пары строк для показа в две колонки (слева убрано, справа добавлено).
function splitOf(row: StepRow) {
  return splitRows(diffOf(row).rows);
}

function splitChangeOf(change: ChatChange) {
  return splitRows(changeDiffOf(change).rows);
}

function hasChangeDiff(change: ChatChange) {
  return typeof change?.diff === 'string'
    || (change?.diff && typeof change.diff === 'object');
}

function hasRichDiff(row: StepRow) {
  return changesOf(row).some(hasChangeDiff);
}

function diffStat(row: StepRow) {
  if (hasRichDiff(row)) {
    const stat = changesOf(row).reduce((sum, change) => {
      if (!hasChangeDiff(change)) {
        return sum;
      }

      const diff = changeDiffOf(change);

      sum.added += diff.added;
      sum.removed += diff.removed;

      return sum;
    }, { added: 0, removed: 0 });

    return `+${stat.added} −${stat.removed}`;
  }

  const d = diffOf(row);

  return `+${d.added} −${d.removed}`;
}

function toggle(row: StepRow) {
  // Раскрывать есть что только у шагов с телом.
  if (!hasBody(row)) {
    return;
  }

  expanded.value[row.rowKey] = !expanded.value[row.rowKey];
}

function hasBody(row: StepRow) {
  return !!(
    row.text || row.command || row.preview || row.diff || row.res?.text || pathOf(row)
    || changesOf(row).length
  );
}

// Подпись шага (путь файла, сервер MCP, пространство имён) — только строка: в сохранённых
// лентах старых ходов `sub` бывает булевым признаком вложенности, показывать его нечего.
function pathOf(row: StepRow) {
  return typeof row.sub === 'string' ? row.sub : '';
}

// Картинка, которую агент рассмотрел (Read) или создал (GenerateImage), показывается
// после успешного итога. Адрес даёт только маршрут картинок разговора: внешний URL и готовый
// адрес /api из пути инструмента в ленту не попадают, а сервер отдаёт лишь растр из
// рабочей папки или объявленного исполнителем каталога.
function imageOf(row: StepRow) {
  if (!IMAGE_STEPS.has(row.name || '') || !row.res?.ok) {
    return '';
  }

  const href = chatWorkdirImageHref(pathOf(row), props.chatId);

  return href ? api.url(href) : '';
}

// Нормализатор заменяет блок картинки в итоге общей заглушкой STEP_IMAGE_TEXT.
// Рядом с самой картинкой или с отметкой о её недоступности эта строка ничего не добавляет.
function resTextOf(row: StepRow) {
  const text = row.res?.text || '';

  return text.trim() === STEP_IMAGE_TEXT && imageOf(row) ? '' : text;
}

// Вложенный шаг — шаг субагента: у него `parent` (id вызова Agent/Task). Старые ленты несли
// вместо него `sub: true` — их читаем так же, чтобы сохранённые ходы не поменяли вид.
function isNested(row: StepRow) {
  return Boolean(row.parent) || row.sub === true;
}

const IMAGE_STEPS = new Set(['Read', 'GenerateImage']);

// Иконка и подпись вида шага.
const KIND: Record<string, { ico: string; cls: string }> = {
  Bash: { ico: '❯', cls: 'bash' },
  Read: { ico: '👁', cls: 'read' },
  GenerateImage: { ico: '🖼', cls: 'read' },
  Write: { ico: '✎', cls: 'write' },
  Edit: { ico: '✎', cls: 'write' },
  NotebookEdit: { ico: '✎', cls: 'write' },
  Glob: { ico: '🔎', cls: 'find' },
  Grep: { ico: '🔎', cls: 'find' },
  Agent: { ico: '🤖', cls: 'task' },
  Task: { ico: '🤖', cls: 'task' },
  WebFetch: { ico: '🌐', cls: 'web' },
  WebSearch: { ico: '🌐', cls: 'web' },
  TodoWrite: { ico: '☑', cls: 'todo' },
  AskUserQuestion: { ico: '❓', cls: 'ask' },
  ExitPlanMode: { ico: '📋', cls: 'plan' },
  Skill: { ico: '⚙', cls: 'skill' },
};

/**
 * Знакомое имя инструмента выбирает его прежнюю иконку.
 * Неизвестный MCP-вызов сохраняет общую подпись подключения.
 */
function kindOf(name: string | undefined) {
  if (name && KIND[name]) {
    return KIND[name];
  }

  return name?.startsWith('mcp__') ? { ico: '🔌', cls: 'mcp' } : { ico: '•', cls: 'other' };
}

function toolLabel(name: string | undefined) {
  // mcp__playwright__browser_click → playwright · browser_click
  if (name?.startsWith('mcp__')) {
    const [, srv, ...rest] = name.split('__');

    return `${srv} · ${rest.join('__')}`;
  }

  return name;
}
</script>

<style scoped>
.steps { display: flex; flex-direction: column; gap: 2px; font-size: 12.5px; }
.summary-disclosure {
  align-self: flex-start;
}
.activity-summary { color: var(--ink-low); }

.sum {
  font-size: 12px;
  color: var(--ink-low);
}
.list { display: flex; flex-direction: column; gap: 2px; }
.step.nested { padding-left: 16px; border-left: 1px dashed var(--line); }

.step-disclosure {
  width: 100%;
  min-width: 0;
}

.head {
  display: inline-flex;
  flex: 1;
  align-items: center;
  gap: 7px;
  width: 100%;
  min-width: 0;
  text-align: left;
}
.head .ico { flex: none; width: 15px; text-align: center; font-size: 12px; }
.head .nm { flex: none; color: var(--ink-mid); font-weight: 500; font-size: 12px; }
.head .ttl { color: var(--ink-low); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0;
  font-family: var(--mono, monospace); font-size: 11.5px; }
.head.think .ttl { font-family: inherit; font-size: 12px; }
.head .stat { flex: none; font-size: 11px; color: var(--ink-mid); opacity: .85; }
.head .mark { flex: none; color: var(--good); font-size: 11px; }
.head .mark.bad { color: var(--bad); }
.head .mark.run { color: var(--accent); }
.head.bash .ico { color: color-mix(in srgb, var(--accent) 70%, var(--ink-low)); }
.head.write .ico { color: color-mix(in srgb, var(--warn) 70%, var(--ink-low)); }
.head.read .ico, .head.find .ico { color: var(--ink-mid); }
.head.task .ico, .head.mcp .ico { color: color-mix(in srgb, var(--accent) 70%, var(--ink-low)); }
.head.ask .ico { color: var(--warn, #e0a33a); }

.body-wrap { padding: 2px 0 6px 26px; display: flex; flex-direction: column; gap: 4px; }
.path { font-size: 11px; color: var(--ink-mid); font-family: var(--mono, monospace); word-break: break-all; }
.changes, .change { display: flex; flex-direction: column; gap: 4px; }
.change + .change { margin-top: 4px; }
.body { margin: 0; padding: 7px 10px; background: var(--ground); border: 1px solid var(--line); border-radius: 8px;
  font-size: 11.5px; line-height: 1.45; color: var(--ink-mid); white-space: pre-wrap; word-break: break-word;
  max-height: 260px; overflow: auto; }
.body.command { color: var(--ink); overflow-wrap: anywhere; }
.step.think .body { margin-left: 26px; }
.body.res.bad { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 35%, var(--line)); }

/* Миниатюра рассмотренной картинки: целиком в рамке, полный размер — в просмотрщике. */
.step-image {
  align-self: flex-start;
  display: block;
  max-width: 100%;
  overflow: hidden;
  background: var(--ground);
  border: 1px solid var(--line);
  border-radius: 8px;
  cursor: zoom-in;
}
.step-image img {
  display: block;
  max-width: 100%;
  max-height: 260px;
  object-fit: contain;
}
.step-image-missing {
  font-size: 11.5px;
  color: var(--ink-low);
}

/* Дифф правки — две колонки: слева было, справа стало */
.diff { border: 1px solid var(--line); border-radius: 8px; overflow: auto; max-height: 320px; background: var(--ground); }
.dhead, .drow { display: grid; grid-template-columns: 1fr 1fr; }
.dhead { position: sticky; top: 0; z-index: 1; background: var(--surface-2); font-size: 10.5px;
  text-transform: uppercase; letter-spacing: .04em; color: var(--ink-mid); }
.dhead span { padding: 3px 10px; }
.dhead span + span, .drow .dcell + .dcell { border-left: 1px solid var(--line); }
.dcell { font-family: var(--mono, monospace); font-size: 11.5px; line-height: 1.5; padding: 0 10px;
  white-space: pre-wrap; word-break: break-word; color: var(--ink-mid); min-width: 0; }
.dcell.del { background: color-mix(in srgb, var(--bad) 14%, transparent); color: color-mix(in srgb, var(--bad) 85%, var(--ink)); }
.dcell.add { background: color-mix(in srgb, var(--good) 14%, transparent); color: color-mix(in srgb, var(--good) 85%, var(--ink)); }
/* Пустая половина пары — заметная «дыра», чтобы сдвиг строк читался */
.dcell.nil { background: color-mix(in srgb, var(--surface-2) 60%, transparent); }
.dcell.del::before { content: '− '; opacity: .7; }
.dcell.add::before { content: '+ '; opacity: .7; }

.say { padding: 3px 4px 3px 26px; color: var(--ink); white-space: pre-wrap; }
/* Отступ — только у самой строки: внешний .step тоже носит класс вида шага (note),
   и общий селектор давал служебной строке двойной сдвиг относительно соседних. */
.step > .note {
  padding: 2px 4px 2px 26px;
  font-size: 11.5px;
  line-height: 1.45;
  color: var(--ink-low);
  white-space: pre-line;
  overflow-wrap: anywhere;
}
.section .step > .note { padding-left: 27px; }
.note.warn { color: var(--warn, #e0a33a); }
.note.start b { color: var(--ink-mid); font-weight: 500; }
</style>
