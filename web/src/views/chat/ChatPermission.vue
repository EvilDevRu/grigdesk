<script setup>
// Всплывашка разрешения: агент просит выполнить действие (Bash, правка файла…) либо
// показывает готовый план на утверждение. Живёт над композером, поэтому компактная:
// суть и кнопки — одной строкой, детали — под ней.
import { ref, computed, watch } from 'vue';

const props = defineProps({
  // Запрос из стора чата: { pid, tool, input, chatKey }
  req: { type: Object, required: true },
});
const emit = defineEmits(['answer']); // (allow: boolean, remember: boolean)

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
</script>

<template>
  <div class="perm" :class="{ plan: isPlan }">
    <div class="col">
      <div class="p-row">
        <span class="p-t">
          <template v-if="isPlan">План готов — утвердить?</template>
          <template v-else>Разрешить <span class="p-tool">{{ req.tool }}</span>?</template>
        </span>
        <span v-if="preview && !isPlan" class="p-line" :title="preview">{{ preview }}</span>
        <span class="p-act">
          <button class="p-ok" @click="emit('answer', true, remember)">{{ isPlan ? 'Утвердить' : 'Разрешить' }}</button>
          <button class="p-no" @click="emit('answer', false, false)">{{ isPlan ? 'Доработать' : 'Отклонить' }}</button>
        </span>
      </div>
      <pre v-if="isPlan && preview" class="p-in big">{{ preview }}</pre>
      <label v-if="!isPlan" class="p-rem">
        <input v-model="remember" type="checkbox" />
        не спрашивать про «{{ req.tool }}» до конца сессии
      </label>
    </div>
  </div>
</template>

<style scoped>
.perm { padding: 8px 22px 9px; border-top: 1px solid color-mix(in srgb, var(--warn, #e0a33a) 45%, var(--line));
  background: color-mix(in srgb, var(--warn, #e0a33a) 7%, transparent); }
.col { width: 100%; min-width: 0; }
.p-row { display: flex; align-items: center; gap: 10px; min-width: 0; }
.p-t { font-size: 13px; flex: none; }
.p-tool { font-family: var(--mono, monospace); color: var(--warn, #e0a33a); }
/* Команда/файл — одной строкой с многоточием, целиком видна в подсказке */
.p-line { flex: 1; min-width: 0; font-family: var(--mono, monospace); font-size: 11.5px; color: var(--ink-mid);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.p-in { margin: 8px 0 0; padding: 7px 10px; background: var(--ground); border: 1px solid var(--line); border-radius: 8px;
  font-size: 11px; line-height: 1.45; color: var(--ink-mid); white-space: pre-wrap; word-break: break-all;
  max-height: 84px; overflow-y: auto; }
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
