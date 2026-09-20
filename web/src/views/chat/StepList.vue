<template>
  <div v-if="rows.length" class="steps" :class="{ live }">
    <!-- Сохранённая лента свёрнута: сначала ответ, детали — по клику -->
    <UiDisclosureButton
      v-if="!live"
      class="summary-disclosure"
      density="compact"
      :open="open"
      :controls="`${baseId}-list`"
      @update:open="open = $event"
    >
      <span class="sum">Ход агента: {{ summary }}</span>
    </UiDisclosureButton>
    <div v-if="open || live" :id="`${baseId}-list`" class="list">
      <div v-for="(r, i) in rows" :key="i" class="step" :class="[r.k, r.sub ? 'nested' : '']">
        <!-- Размышление -->
        <template v-if="r.k === 'think'">
          <UiDisclosureButton
            class="step-disclosure"
            density="compact"
            :open="Boolean(expanded[i])"
            :controls="`${baseId}-step-${i}`"
            :disabled="!hasBody(r)"
            @update:open="toggle(i, r)"
          >
            <span class="head think">
              <span class="ico">✻</span>
              <span class="ttl">
                Размышление<template v-if="r.secs"> · {{ r.secs }} с</template>
              </span>
            </span>
          </UiDisclosureButton>
          <pre v-if="expanded[i]" :id="`${baseId}-step-${i}`" class="body">{{ r.text }}</pre>
        </template>

        <!-- Промежуточный текст агента -->
        <div v-else-if="r.k === 'text'" class="say">{{ r.text }}</div>

        <!-- Вызов инструмента + его результат -->
        <template v-else-if="r.k === 'tool'">
          <UiDisclosureButton
            class="step-disclosure"
            density="compact"
            :open="Boolean(expanded[i])"
            :controls="`${baseId}-step-${i}`"
            :disabled="!hasBody(r)"
            @update:open="toggle(i, r)"
          >
            <span class="head" :class="kindOf(r.name).cls">
              <span class="ico">{{ kindOf(r.name).ico }}</span>
              <span class="nm">{{ toolLabel(r.name) }}</span>
              <span class="ttl" :title="r.command || r.title">{{ r.title }}</span>
              <span v-if="r.diff || hasRichDiff(r)" class="stat">{{ diffStat(r) }}</span>
              <span v-else-if="r.lines" class="stat">{{ r.lines }} стр.</span>
              <span v-if="r.res" class="mark" :class="{ bad: !r.res.ok }">
                {{ r.res.ok ? '✓' : '✕' }}
              </span>
              <span v-else-if="live" class="mark run">…</span>
            </span>
          </UiDisclosureButton>
          <div v-if="expanded[i]" :id="`${baseId}-step-${i}`" class="body-wrap">
            <div v-if="r.sub" class="path">{{ r.sub }}</div>
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
            <pre v-if="r.res?.text" class="body res" :class="{ bad: !r.res.ok }">{{ r.res.text }}</pre>
          </div>
        </template>

        <!-- Итог вызова, чья строка не дожила до этой ленты -->
        <template v-else-if="r.k === 'res'">
          <UiDisclosureButton
            class="step-disclosure"
            density="compact"
            :open="Boolean(expanded[i])"
            :controls="`${baseId}-step-${i}`"
            :disabled="!r.text"
            @update:open="toggle(i, r)"
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
            v-if="expanded[i] && r.text"
            :id="`${baseId}-step-${i}`"
            class="body res"
            :class="{ bad: !r.ok }"
          >{{ r.text }}</pre>
        </template>

        <!-- Служебное: старт хода, ретраи, сжатие контекста -->
        <div v-else-if="r.k === 'start'" class="note start">
          старт · модель <b>{{ modelLabel(r.model) || '?' }}</b><template v-if="r.mode"> · режим {{ r.mode }}</template>
        </div>
        <div v-else-if="r.k === 'note'" class="note" :class="r.level">
          {{ r.text }}<template v-if="r.times > 1"> ×{{ r.times }}</template>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, useId } from 'vue';
import { lineDiff, splitRows, unifiedDiff } from '../../shared/diff.js';
import { UiDisclosureButton } from '../../ui';

// Лента хода агента: размышления, вызовы инструментов и их результаты —
// то же, что видно в чате VS Code. Живая (пока агент работает) и сохранённая
// (в истории сообщения) ленты рисуются одним компонентом.
const props = defineProps({
  steps: { type: Array, default: () => [] },
  live: { type: Boolean, default: false }, // ход идёт прямо сейчас
  // Подпись модели в шаге «старт»: id → имя из каталога. Реестр знает чат, а не лента,
  // поэтому функция приходит снаружи; без неё показывается id как есть.
  modelLabel: { type: Function, default: (id) => id },
});

// Свёрнутая по умолчанию сохранённая лента (в живой всё видно сразу).
const open = ref(props.live);
const expanded = ref({}); // индекс шага → раскрыт ли
const baseId = `chat-steps-${useId().replaceAll(':', '')}`;

// Результаты приклеиваем к своим вызовам (res приходит отдельным шагом с тем же id) —
// строка ленты должна быть одна: «инструмент + чем закончился».
const rows = computed(() => {
  const out = [];
  const byId = new Map();
  for (const s of props.steps || []) {
    if (s.k === 'res') {
      const tool = byId.get(s.id);
      if (tool) { tool.res = s; continue; }
      // Вызов не дошёл (его вытеснило окно ленты) — результат всё равно показываем
      // своей строкой: раньше он молча превращался в пустую строку без разметки.
    }
    // Исполнитель дослал подробности уже показанного вызова — обновляем ТУ ЖЕ строку.
    // Иначе одно действие выглядело бы двумя, а свежий вариант — повтором.
    if (s.k === 'tool' && s.id) {
      const known = byId.get(s.id);
      if (known) { Object.assign(known, s); continue; }
    }
    // Одинаковые служебные строки подряд (ретраи сети идут сериями) — одной строкой с «×N».
    const prev = out[out.length - 1];
    if (s.k === 'note' && prev?.k === 'note' && prev.text === s.text) {
      prev.times = (prev.times || 1) + 1;
      continue;
    }
    const row = { ...s };
    if (s.k === 'tool' && s.id) byId.set(s.id, row);
    out.push(row);
  }
  // Сколько агент думал: блок размышления приходит уже готовым, поэтому его длительность —
  // это время от ПРЕДЫДУЩЕГО шага до него (как «Thought for 49s» в VS Code).
  for (let i = 1; i < out.length; i++) {
    if (out[i].k !== 'think' || !out[i].at) continue;
    const prev = out[i - 1]?.at;
    if (prev && out[i].at > prev) out[i].secs = Math.round((out[i].at - prev) / 1000);
  }
  return out;
});

const toolCount = computed(() => rows.value.filter((r) => r.k === 'tool').length);
const summary = computed(() => {
  const think = rows.value.filter((r) => r.k === 'think').length;
  const parts = [];
  if (toolCount.value) parts.push(`${toolCount.value} действ.`);
  if (think) parts.push(`${think} размышл.`);
  return parts.join(' · ') || `${rows.value.length} шаг.`;
});

// Дифф правки считаем лениво — только для раскрытого шага.
function diffOf(row) {
  return lineDiff(row.diff?.old, row.diff?.new);
}
function changesOf(row) {
  return Array.isArray(row.changes)
    ? row.changes.filter((change) => change && typeof change === 'object')
    : [];
}
function changeDiffOf(change) {
  if (typeof change.diff === 'string') return unifiedDiff(change.diff, change.kind);
  return lineDiff(change.diff?.old, change.diff?.new);
}
// Пары строк для показа в две колонки (слева убрано, справа добавлено).
function splitOf(row) {
  return splitRows(diffOf(row).rows);
}
function splitChangeOf(change) {
  return splitRows(changeDiffOf(change).rows);
}
function hasChangeDiff(change) {
  return typeof change?.diff === 'string'
    || (change?.diff && typeof change.diff === 'object');
}
function hasRichDiff(row) {
  return changesOf(row).some(hasChangeDiff);
}
function diffStat(row) {
  if (hasRichDiff(row)) {
    const stat = changesOf(row).reduce((sum, change) => {
      if (!hasChangeDiff(change)) return sum;
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
function toggle(i, row) {
  // Раскрывать есть что только у шагов с телом.
  if (!hasBody(row)) return;
  expanded.value[i] = !expanded.value[i];
}
function hasBody(row) {
  return !!(
    row.text || row.command || row.preview || row.diff || row.res?.text || row.sub
    || changesOf(row).length
  );
}

// Иконка и подпись вида шага.
const KIND = {
  Bash: { ico: '❯', cls: 'bash' },
  Read: { ico: '👁', cls: 'read' },
  Write: { ico: '✎', cls: 'write' },
  Edit: { ico: '✎', cls: 'write' },
  NotebookEdit: { ico: '✎', cls: 'write' },
  Glob: { ico: '🔎', cls: 'find' },
  Grep: { ico: '🔎', cls: 'find' },
  Task: { ico: '🤖', cls: 'task' },
  WebFetch: { ico: '🌐', cls: 'web' },
  WebSearch: { ico: '🌐', cls: 'web' },
  TodoWrite: { ico: '☑', cls: 'todo' },
  AskUserQuestion: { ico: '❓', cls: 'ask' },
  ExitPlanMode: { ico: '📋', cls: 'plan' },
  Skill: { ico: '⚙', cls: 'skill' },
};
function kindOf(name) {
  if (KIND[name]) return KIND[name];
  return name?.startsWith('mcp__') ? { ico: '🔌', cls: 'mcp' } : { ico: '•', cls: 'other' };
}
function toolLabel(name) {
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

.sum {
  font-size: 12px;
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
.head .nm { flex: none; color: var(--ink); font-weight: 600; font-size: 12px; }
.head .ttl { color: var(--ink-mid); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0;
  font-family: var(--mono, monospace); font-size: 11.5px; }
.head.think .ttl { font-family: inherit; font-size: 12px; }
.head .stat { flex: none; font-size: 11px; color: var(--ink-mid); opacity: .85; }
.head .mark { flex: none; color: var(--good); font-size: 11px; }
.head .mark.bad { color: var(--bad); }
.head .mark.run { color: var(--accent); }
.head.bash .ico { color: var(--accent); }
.head.write .ico { color: var(--warn, #e0a33a); }
.head.read .ico, .head.find .ico { color: var(--ink-mid); }
.head.task .ico, .head.mcp .ico { color: var(--accent); }
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
  color: var(--ink-mid);
  white-space: pre-line;
  overflow-wrap: anywhere;
}
.note.warn { color: var(--warn, #e0a33a); }
.note.start b { color: var(--ink); font-weight: 600; }
</style>
