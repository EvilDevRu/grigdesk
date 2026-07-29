// Посев библиотеки ШАБЛОНОВ агентов из всех профилей фабрики.
// Модель данных: агент — переиспользуемый шаблон роли (метаданные + заготовка
// промпта); боевой промпт каждого этапа принадлежит СХЕМЕ и лежит сайдкаром
// routes/<профиль>/<маршрут>/<этап>.md (см. модуль routes).
//
// Метаданные — из profiles/<профиль>/graph.json; настройки и промпты — из bash-функций
// профиля (profile_stage_*): профиль сорсится с заглушками движка, переменные окружения
// подставляются плейсхолдерами {{TASK}}, {{STATE_DIR}} — на выходе готовые шаблоны.
//
// Коллизии id между профилями суффиксами НЕ разводятся: один id = один шаблон,
// первый профиль (по алфавиту) даёт заготовку промпта, остальные — только свои
// сайдкары в маршрутах. Никакой карты переименований больше нет.
//
// Тонкость с ключами: функции профиля матчат ИМЕНА ЭТАПОВ ДВИЖКА (PLAN, PHPCHECK),
// а graph.json хранит КЛЮЧИ РЕЕСТРА (PLANS, PHPCHECK) — почти всегда совпадают, но не
// везде (plan↔PLANS). Поэтому пробуем оба кандидата: ключ реестра и UPPER(id) —
// берём первый непустой ответ.
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { listFactoryProfiles } from '../../lib/profiles.js';

function runBash(script) {
  return new Promise((resolve, reject) => {
    execFile('bash', ['-c', script], { timeout: 20000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => (err && !stdout ? reject(err) : resolve(stdout || '')));
  });
}

/** Читает graph.json профиля: sub-сноски, ключи реестра, optional-этапы. */
async function readGraph(profilesDir, profile) {
  try {
    const p = path.join(profilesDir, profile, 'graph.json');
    return JSON.parse(await fs.readFile(p, 'utf8'));
  } catch { return {}; }
}

/**
 * Извлечение настроек и промптов всех стадий одним вызовом bash.
 * @param {Array<{id: string, k1: string, k2: string}>} stages — id + два кандидата ключа
 */
async function extractFromProfile({ factoryHome, profilesDir }, profile, stages) {
  const entries = stages.map((s) => `'${s.id}|${s.k1}|${s.k2}'`).join(' ');
  const script = `
set +e
export FACTORY_HOME='${factoryHome}'
export FACTORY_PROFILES_DIR='${profilesDir}'
export STATE_DIR='{{STATE_DIR}}'
get() { echo ""; }
flog() { :; }
source "$FACTORY_PROFILES_DIR/${profile}/profile.sh" 2>/dev/null
first() { local f=$1 k1=$2 k2=$3 v; v=$("$f" "$k1" 2>/dev/null); [ -n "$v" ] || v=$("$f" "$k2" 2>/dev/null); echo "$v"; }
for E in ${entries}; do
  IFS='|' read -r ID K1 K2 <<< "$E"
  echo "@@STAGE $ID"
  echo "@@MODEL $(first profile_stage_model "$K1" "$K2")"
  echo "@@TIMEOUT $(first profile_stage_timeout "$K1" "$K2")"
  echo "@@BUDGET $(first profile_stage_budget "$K1" "$K2")"
  echo "@@READONLY $(first profile_stage_readonly "$K1" "$K2")"
  echo "@@PROMPT"
  P=$(profile_stage_prompt '{{TASK}}' "$K1" 2>/dev/null)
  [ -n "$P" ] || P=$(profile_stage_prompt '{{TASK}}' "$K2" 2>/dev/null)
  printf '%s\\n' "$P"
  echo "@@ENDSTAGE"
done
`;
  const out = await runBash(script);
  const byId = {}; // id → {model,…,prompt}
  let cur = null; let inPrompt = false; let buf = [];
  for (const line of out.split('\n')) {
    if (line.startsWith('@@STAGE ')) {
      cur = byId[line.slice(8).trim()] = { model: '', timeout: 0, budget: 0, readonly: false, prompt: '' };
      inPrompt = false; buf = [];
    } else if (line.startsWith('@@MODEL ') && cur) cur.model = line.slice(8).trim();
    else if (line.startsWith('@@TIMEOUT ') && cur) cur.timeout = Number(line.slice(10).trim()) || 0;
    else if (line.startsWith('@@BUDGET ') && cur) cur.budget = Number(line.slice(9).trim()) || 0;
    else if (line.startsWith('@@READONLY ') && cur) cur.readonly = line.slice(11).trim() !== '';
    else if (line === '@@PROMPT') inPrompt = true;
    else if (line === '@@ENDSTAGE') { if (cur) cur.prompt = buf.join('\n').trim(); inPrompt = false; buf = []; }
    else if (inPrompt) buf.push(line);
  }
  return { byId };
}

/** Кандидаты ключей стадий профиля из graph.json (для extract). */
function stagesOf(g) {
  return Object.keys(g.nodes || {}).map((id) => ({ id, k1: g.keys?.[id] || id.toUpperCase(), k2: id.toUpperCase() }));
}

/**
 * Промпты всех стадий профиля: { <id этапа>: текст }. Используется посевом
 * маршрутов — тексты уезжают сайдкарами в папки схем.
 */
export async function extractProfilePrompts(config, profile) {
  const g = await readGraph(config.profilesDir, profile);
  const stages = stagesOf(g);
  if (!stages.length) return {};
  const { byId } = await extractFromProfile(config, profile, stages);
  return Object.fromEntries(stages.map(({ id }) => [id, byId[id]?.prompt || '']));
}

/**
 * Посев библиотеки шаблонов из всех профилей фабрики. Один id — один шаблон:
 * повторное появление id в другом профиле шаблон не перетирает.
 * @returns {{n: number}}
 */
export async function seedAgents(store, config, log) {
  const claimed = new Set();
  let n = 0;
  for (const profile of (await listFactoryProfiles(config.profilesDir)).sort()) {
    const g = await readGraph(config.profilesDir, profile);
    const stages = stagesOf(g);
    if (!stages.length) continue;
    const optional = new Set(Object.values(g.optional || {}).flat());

    let extracted = { byId: {} };
    try {
      extracted = await extractFromProfile(config, profile, stages);
    } catch (e) {
      log?.warn({ err: e.message, profile }, 'посев агентов: профиль не прочитался, сею только метаданные');
    }

    for (const { id, k1 } of stages) {
      if (claimed.has(id)) continue; // шаблон уже есть — специфика профиля живёт в его схемах
      claimed.add(id);
      const node = g.nodes?.[id] || [];
      const ext = extracted.byId[id] || {};
      // Заготовка промпта и эффорт — курируются руками: посев их НЕ трогает
      // (в bash-профилях эффорта нет, а проектные тексты уезжают в схемы, не в шаблон).
      let prev = null;
      try { prev = await store.get(id); } catch { /* шаблона ещё нет */ }
      await store.save(id, {
        kind: node[0] || 'agent',
        label: (node[1] || id).replace(/^(🤖|👤|<\/>)\s*/, ''),
        sub: node[2] || '',
        key: k1,
        model: ext.model || '',
        effort: prev?.effort || '',
        timeout: ext.timeout || 0,
        budget: ext.budget || 0,
        readonly: !!ext.readonly,
        optional: optional.has(id),
        prompt: prev?.prompt || '',
      });
      n++;
    }
  }
  await store.ensureDir();
  return { n };
}
