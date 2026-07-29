// Мутации состояния фабрики через её же инструменты (единый источник истины).
// Записи в реестр — pipeline-set.sh (upsert одной строки). Указания агенту — side-файл.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseStagesLog } from './stages-parse.js';

/**
 * Пишет пары KEY VALUE в реестр задачи через pipeline-set.sh.
 * @param {{ factoryHome: string, stateDir: string, task: string, pairs: string[] }} o
 */
export function setPipeline({ factoryHome, stateDir, task, pairs }) {
  return new Promise((resolve, reject) => {
    execFile(
      'bash',
      [path.join(factoryHome, 'lib', 'pipeline-set.sh'), task, ...pairs],
      { env: { ...process.env, STATE_DIR: stateDir }, timeout: 15000 },
      (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).slice(-400)) ) : resolve(stdout)),
    );
  });
}

/** Указание агенту — side-файл tNNNN.instruction.md (реестр многострочное не держит). */
export function writeInstruction({ stateDir, task, text }) {
  const file = path.join(stateDir, `t${task}.instruction.md`);
  if (!text || !text.trim()) { try { fs.unlinkSync(file); } catch { /* нет файла */ } return; }
  fs.writeFileSync(file, text, 'utf8');
}

export function readInstruction({ stateDir, task }) {
  try { return fs.readFileSync(path.join(stateDir, `t${task}.instruction.md`), 'utf8'); }
  catch { return ''; }
}

const SAFE_TASK = /^[0-9]+$/;
const SAFE_STAGE = /^[A-Z][A-Z0-9_]*$/;
const SAFE_RUN = /^[A-Za-z0-9._-]+$/;

/**
 * Возвращает артефакты именно активного запуска по каноническим ACTIVE_RUN_<STAGE>.
 * Это общий путь и для Claude, и для Codex; orch.log оставлен только для старых прогонов.
 */
function activeRunArtifacts({ stateDir, task, registry = {} }) {
  if (!SAFE_TASK.test(String(task))) return null;
  const candidates = [];
  for (const [key, runId] of Object.entries(registry)) {
    if (!key.startsWith('ACTIVE_RUN_') || !runId) continue;
    const stage = key.slice('ACTIVE_RUN_'.length);
    if (!SAFE_STAGE.test(stage) || !SAFE_RUN.test(String(runId))) continue;
    const runDir = path.join(stateDir, 'logs', 'runs', `t${task}`, stage, String(runId));
    const eventsFile = path.join(runDir, 'events.jsonl');
    try {
      const stat = fs.statSync(eventsFile);
      candidates.push({
        runDir,
        eventsFile,
        mtimeMs: stat.mtimeMs,
        running: registry[stage] === 'running',
      });
    } catch { /* run успел зарегистрироваться, но launcher ещё не создал журнал */ }
  }
  return candidates.sort((a, b) => Number(b.running) - Number(a.running) || b.mtimeMs - a.mtimeMs)[0] || null;
}

/**
 * Живая активность прогона: хвост stages.log (человекочитаемый) + свежесть журнала агента.
 * @returns {{ tail: Array<{ts,event}>, journalFresh: boolean, journalAgeSec: number|null, wfStatus: string }}
 */
export function readActivity({ stateDir, task, registry }) {
  let tail = [];
  try {
    const log = fs.readFileSync(path.join(stateDir, 'logs', `t${task}.stages.log`), 'utf8');
    tail = parseStagesLog(log).slice(-12).map((e) => ({ ts: e.ts, event: e.event }));
  } catch { /* журнала нет */ }

  // «Агент пишет» = свежая запись в events.jsonl канонического активного run.
  // Старые ACTIVE_DIR/JOURNAL и orch.log нужны для уже созданных legacy-прогонов.
  let journalFresh = false;
  let journalMtimeMs = null;
  const active = activeRunArtifacts({ stateDir, task, registry });
  if (active) journalMtimeMs = active.mtimeMs;

  const adir = registry.ACTIVE_DIR || (registry.JOURNAL ? path.dirname(registry.JOURNAL) : '');
  if (journalMtimeMs == null && adir) {
    try {
      for (const f of fs.readdirSync(adir)) {
        if (!f.endsWith('.jsonl')) continue;
        const mtimeMs = fs.statSync(path.join(adir, f)).mtimeMs;
        if (journalMtimeMs == null || mtimeMs > journalMtimeMs) journalMtimeMs = mtimeMs;
      }
    } catch { /* нет каталога */ }
  }
  if (journalMtimeMs == null) {
    try {
      journalMtimeMs = fs.statSync(path.join(stateDir, 'logs', `t${task}.orch.log`)).mtimeMs;
    } catch { /* лога агента нет */ }
  }
  const journalAgeSec = journalMtimeMs == null
    ? null
    : Math.max(0, Math.floor((Date.now() - journalMtimeMs) / 1000));
  journalFresh = journalAgeSec != null && journalAgeSec < 60;
  return { tail, journalFresh, journalAgeSec, wfStatus: registry.WF_STATUS || null };
}

function readTail(logFile, maxBytes) {
  try {
    const stat = fs.statSync(logFile);
    if (stat.size === 0) return null;
    const fd = fs.openSync(logFile, 'r');
    try {
      const start = Math.max(0, stat.size - maxBytes);
      const buf = Buffer.alloc(Math.min(stat.size, maxBytes));
      fs.readSync(fd, buf, 0, buf.length, start);
      return { raw: buf.toString('utf8'), truncated: start > 0 };
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}

function readRunModel(runDir) {
  if (!runDir) return null;
  try {
    const match = fs.readFileSync(path.join(runDir, 'meta.env'), 'utf8').match(/^MODEL=(.*)$/m);
    return match?.[1]?.trim() || null;
  } catch { return null; }
}

function shortText(value, limit = 120) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function codexAction(item, status) {
  const mappedStatus = status === 'failed' || status === 'error'
    ? 'error'
    : status === 'in_progress' || status === 'running' ? 'run' : 'done';
  switch (item.type) {
    case 'command_execution':
      return { type: 'tool', name: 'Команда', desc: shortText(item.command, 160), status: mappedStatus };
    case 'collab_tool_call': {
      const subagent = item.tool === 'spawn_agent';
      const names = {
        wait: 'Ожидание субагентов',
        spawn_agent: 'Запуск субагента',
        send_message: 'Сообщение субагенту',
        followup_task: 'Задание субагенту',
      };
      return {
        type: subagent ? 'subagent' : 'tool',
        name: names[item.tool] || item.tool || 'Субагенты',
        desc: shortText(item.prompt || ''),
        status: mappedStatus,
      };
    }
    case 'mcp_tool_call':
      return {
        type: 'tool',
        name: item.tool || item.name || 'Инструмент',
        desc: shortText(item.server || item.arguments || ''),
        status: mappedStatus,
      };
    case 'web_search':
      return { type: 'tool', name: 'Поиск в интернете', desc: shortText(item.query), status: mappedStatus };
    case 'file_change':
      return { type: 'tool', name: 'Изменение файлов', desc: shortText(item.path || item.changes), status: mappedStatus };
    default:
      return null;
  }
}

/**
 * Живая лента действий агента: парсит events.jsonl активного run (Claude или Codex)
 * и выдаёт последние N событий. Для legacy-прогонов читает общий orch.log.
 * Читает только последние TAIL_BYTES байт — файл может быть десятки МБ.
 * @returns {{ actions: Array<{type,ts?,name?,desc?,text?,status?,tokens?,tools?}>, model: string|null }}
 */
export function readAgentLive({ stateDir, task, registry = {} }) {
  const TAIL_BYTES = 192 * 1024;
  const MAX_ACTIONS = 25;
  const active = activeRunArtifacts({ stateDir, task, registry });
  const logFile = active?.eventsFile || path.join(stateDir, 'logs', `t${task}.orch.log`);
  const tail = readTail(logFile, TAIL_BYTES);
  if (!tail) return { actions: [], model: readRunModel(active?.runDir) };
  const { raw, truncated } = tail;

  // Первая строка может быть обрезана — отбрасываем её, если начали не с начала.
  const lines = raw.split('\n');
  if (truncated) lines.shift();

  const actions = [];
  const pendingTools = new Map(); // tool_use_id → index in actions
  const subagents = new Map();   // tool_use_id → index in actions
  const pendingCodex = new Map(); // item id → index in actions
  let model = readRunModel(active?.runDir);

  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let ev;
    try { ev = JSON.parse(t); } catch { continue; }

    if (ev.type === 'assistant' && ev.message?.content) {
      if (!model && ev.message.model) model = ev.message.model;
      const ts = ev.timestamp || null;
      for (const block of ev.message.content) {
        if (block.type === 'tool_use') {
          const desc = block.input?.description || block.input?.file_path || block.input?.command?.slice(0, 80) || '';
          const isAgent = block.name === 'Agent';
          const a = { type: isAgent ? 'subagent' : 'tool', ts, name: block.name, desc, status: 'run' };
          if (isAgent && block.input?.description) a.desc = block.input.description;
          actions.push(a);
          pendingTools.set(block.id, actions.length - 1);
          if (isAgent) subagents.set(block.id, actions.length - 1);
        } else if (block.type === 'text' && block.text) {
          const txt = block.text.length > 120 ? block.text.slice(0, 120) + '…' : block.text;
          actions.push({ type: 'text', ts, text: txt });
        } else if (block.type === 'thinking' && block.thinking) {
          const dot = block.thinking.indexOf('.');
          const nl = block.thinking.indexOf('\n');
          let end = Math.min(dot > 0 ? dot + 1 : 999, nl > 0 ? nl : 999, 100);
          if (end >= 999) end = Math.min(block.thinking.length, 100);
          actions.push({ type: 'think', ts, text: block.thinking.slice(0, end).trim() });
        }
      }
    } else if (ev.type === 'user' && ev.message?.content) {
      const ts = ev.timestamp || null;
      for (const block of ev.message.content) {
        if (block.type === 'tool_result' && block.tool_use_id && pendingTools.has(block.tool_use_id)) {
          const idx = pendingTools.get(block.tool_use_id);
          actions[idx].status = block.is_error ? 'error' : 'done';
          if (ts) actions[idx].doneAt = ts;
          pendingTools.delete(block.tool_use_id);
        }
      }
    } else if (ev.type === 'system' && ev.subtype === 'task_progress') {
      const tid = ev.tool_use_id;
      if (tid && subagents.has(tid)) {
        const idx = subagents.get(tid);
        actions[idx].tokens = ev.usage?.total_tokens || 0;
        actions[idx].tools = ev.usage?.tool_uses || 0;
        if (ev.last_tool_name) actions[idx].lastTool = ev.last_tool_name;
      }
    } else if (ev.type === 'system' && ev.subtype === 'task_started') {
      const tid = ev.tool_use_id;
      if (tid && subagents.has(tid)) {
        const idx = subagents.get(tid);
        if (ev.description) actions[idx].desc = ev.description;
      }
    } else if (ev.type === 'result') {
      // Финальный результат текущего этапа — всё «done», лента сбрасывается.
      actions.length = 0;
      pendingTools.clear();
      subagents.clear();
      pendingCodex.clear();
      model = null;
    } else if ((ev.type === 'item.started' || ev.type === 'item.completed') && ev.item) {
      const item = ev.item;
      if (item.type === 'agent_message' && ev.type === 'item.completed' && item.text) {
        actions.push({ type: 'text', text: shortText(item.text) });
      } else if (item.type === 'reasoning' && ev.type === 'item.completed' && item.text) {
        actions.push({ type: 'think', text: shortText(item.text, 100) });
      } else {
        const existing = item.id ? pendingCodex.get(item.id) : undefined;
        if (existing !== undefined && ev.type === 'item.completed') {
          actions[existing].status = item.status === 'failed' ? 'error' : 'done';
          pendingCodex.delete(item.id);
        } else {
          const action = codexAction(item, item.status || (ev.type === 'item.started' ? 'in_progress' : 'completed'));
          if (action) {
            actions.push(action);
            if (ev.type === 'item.started' && item.id) pendingCodex.set(item.id, actions.length - 1);
          }
        }
      }
    }
  }

  return { actions: actions.slice(-MAX_ACTIONS), model };
}
