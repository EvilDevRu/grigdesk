<script setup>
// Всплывашка разрешения: агент просит выполнить действие (Bash, правка файла…) либо
// показывает готовый план на утверждение. Живёт над композером, поэтому компактная:
// суть и кнопки — одной строкой, детали — под ней.
import { ref, computed, watch } from 'vue';
import { promptDialog } from '../../shared/ui/confirm.js';

const props = defineProps({
  // Запрос из стора чата: { pid, tool, input, chatKey }
  req: { type: Object, required: true },
});
const emit = defineEmits(['answer']); // (allow: boolean, remember: boolean, comment: string)

// «Не спрашивать до конца сессии» — сбрасывается на каждый новый запрос.
const remember = ref(false);
watch(() => props.req?.pid, () => { remember.value = false; });

// Что показать рядом с названием инструмента: команду, файл или сам план.
const preview = computed(() => {
  const i = props.req?.input || {};
  if (i.command) return i.command;              // Bash — показываем команду
  if (i.plan) return i.plan;                    // ExitPlanMode — сам план, а не JSON
  if (i.file_path) return i.file_path;          // правки — показываем файл
  const s = JSON.stringify(i);
  return s === '{}' ? '' : s.length > 400 ? s.slice(0, 400) + '…' : s;
});

// План на утверждение — отдельный разговор: и подписи кнопок про план, и сам он
// показывается целиком, а не строкой с многоточием.
const isPlan = computed(() => props.req?.tool === 'ExitPlanMode');

// Отказ — с пояснением: голый deny не говорит агенту, что поменять, а человеку
// непонятно, куда писать замечания. Пустое пояснение разрешено — тогда как раньше.
// Отмена модалки (Esc/фон) возвращает в карточку, не отклоняя.
async function reject() {
  const text = await promptDialog({
    title: isPlan.value ? 'Что доработать в плане?' : 'Почему отклоняете?',
    placeholder: 'можно оставить пустым',
  });
  if (text === null) return;
  emit('answer', false, false, text.trim());
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
          <button class="p-ok" @click="emit('answer', true, remember)">{{ isPlan ? 'Утвердить' : 'Разрешить' }}</button>
          <button class="p-no" @click="reject">{{ isPlan ? 'Доработать' : 'Отклонить' }}</button>
        </span>
      </div>
      <!-- Команда/файл/план — целиком, с переносами: решение принимают по тому, что видно -->
      <pre v-if="preview" class="p-in" :class="{ big: isPlan }">{{ preview }}</pre>
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
  background: color-mix(in srgb, var(--warn, #e0a33a) 7%, transparent); overflow: hidden; }
.col { width: 100%; min-width: 0; }
.p-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-width: 0; }
.p-t { font-size: 13px; min-width: 0; }
.p-tool { font-family: var(--mono, monospace); color: var(--warn, #e0a33a); }
/* Команда/файл целиком: переносы по словам, высокие блоки скроллятся внутри себя */
.p-in { margin: 6px 0 0; padding: 7px 10px; background: var(--ground); border: 1px solid var(--line); border-radius: 8px;
  font-size: 11.5px; line-height: 1.5; color: var(--ink-mid); white-space: pre-wrap; overflow-wrap: anywhere;
  max-height: 132px; overflow-y: auto; }
/* План читают целиком — ему нужно больше места и обычные переносы слов */
.p-in.big { max-height: 320px; font-size: 12px; color: var(--ink); word-break: normal; overflow-wrap: anywhere; }
.perm.plan { border-top-color: color-mix(in srgb, var(--accent) 45%, var(--line));
  background: color-mix(in srgb, var(--accent) 7%, transparent); }
.p-rem { display: flex; align-items: center; gap: 6px; margin-top: 6px; font-size: 11.5px; color: var(--ink-mid); cursor: pointer; }
.p-rem input { accent-color: var(--accent); }
.p-act { display: flex; gap: 6px; flex: none; }
.p-ok, .p-no { border: none; border-radius: 8px; padding: 5px 12px; font-size: 12.5px; cursor: pointer; }
.p-ok { background: var(--good); color: #fff; }
.p-no { background: var(--surface-2); color: var(--ink); border: 1px solid var(--line); }
</style>
