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

/**
 * Живая активность прогона: хвост stages.log (человекочитаемый) + свежесть журнала агента.
 * @returns {{ tail: Array<{ts,event}>, journalFresh: boolean, wfStatus: string }}
 */
export function readActivity({ stateDir, task, registry }) {
  let tail = [];
  try {
    const log = fs.readFileSync(path.join(stateDir, 'logs', `t${task}.stages.log`), 'utf8');
    tail = parseStagesLog(log).slice(-12).map((e) => ({ ts: e.ts, event: e.event }));
  } catch { /* журнала нет */ }

  // «Агент пишет» = свежая запись в его выводе. Кандидаты по убыванию точности:
  // journal.jsonl workflow-движка (ACTIVE_DIR/JOURNAL в реестре — старая схема),
  // затем logs/tNNNN.orch.log — туда стримится stream-json текущего claude-агента.
  // Без второго кандидата индикатор всегда показывал «тихо» на живом агенте:
  // у нынешней фабрики ключей ACTIVE_DIR/JOURNAL в реестре нет.
  let journalFresh = false;
  const adir = registry.ACTIVE_DIR || (registry.JOURNAL ? path.dirname(registry.JOURNAL) : '');
  if (adir) {
    try {
      for (const f of fs.readdirSync(adir)) {
        if (f.endsWith('.jsonl') && Date.now() - fs.statSync(path.join(adir, f)).mtimeMs < 60000) { journalFresh = true; break; }
      }
    } catch { /* нет каталога */ }
  }
  if (!journalFresh) {
    try {
      journalFresh = Date.now() - fs.statSync(path.join(stateDir, 'logs', `t${task}.orch.log`)).mtimeMs < 60000;
    } catch { /* лога агента нет */ }
  }
  return { tail, journalFresh, wfStatus: registry.WF_STATUS || null };
}

/**
 * Живая лента действий агента: парсит хвост orch.log (stream-json от Claude CLI)
 * и выдаёт последние N событий (tool_use, text, thinking, subagent progress).
 * Читает только последние TAIL_BYTES байт — файл может быть десятки МБ.
 * @returns {{ actions: Array<{type,ts?,name?,desc?,text?,status?,tokens?,tools?}>, model: string|null }}
 */
export function readAgentLive({ stateDir, task }) {
  const TAIL_BYTES = 192 * 1024;
  const MAX_ACTIONS = 25;
  const logFile = path.join(stateDir, 'logs', `t${task}.orch.log`);

  let raw;
  try {
    const stat = fs.statSync(logFile);
    if (stat.size === 0) return { actions: [], model: null };
    const fd = fs.openSync(logFile, 'r');
    try {
      const start = Math.max(0, stat.size - TAIL_BYTES);
      const buf = Buffer.alloc(Math.min(stat.size, TAIL_BYTES));
      fs.readSync(fd, buf, 0, buf.length, start);
      raw = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return { actions: [], model: null }; }

  // Первая строка может быть обрезана — отбрасываем её, если начали не с начала.
  const lines = raw.split('\n');
  if (raw.length >= TAIL_BYTES) lines.shift();

  const actions = [];
  const pendingTools = new Map(); // tool_use_id → index in actions
  const subagents = new Map();   // tool_use_id → index in actions
  let model = null;

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
      model = null;
    }
  }

  return { actions: actions.slice(-MAX_ACTIONS), model };
}
