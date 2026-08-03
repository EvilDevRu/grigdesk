// Порт логики графа конвейера из factory/lib/dashboard.py:
//  - загрузка схемы профиля (profiles/<profile>/graph.json),
//  - расчёт статуса каждого узла (pipeline_statuses),
//  - разбор возвратов/остановок из журнала (loop_facts).
// Геометрия узлов и кривые рёбер считаются на клиенте (graph-geom.js) — здесь только данные.
import fs from 'node:fs';
import path from 'node:path';
import { resolveNode } from './stages.js';

// Значение реестра → статус узла (_ST_MAP, dashboard.py:281). Остальное → pending.
const ST_MAP = {
  done: 'done', approved: 'done', running: 'run', waiting: 'wait',
  failed: 'stall', rejected: 'stall', blocked: 'skipbad',
};

const _cache = new Map(); // profilesDir + profile → parsed graph.json

/** Загружает и кеширует схему профиля. */
export function loadGraph(profilesDir, profile) {
  const key = `${profilesDir}\0${profile}`;
  if (_cache.has(key)) return _cache.get(key);
  const file = path.join(profilesDir, profile, 'graph.json');
  const g = JSON.parse(fs.readFileSync(file, 'utf8'));
  _cache.set(key, g);
  return g;
}

/** Определение графа для маршрута: узлы, ключи, optional, vb, pos, edges. */
export function graphForRoute(g, route) {
  // Разметки может не быть вовсе. Профиль, перешедший на route-v2, держит nodes/routes/pos
  // только ради read-only показа старых реестров, а после чистки graph.json их не остаётся:
  // картинку рисует закреплённый бандл (route-graph.js). Сюда такой профиль попадает лишь
  // историческим реестром без CATALOG_PROTOCOL=route-v2 — и падал на `r.pos`, отдавая
  // человеку «Cannot read properties of undefined» вместо ответа, чего именно смотреть нечем.
  const r = g.routes?.[route] || g.routes?.[g.default_route];
  if (!r?.pos) {
    const known = Object.keys(g.routes || {});
    throw new Error(
      `в graph.json профиля нет разметки маршрута «${route || g.default_route || '—'}»`
      + (known.length
        ? `; в файле есть только ${known.join(', ')}`
        : ': профиль перешёл на route-v2, у исторического реестра схемы больше нет'),
    );
  }
  const optional = new Set([...(g.optional?.['*'] || []), ...(g.optional?.[route] || [])]);
  // Узлы: оверрайд профиля поверх глобального каталога стадий (stages.js).
  const nodes = {};
  for (const id of Object.keys(r.pos)) nodes[id] = resolveNode(id, g.nodes?.[id]);
  const runnerKeys = Object.fromEntries(Object.entries({
    ...(g.runner_keys?.['*'] || {}),
    ...(g.runner_keys?.[route] || {}),
  }).filter(([id]) => id in r.pos));
  return {
    nodes,                     // id → [kind, label, sub] (профиль + каталог)
    keys: g.keys || {},        // id → registry key
    // Визуальный узел может быть внутренней фазой одного runner-stage:
    // например plan/skeptic/translator на feature-маршруте выполняет единый PLAN.
    // Маппинг route-specific и не смешивается со status keys.
    runnerKeys,
    optional: [...optional],
    vb: r.vb,
    pos: r.pos,                // id → [x, y]
    edges: r.edges,            // [src, dst, label, class, routing]
    route,
  };
}

/**
 * Статус каждого узла схемы (порт pipeline_statuses, dashboard.py:305).
 * Упрощения относительно оригинала: sandbox-статус выводим из прогресса цепочки
 * (без docker), browser-fe_dirty спецкейс и pipeline_stall опущены.
 */
export function computeNodeStatuses({ pf, pos, keys, optional, mtimeMs }) {
  const opt = new Set(optional);
  const chain = Object.keys(pos).filter((n) => n !== 'sandbox');
  const st = {};
  const unknown = new Set();

  for (const nid of chain) {
    // Два кандидата ключа (как в посеве агентов): ключ реестра из graph.json и UPPER(id).
    // Они расходятся у плана: движок ведёт этап под PLAN, а агент плана по ходу выставляет
    // PLANS/SKEPTIC/VALIDATE/TRANSLATOR. Пока агент не записал свой ключ, узел горит от
    // движкового — иначе первые минуты этапа схема выглядит мёртвой («не вижу работу»).
    const key = keys[nid] || nid.toUpperCase();
    const alt = nid.toUpperCase();
    let raw = pf[key];
    if ((raw === undefined || raw === 'pending') && alt !== key && pf[alt] !== undefined) raw = pf[alt];
    if (raw === undefined) { unknown.add(nid); st[nid] = 'pending'; continue; }
    if (raw === 'skipped') st[nid] = opt.has(nid) ? 'skip' : 'skipbad';
    else st[nid] = ST_MAP[raw] || 'pending';
  }

  // idle-заполнение: незаписанные этапы ДО последнего тронутого = «нет данных».
  const touched = chain.map((n, i) => (st[n] !== 'pending' ? i : -1)).filter((i) => i >= 0);
  if (touched.length) {
    const last = touched[touched.length - 1];
    for (const n of chain.slice(0, last)) if (unknown.has(n)) st[n] = 'idle';
  }

  const doneLike = new Set(['done', 'skip']);

  // Ворота ждут, если всё до них пройдено (не дожидаясь записи waiting).
  chain.forEach((nid, i) => {
    if (!nid.startsWith('gate_') || st[nid] !== 'pending') return;
    if (chain.slice(0, i).every((p) => doneLike.has(st[p]))) st[nid] = 'wait';
  });

  // Гард ворот: недоделанный хвост маршрута → «преждевременно».
  chain.forEach((nid, i) => {
    if (st[nid] === 'wait' && nid.startsWith('gate_')) {
      const unfinished = chain.slice(0, i).filter(
        (p) => !doneLike.has(st[p]) && st[p] !== 'idle' && !opt.has(p),
      );
      if (unfinished.length) st[nid] = 'premature';
    }
  });

  // Линейность: активен ровно один узел (более поздний = реальный фронт).
  const active = chain.map((n, i) => (['run', 'wait'].includes(st[n]) ? i : -1)).filter((i) => i >= 0);
  if (active.length > 1) {
    const keep = active[active.length - 1];
    chain.forEach((n, i) => { if (['run', 'wait'].includes(st[n])) st[n] = i < keep ? 'done' : 'pending'; });
  }

  // Возврат после отклонённой приёмки: хвост снова pending, точка возврата активна.
  if (pf.GATE_ACCEPT === 'rejected' && !['done', 'running'].includes(pf.SHIP)) {
    const back = chain.includes('build') ? 'build' : chain.find((n) => !n.startsWith('gate_'));
    if (back) {
      const bi = chain.indexOf(back);
      for (const n of chain.slice(bi)) st[n] = 'pending';
      const recent = mtimeMs && Date.now() - mtimeMs < 300000;
      st[back] = recent ? 'run' : 'wait';
    }
  }

  // Песочница: done, если цепочка тронута.
  st.sandbox = touched.length ? 'done' : 'pending';
  return st;
}

/**
 * Возвраты и остановки из журнала этапов (порт loop_facts, dashboard.py:663).
 * @returns {{ loops: Record<string, number>, halted: string|null, haltMsg: string }}
 */
export function parseLoops(stagesLogText) {
  const f = { loops: {}, halted: null, haltMsg: '' };
  if (!stagesLogText) return f;
  for (const line of stagesLogText.split('\n')) {
    let m = /возврат в (\S+) из-за (\w+)/.exec(line);
    if (m) {
      const key = m[2].toLowerCase();
      f.loops[key] = (f.loops[key] || 0) + 1;
    }
    m = /(\w+): (\d+) возврата не помогли/.exec(line);
    if (m) { f.halted = m[1].toLowerCase(); f.haltMsg = `${m[2]} возврата не помогли`; }
    if (/этап \w+ \(попытка/.test(line) || line.includes('маршрут:')) f.halted = null;
  }
  return f;
}
