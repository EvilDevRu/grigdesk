<script setup>
import { ref, computed, watch } from 'vue';

// Диалог агента: он спросил (AskUserQuestion) — показываем варианты и отправляем выбор.
// Не путать со всплывашкой разрешений: здесь не «разрешить/отклонить», а ответ по существу.
const props = defineProps({
  req: { type: Object, required: true }, // { pid, chatKey, questions: [{question, header, options[], multiSelect}] }
});
const emit = defineEmits(['answer', 'skip']);

// Выбор по каждому вопросу: индекс вопроса → { picked: [метки], text, own }
// own — раскрыто ли поле своего ответа (по умолчанию скрыто: в 9 случаях из 10 хватает вариантов).
const state = ref([]);
watch(() => props.req?.pid, () => {
  state.value = (props.req?.questions || []).map(() => ({ picked: [], text: '', own: false }));
}, { immediate: true });

const questions = computed(() => props.req?.questions || []);
// Отвечать можно, когда есть хоть один выбор или свой текст.
const ready = computed(() => state.value.some((s) => s.picked.length || s.text.trim()));

function pick(qi, label) {
  const s = state.value[qi];
  const multi = questions.value[qi]?.multiSelect;
  if (multi) {
    const i = s.picked.indexOf(label);
    if (i >= 0) s.picked.splice(i, 1); else s.picked.push(label);
  } else {
    s.picked = s.picked[0] === label ? [] : [label];
  }
}
function isPicked(qi, label) { return state.value[qi]?.picked.includes(label); }

function submit() {
  emit('answer', questions.value.map((q, i) => ({
    header: q.header || '', question: q.question || '',
    selected: state.value[i]?.picked || [], text: (state.value[i]?.text || '').trim(),
  })));
}
</script>

<template>
  <div class="q">
    <div class="col">
      <!-- Компактно: вопрос — строкой, варианты — чипами, пояснения вариантов в подсказке -->
      <div v-for="(q, qi) in questions" :key="qi" class="q-item">
        <div class="q-text">
          <span class="q-ico">?</span>{{ q.question }}
          <span v-if="q.multiSelect" class="q-multi">неск.</span>
        </div>
        <div class="q-opts">
          <button v-for="o in q.options || []" :key="o.label" class="q-opt" :class="{ on: isPicked(qi, o.label) }"
                  :title="o.description || o.label" @click="pick(qi, o.label)">{{ o.label }}</button>
          <button class="q-own-btn" :class="{ on: state[qi].own }" title="Ответить своими словами"
                  @click="state[qi].own = !state[qi].own">своё…</button>
        </div>
        <input v-if="state[qi].own" v-model="state[qi].text" class="q-own" placeholder="свой ответ"
               @keydown.enter.prevent="ready && submit()" />
      </div>
      <div class="q-act">
        <button class="q-ok" :disabled="!ready" @click="submit">Ответить</button>
        <button class="q-no" @click="emit('skip')">Пропустить</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Плашка живёт над композером — она не должна съедать пол-экрана:
   ограничиваем высоту и скроллим, если вопросов много. */
.q { padding: 9px 22px 10px; border-top: 1px solid color-mix(in srgb, var(--accent) 45%, var(--line));
  background: color-mix(in srgb, var(--accent) 7%, transparent); max-height: 38vh; overflow-y: auto; }
.col { width: 100%; min-width: 0; }
.q-item + .q-item { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--line); }
.q-text { font-size: 13px; margin-bottom: 6px; display: flex; align-items: baseline; gap: 6px; }
.q-ico { flex: none; color: var(--accent); font-weight: 700; }
.q-multi { font-size: 10.5px; color: var(--ink-mid); border: 1px solid var(--line); border-radius: 5px; padding: 0 4px; }
.q-opts { display: flex; flex-wrap: wrap; gap: 6px; }
/* Вариант — чип в одну строку; пояснение из ответа агента уходит в подсказку по наведению */
.q-opt, .q-own-btn { background: var(--ground); border: 1px solid var(--line); border-radius: 8px;
  padding: 4px 10px; font-size: 12.5px; cursor: pointer; color: var(--ink); }
.q-opt:hover, .q-own-btn:hover { border-color: var(--line-2); }
.q-opt.on { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 18%, transparent); }
.q-own-btn { color: var(--ink-mid); }
.q-own-btn.on { border-color: var(--accent); color: var(--ink); }
.q-own { width: 100%; margin-top: 6px; height: 30px; background: var(--ground); border: 1px solid var(--line);
  border-radius: 8px; color: var(--ink); padding: 0 10px; font-size: 12.5px; font-family: inherit; }
.q-own:focus { outline: none; border-color: var(--line-2); }
.q-act { display: flex; gap: 8px; margin-top: 9px; }
.q-ok, .q-no { border: none; border-radius: 8px; padding: 5px 13px; font-size: 12.5px; cursor: pointer; }
.q-ok { background: var(--accent); color: #fff; }
.q-ok:disabled { opacity: .5; cursor: default; }
.q-no { background: var(--surface-2); color: var(--ink); border: 1px solid var(--line); }
</style>
