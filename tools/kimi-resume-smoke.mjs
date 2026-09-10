#!/usr/bin/env node
// Живой smoke: возобновляется ли ACP-сессия Kimi после отмены хода (session/cancel).
//
// Контекст: на 0.31.1 зафиксирован баг — после cancel CLI принимал следующий
// session/prompt, но не создавал новый llm.request и завершал ход пусто. Из-за
// этого кокпит после «стопа» пересоздаёт сессию. Скрипт проверяет, воспроизводится
// ли баг на текущей установленной версии (host-режим, реальный KIMI_CODE_HOME).
//
// ПРЕДУПРЕЖДЕНИЕ: ходит в реальную модель и тратит квоту (3 коротких prompt'а).
// Запуск только с явного разрешения пользователя.
//
// Сценарий:
//   1. control — обычный prompt в новой сессии: модель вообще отвечает?
//   2. cancel  — длинная генерация, отмена на первых chunk'ах, убийство процесса
//               (как делает runtime: session/cancel → 1.5s → SIGTERM);
//   3. resume  — НОВЫЙ процесс, session/resume отменённой сессии, короткий prompt.
//      Ответ с agent_message_chunk → баг исправлен; end_turn без единого chunk —
//      проглатывание воспроизведено.
//
// Запуск: node tools/kimi-resume-smoke.mjs [--report /путь/к/report.json]
// Запускать ОТСОЕДИНЁННО (setsid/nohup): отчёт пишется в файл инкрементально и
// переживает смерть запустившего агента/сервера.

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAcpClient, initializeKimiAcp } from '../server/src/lib/kimi/acpClient.ts';

const reportArgIndex = process.argv.indexOf('--report');
const reportPath = reportArgIndex >= 0 ? (process.argv[reportArgIndex + 1] || '') : '';
const KIMI_BIN = process.env.COCKPIT_KIMI_BIN || path.join(os.homedir(), '.kimi-code', 'bin', 'kimi');
const KIMI_HOME = process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
const CWD = process.cwd();
const SHORT_PROMPT = 'Ответь ровно одним словом: «работаю». Без пояснений.';
const LONG_PROMPT = 'Напиши максимально подробное эссе на 2000 слов об истории вычислительной техники. Не останавливайся, пока не закончишь.';

const log = (msg) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

// Отчёт сбрасываем на диск после каждой фазы: частичный результат читается,
// даже если процесс (или его родитель-агент) умрёт посреди smoke.
function persist(report) {
  if (!reportPath) return;
  try { writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`); } catch { /* best effort */ }
}

function textOf(content) {
  if (!content) return '';
  if (content.type === 'content' && content.content?.type === 'text') return content.content.text || '';
  if (content.type === 'text') return content.text || '';
  return '';
}

function launch() {
  const child = spawn(KIMI_BIN, ['acp'], {
    cwd: CWD,
    env: { ...process.env, KIMI_CODE_HOME: KIMI_HOME, KIMI_DISABLE_CRON: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });
  const state = { chunks: 0, text: '', kinds: {} };
  const client = createAcpClient(child, {
    onNotification(method, params) {
      if (method !== 'session/update') return;
      const kind = params?.update?.sessionUpdate || 'unknown';
      state.kinds[kind] = (state.kinds[kind] || 0) + 1;
      if (kind === 'agent_message_chunk') {
        state.chunks += 1;
        state.text = `${state.text}${textOf(params.update.content)}`.slice(0, 4000);
      }
    },
    // Инструменты smoke не нужны: любой запрос прав отклоняем, как closed-окно кокпита.
    async onReverseRequest() { return { outcome: { outcome: 'cancelled' } }; },
  });
  return {
    child, client, state,
    stderr: () => stderr,
  };
}

async function killChild(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  const gone = await Promise.race([
    once(child, 'exit').then(() => true),
    new Promise((resolve) => { const t = setTimeout(() => resolve(false), 5_000); t.unref(); }),
  ]);
  if (!gone && child.exitCode === null) child.kill('SIGKILL');
}

async function waitForChunks(state, minChunks, timeoutMs) {
  const started = Date.now();
  while (state.chunks < minChunks && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return state.chunks >= minChunks;
}

async function main() {
  const report = { kimiBin: KIMI_BIN, phases: {} };

  // ── Фаза 1: control — sanity, что модель и квота живы ─────────────────────
  log('фаза control: session/new + короткий prompt');
  const control = launch();
  try {
    const info = await initializeKimiAcp(control.client);
    report.agentInfo = info?.agentInfo || null;
    log(`handshake ok: agent ${report.agentInfo?.version || 'unknown'}`);
    const created = await control.client.request('session/new', { cwd: CWD, mcpServers: [] }, 30_000);
    const sessionId = String(created?.sessionId || '');
    log(`control session: ${sessionId}`);
    const result = await control.client.request('session/prompt', {
      sessionId, prompt: [{ type: 'text', text: SHORT_PROMPT }],
    }, 90_000);
    report.phases.control = {
      stopReason: result?.stopReason || null, chunks: control.state.chunks,
      text: control.state.text.slice(0, 200), kinds: control.state.kinds,
    };
    persist(report);
    log(`control: stopReason=${result?.stopReason}, chunks=${control.state.chunks}, text="${control.state.text.trim().slice(0, 60)}"`);
    if (!control.state.chunks) {
      report.verdict = 'INCONCLUSIVE';
      report.reason = 'control prompt не вернул ни одного chunk — проблема с моделью/квотой, а не с resume';
      return report;
    }
  } finally {
    control.client.close();
    await killChild(control.child);
  }

  // ── Фаза 2: cancel — длинная генерация, отмена на ходу, убийство процесса ──
  log('фаза cancel: длинная генерация, отмена на первых chunk');
  const cancelled = launch();
  let cancelledSessionId = '';
  try {
    await initializeKimiAcp(cancelled.client);
    const created = await cancelled.client.request('session/new', { cwd: CWD, mcpServers: [] }, 30_000);
    cancelledSessionId = String(created?.sessionId || '');
    log(`cancel session: ${cancelledSessionId}`);
    const promptPromise = cancelled.client.request('session/prompt', {
      sessionId: cancelledSessionId, prompt: [{ type: 'text', text: LONG_PROMPT }],
    }, 300_000).then((r) => ({ settled: true, result: r }), (error) => ({ settled: true, error: error?.message }));
    const gotChunks = await waitForChunks(cancelled.state, 3, 60_000);
    log(`cancel: накоплено chunks=${cancelled.state.chunks} (ждали ≥3: ${gotChunks})`);
    cancelled.client.notify('session/cancel', { sessionId: cancelledSessionId });
    const outcome = await Promise.race([
      promptPromise,
      new Promise((resolve) => { const t = setTimeout(() => resolve({ settled: false }), 30_000); t.unref(); }),
    ]);
    report.phases.cancel = {
      chunksBeforeCancel: cancelled.state.chunks,
      settledAfterCancel: outcome.settled,
      stopReason: outcome.result?.stopReason || null,
      error: outcome.error || null,
    };
    persist(report);
    log(`cancel: settled=${outcome.settled}, stopReason=${outcome.result?.stopReason || '—'}`);
    // Повторяем runtime: после cancel процессу дают 1.5s и шлют SIGTERM.
    cancelled.client.close();
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  } finally {
    await killChild(cancelled.child);
  }
  if (!cancelledSessionId || !report.phases.cancel?.chunksBeforeCancel) {
    report.verdict = 'INCONCLUSIVE';
    report.reason = 'не удалось получить отменяемый ход с chunk-ами';
    return report;
  }

  // ── Фаза 3: resume — новый процесс, возобновление отменённой сессии ────────
  log('фаза resume: новый процесс, session/resume отменённой сессии');
  const resumed = launch();
  try {
    await initializeKimiAcp(resumed.client);
    try {
      await resumed.client.request('session/resume', {
        sessionId: cancelledSessionId, cwd: CWD, mcpServers: [],
      }, 30_000);
      log('resume: session/resume принят');
    } catch (error) {
      report.phases.resume = { resumeError: error?.message || String(error) };
      report.verdict = 'RESUME_REJECTED';
      report.reason = 'session/resume отменённой сессии отклонён CLI';
      return report;
    }
    const result = await resumed.client.request('session/prompt', {
      sessionId: cancelledSessionId, prompt: [{ type: 'text', text: SHORT_PROMPT }],
    }, 120_000);
    report.phases.resume = {
      stopReason: result?.stopReason || null, chunks: resumed.state.chunks,
      text: resumed.state.text.slice(0, 200), kinds: resumed.state.kinds,
    };
    persist(report);
    log(`resume: stopReason=${result?.stopReason}, chunks=${resumed.state.chunks}, text="${resumed.state.text.trim().slice(0, 60)}"`);
    if (resumed.state.chunks > 0 && resumed.state.text.trim()) {
      report.verdict = 'RESUME_OK';
      report.reason = 'после cancel+resume модель отвечает: баг 0.31.1 НЕ воспроизводится';
    } else {
      report.verdict = 'SWALLOW_REPRODUCED';
      report.reason = 'prompt после resume завершился без единого chunk: проглатывание воспроизведено';
    }
  } finally {
    resumed.client.close();
    await killChild(resumed.child);
  }
  return report;
}

main().then((report) => {
  persist(report);
  console.log('\n===== SMOKE REPORT =====');
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.verdict === 'RESUME_OK' ? 0 : 1);
}, (error) => {
  persist({ verdict: 'SMOKE_CRASHED', reason: error?.message || String(error) });
  console.error('smoke упал:', error);
  process.exit(2);
});
