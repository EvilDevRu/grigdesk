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

  // Свежая запись в journal.jsonl активного workflow = агент реально пишет прямо сейчас.
  let journalFresh = false;
  const adir = registry.ACTIVE_DIR || (registry.JOURNAL ? path.dirname(registry.JOURNAL) : '');
  if (adir) {
    try {
      for (const f of fs.readdirSync(adir)) {
        if (f.endsWith('.jsonl') && Date.now() - fs.statSync(path.join(adir, f)).mtimeMs < 60000) { journalFresh = true; break; }
      }
    } catch { /* нет каталога */ }
  }
  return { tail, journalFresh, wfStatus: registry.WF_STATUS || null };
}
