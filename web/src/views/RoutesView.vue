<script setup>
import { ref } from 'vue';
import { api } from '../shared/api-client.js';
import FactoryGraph from './pipeline/FactoryGraph.vue';

const data = ref(null);
const error = ref(null);

const ROUTE_INFO = {
  feature: { icon: '✨', title: 'feature — новая функциональность',
    desc: 'Разведка → 2 конкурирующих плана → скептик → валидация → переводчик → ворота плана → тесты red-first → тест-критик → build → симплифаер → ревью → trace → PHP → линт → браузер → приёмка → ship → демо → ретро.' },
  debug: { icon: '🔍', title: 'debug — багфикс «сначала пойми, потом чини»',
    desc: 'Разведка → воспроизвести (замеры ДО) → логи/таймеры → диагноз → скептик гипотезы → доказательство → ворота причины → регресс-тест → build → ревью → замер ПОСЛЕ → приёмка → ship.' },
  trivial: { icon: '⚡', title: 'trivial — мелкая правка',
    desc: 'Без ворот плана: разведка → песочница → build → ревью → PHP → линт → приёмка → ship. Агент обязан эскалировать в feature/debug, если задача окажется сложнее.' },
};
const order = ['feature', 'debug', 'trivial'];

async function load() {
  try { data.value = await api.get('/api/factory/routes'); }
  catch (e) { error.value = e.message; }
}
load();
</script>

<template>
  <div class="routes">
    <h2 class="ttl">Маршруты конвейера<span v-if="data" class="muted"> · профиль {{ data.profile }}</span></h2>
    <p class="muted lead">Какие пути проходит задача на фабрике в зависимости от типа. Тип выбирает роутер по тикету (или задаётся вручную).</p>
    <p v-if="error" class="err">{{ error }}</p>
    <p v-else-if="data && !data.profile" class="muted">Профилей конвейера не найдено.</p>

    <template v-if="data && data.profile">
      <section v-for="name in order.filter(n => data.routes[n])" :key="name" class="rcard">
        <header class="rhead">
          <span class="ricon">{{ ROUTE_INFO[name]?.icon || '•' }}</span>
          <span class="rname">{{ ROUTE_INFO[name]?.title || name }}</span>
          <span v-if="name === data.default" class="rdefault">по умолчанию</span>
        </header>
        <p v-if="ROUTE_INFO[name]" class="rdesc muted">{{ ROUTE_INFO[name].desc }}</p>
        <div class="gwrap"><FactoryGraph :graph="data.routes[name]" reference /></div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.routes { display: flex; flex-direction: column; gap: 16px; }
.ttl { font-size: 20px; margin: 0; }
.lead { max-width: 80ch; margin: 0; font-size: 13px; }
.err { color: var(--bad); }
.rcard { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius);
  padding: 16px; box-shadow: var(--shadow); }
.rhead { display: flex; align-items: center; gap: 10px; }
.ricon { font-size: 18px; }
.rname { font-weight: 640; font-size: 15px; }
.rdefault { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--good);
  background: color-mix(in srgb, var(--good) 14%, transparent); padding: 2px 8px; border-radius: 999px; }
.rdesc { font-size: 13px; margin: 8px 0 0; max-width: 90ch; }
.gwrap { overflow-x: auto; margin-top: 12px; }
.gwrap :deep(svg.graph) { min-width: 1160px; }
</style>
