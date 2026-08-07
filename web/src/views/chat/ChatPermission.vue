<script setup>
// Всплывашка разрешения: агент просит выполнить действие (Bash, правка файла…) либо
// показывает готовый план на утверждение. Живёт над композером, поэтому компактная:
// суть и кнопки — одной строкой, детали — под ней.
//
// Показываем РАЗОБРАННЫЙ запрос, а не его JSON. Поля контракта (`command`,
// `file_path`, `diff`, `plan`, `details`, `description`, `choices`) кладёт исполнитель;
// голый JSON остался последним фоллбэком для незнакомой формы — читать его человеку
// невозможно, а раньше именно он и показывался у Kimi.
import { ref, computed, watch } from 'vue';
import { lineDiff, splitRows } from '../../shared/diff.js';
import { promptDialog } from '../../shared/ui/confirm.js';

const props = defineProps({
  // Запрос из стора чата: { pid, tool, input, chatKey }
  req: { type: Object, required: true },
});
// (allow: boolean, remember: boolean, comment: string, choice: string)
const emit = defineEmits(['answer']);

// «Не спрашивать до конца сессии» — сбрасывается на каждый новый запрос.
const remember = ref(false);
watch(() => props.req?.pid, () => { remember.value = false; });

const input = computed(() => props.req?.input || {});

// План на утверждение — отдельный разговор: и подписи кнопок про план, и сам он
// показывается целиком. Признак — сам текст плана в запросе (Kimi), имя инструмента
// ExitPlanMode (Claude) оставлено как второй признак.
const isPlan = computed(() => !!input.value.plan || props.req?.tool === 'ExitPlanMode');

const plan = computed(() => String(input.value.plan || ''));
const command = computed(() => String(input.value.command || ''));
const filePath = computed(() => String(input.value.file_path || ''));
const details = computed(() => String(input.value.details || ''));
// Короткая строка «что собирается сделать» — заголовок тела всплывашки.
const description = computed(() => String(input.value.description || ''));

const diff = computed(() => {
  const d = input.value.diff;
  if (!d || (!d.old && !d.new)) return null;
  const rows = lineDiff(d.old, d.new);
  return { split: splitRows(rows.rows), stat: `+${rows.added} −${rows.removed}` };
});

// Варианты ответа самого исполнителя (у Kimi у плана их больше двух: утвердить,
// доработать, выйти). Если они есть — кнопками идут именно они, а не наша пара:
// подменять чужой выбор своим значило бы отвечать агенту не то, что нажал человек.
const choices = computed(() => (Array.isArray(input.value.choices) ? input.value.choices : [])
  .filter((c) => c && c.id && c.label));
const isAllowChoice = (c) => c.kind === 'allow_once' || c.kind === 'allow_always';

// Незнакомая форма запроса: показываем как есть — лучше нечитаемый JSON, чем пустая
// плашка с двумя кнопками и без единого слова о том, что разрешают.
const KNOWN = new Set(['kind', 'description', 'details', 'plan', 'command', 'file_path', 'diff', 'choices']);
const rest = computed(() => {
  const extra = Object.fromEntries(Object.entries(input.value).filter(([k, v]) => !KNOWN.has(k) && v !== '' && v != null));
  if (Object.keys(extra).length) return JSON.stringify(extra);
  // Не разобрали вообще ничего — значит показывать нечего, кроме исходника.
  const shown = plan.value || command.value || filePath.value || details.value || description.value || diff.value;
  if (shown) return '';
  const s = JSON.stringify(input.value);
  return s === '{}' ? '' : s;
});

// Отказ — с пояснением: голый deny не говорит агенту, что поменять, а человеку
// непонятно, куда писать замечания. Пустое пояснение разрешено — тогда как раньше.
// Отмена модалки (Esc/фон) возвращает в карточку, не отклоняя.
async function reject(choice = '') {
  const text = await promptDialog({
    title: isPlan.value ? 'Что доработать в плане?' : 'Почему отклоняете?',
    placeholder: 'можно оставить пустым',
  });
  if (text === null) return;
  emit('answer', false, false, text.trim(), choice);
}

function choose(c) {
  if (isAllowChoice(c)) return emit('answer', true, remember.value, '', c.id);
  return reject(c.id);
}
</script>

<template>
  <div class="perm" :class="{ plan: isPlan }">
    <div class="col">
      <!-- Кнопки — в строке заголовка: их видно всегда, какой бы длинной ни была команда -->
      <div class="p-row">
        <span class="p-t">
          <template v-if="isPlan">План готов — утвердить?</template>
          <template v-else>Разрешить <span class="p-tool">{{ req.tool }}</span>?</template>
        </span>
        <span class="p-act">
          <template v-if="choices.length">
            <button v-for="c in choices" :key="c.id" :class="isAllowChoice(c) ? 'p-ok' : 'p-no'" @click="choose(c)">
              {{ c.label }}
            </button>
          </template>
          <template v-else>
            <button class="p-ok" @click="emit('answer', true, remember)">{{ isPlan ? 'Утвердить' : 'Разрешить' }}</button>
            <button class="p-no" @click="reject()">{{ isPlan ? 'Доработать' : 'Отклонить' }}</button>
          </template>
        </span>
      </div>

      <!-- Что именно собирается сделать агент -->
      <div v-if="description" class="p-desc">{{ description }}</div>
      <div v-if="filePath" class="p-path">{{ filePath }}</div>
      <!-- Команда/план/детали — целиком, с переносами: решение принимают по тому, что видно -->
      <pre v-if="command" class="p-in cmd">{{ command }}</pre>
      <pre v-if="plan" class="p-in big">{{ plan }}</pre>
      <!-- Дифф правки в две колонки: слева убранное, справа добавленное -->
      <div v-if="diff" class="p-diff">
        <div class="dhead"><span>было</span><span>стало {{ diff.stat }}</span></div>
        <div v-for="(d, k) in diff.split" :key="k" class="drow">
          <div class="dcell" :class="d.l?.t || 'nil'">{{ d.l ? d.l.text || ' ' : '' }}</div>
          <div class="dcell" :class="d.r?.t || 'nil'">{{ d.r ? d.r.text || ' ' : '' }}</div>
        </div>
      </div>
      <pre v-if="details" class="p-in">{{ details }}</pre>
      <pre v-if="rest" class="p-in">{{ rest }}</pre>

      <label v-if="!isPlan" class="p-rem">
        <input v-model="remember" type="checkbox" />
        не спрашивать про «{{ req.tool }}» до конца сессии
      </label>
    </div>
  </div>
</template>

<style scoped>
/* Плашка не должна расширять страницу: длинная команда переносится, а не тянет вёрстку */
.perm { padding: 8px 22px 9px; border-top: 1px solid color-mix(in srgb, var(--warn, #e0a33a) 45%, var(--line));
  background: color-mix(in srgb, var(--warn, #e0a33a) 7%, transparent); overflow: hidden;
  max-height: 38vh; overflow-y: auto; }
.col { width: 100%; min-width: 0; }
/* Ряд переносится: у варианта плана подпись бывает во всю фразу («Approve plan and
   continue…»), и в узкой плавающей панели кнопки уезжали за край — плашка режет их
   по `overflow: hidden`, страница при этом не скроллится (замер: клетка 360 px,
   scrollWidth 475 против clientWidth 345, правый край кнопки 475). */
.p-row { display: flex; align-items: center; justify-content: space-between; gap: 10px 10px;
  min-width: 0; flex-wrap: wrap; }
.p-t { font-size: 13px; min-width: 0; }
.p-tool { font-family: var(--mono, monospace); color: var(--warn, #e0a33a); }
.p-desc { margin-top: 5px; font-size: 12.5px; color: var(--ink); overflow-wrap: anywhere; }
.p-path { margin-top: 4px; font-family: var(--mono, monospace); font-size: 11.5px; color: var(--ink-mid);
  overflow-wrap: anywhere; }
/* Команда/детали целиком: переносы по словам, высокие блоки скроллятся внутри себя */
.p-in { margin: 6px 0 0; padding: 7px 10px; background: var(--ground); border: 1px solid var(--line); border-radius: 8px;
  font-size: 11.5px; line-height: 1.5; color: var(--ink-mid); white-space: pre-wrap; overflow-wrap: anywhere;
  max-height: 132px; overflow-y: auto; }
.p-in.cmd { font-family: var(--mono, monospace); color: var(--ink); }
/* План читают целиком — ему нужно больше места и обычные переносы слов */
.p-in.big { max-height: 320px; font-size: 12px; color: var(--ink); word-break: normal; overflow-wrap: anywhere; }
.perm.plan { border-top-color: color-mix(in srgb, var(--accent) 45%, var(--line));
  background: color-mix(in srgb, var(--accent) 7%, transparent); }
.p-rem { display: flex; align-items: center; gap: 6px; margin-top: 6px; font-size: 11.5px; color: var(--ink-mid); cursor: pointer; }
.p-rem input { accent-color: var(--accent); }
.p-act { display: flex; gap: 6px; flex: 0 1 auto; min-width: 0; flex-wrap: wrap; justify-content: flex-end;
  margin-left: auto; }
.p-ok, .p-no { border: none; border-radius: 8px; padding: 5px 12px; font-size: 12.5px; cursor: pointer;
  max-width: 100%; white-space: normal; overflow-wrap: anywhere; text-align: left; }
.p-ok { background: var(--good); color: #fff; }
.p-no { background: var(--surface-2); color: var(--ink); border: 1px solid var(--line); }

/* Дифф правки — те же две колонки, что в ленте хода: правку читают глазами, а не по JSON */
.p-diff { margin-top: 6px; border: 1px solid var(--line); border-radius: 8px; overflow: auto;
  max-height: 240px; background: var(--ground); }
.dhead, .drow { display: grid; grid-template-columns: 1fr 1fr; }
.dhead { position: sticky; top: 0; z-index: 1; background: var(--surface-2); font-size: 10.5px;
  text-transform: uppercase; letter-spacing: .04em; color: var(--ink-mid); }
.dhead span { padding: 3px 10px; }
.dhead span + span, .drow .dcell + .dcell { border-left: 1px solid var(--line); }
.dcell { font-family: var(--mono, monospace); font-size: 11.5px; line-height: 1.5; padding: 0 10px;
  white-space: pre-wrap; word-break: break-word; color: var(--ink-mid); min-width: 0; }
.dcell.del { background: color-mix(in srgb, var(--bad) 14%, transparent); color: color-mix(in srgb, var(--bad) 85%, var(--ink)); }
.dcell.add { background: color-mix(in srgb, var(--good) 14%, transparent); color: color-mix(in srgb, var(--good) 85%, var(--ink)); }
.dcell.nil { background: color-mix(in srgb, var(--surface-2) 60%, transparent); }
.dcell.del::before { content: '− '; opacity: .7; }
.dcell.add::before { content: '+ '; opacity: .7; }
</style>
