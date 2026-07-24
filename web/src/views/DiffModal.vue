<script setup>
import { onMounted, onBeforeUnmount } from 'vue';
import { useDiffStore } from '../stores/diff.js';
import DiffPanel from './diff/DiffPanel.vue';

// Большой модал дифа поверх текущего экрана. Ядро — тот же DiffPanel, что на роуте /diff.
const diff = useDiffStore();
function onKey(e) { if (e.key === 'Escape' && diff.open) diff.close(); }
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <Transition name="dm">
    <div v-if="diff.open" class="dm-overlay" @click.self="diff.close()">
      <div class="dm-modal">
        <header class="dm-head">
          <span class="dm-title mono">#{{ diff.taskId }} · диф</span>
          <button class="dm-x" title="Закрыть (Esc)" @click="diff.close()">✕</button>
        </header>
        <DiffPanel :task-id="diff.taskId" class="dm-panel" />
      </div>
    </div>
  </Transition>
</template>

<style scoped>
/* Без backdrop-filter: blur — он даёт мерцание при перерисовке тяжёлого Monaco и во время анимаций. */
.dm-overlay { position: fixed; inset: 0; z-index: 120; display: flex; align-items: center; justify-content: center;
  background: #000c; padding: 3vh 2vw; }
.dm-modal { width: min(1500px, 96vw); height: 94vh; display: flex; flex-direction: column; min-height: 0;
  background: var(--surface); border: 1px solid var(--line-2); border-radius: 14px; overflow: hidden; box-shadow: 0 24px 70px #000c; }
.dm-head { display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 11px 16px; border-bottom: 1px solid var(--line); background: var(--topbar); flex: none; }
.dm-title { font-size: 13px; color: var(--ink); font-weight: 600; }
.dm-x { background: var(--surface-2); border: 1px solid var(--line); color: var(--ink-mid); border-radius: 8px;
  width: 30px; height: 30px; cursor: pointer; font-size: 14px; }
.dm-x:hover { color: var(--ink); border-color: var(--line-2); }
.dm-panel { flex: 1; min-height: 0; }

/* Только плавность прозрачности overlay — без transform на модале (иначе Monaco релэйаутится в анимации → мерцание). */
.dm-enter-active, .dm-leave-active { transition: opacity .15s ease; }
.dm-enter-from, .dm-leave-to { opacity: 0; }
</style>
