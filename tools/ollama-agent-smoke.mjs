#!/usr/bin/env node
// Живая проверка исполнителя Ollama на настоящем демоне (offline-тесты гоняют заглушку).
// Что проверяем: модель видит файлы через инструменты, подхватывает AGENTS.md из cwd,
// не выходит за песочницу, отдаёт справочные строки настроек и данные для всплывашки.
//
//   node tools/ollama-agent-smoke.mjs [модель]
//
// Стенд разворачивается во временном каталоге: тексты нарочно короткие — каждый лишний
// килобайт промпта на 36B MoE стоит секунды префилла.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import ollama from '../server/src/lib/executors/ollama.ts';
import { createToolbox } from '../server/src/lib/executors/_ollamaTools.ts';

const model = process.argv[2] || 'qwen3.6:latest';
const config = { prefsPath: path.join(os.tmpdir(), 'ollama-smoke-no-prefs.json') };

const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'ollama-smoke-'));
await fs.writeFile(path.join(cwd, 'AGENTS.md'), [
  '# Правила стенда',
  '',
  'Отвечай по-русски. В конце каждого ответа ставь строку "ПРАВИЛА-ПРОЧИТАНЫ".',
].join('\n'), 'utf8');
await fs.writeFile(path.join(cwd, 'секрет.txt'), 'кодовое слово: барсук\n', 'utf8');

function line(label, value) {
  console.log(`${label.padEnd(28)} ${value}`);
}

console.log('== настройки исполнителя ==');
for (const s of await ollama.settings(config)) {
  line(`${s.id} (${s.kind})`, s.kind === 'info' ? s.note : String(s.value));
}

console.log('\n== каталог: эффорт по capabilities ==');
const catalog = await ollama.catalog(config);
for (const m of catalog || []) line(m.id, `efforts=${JSON.stringify(m.efforts)} ctx=${m.context}`);

console.log('\n== ход с инструментами (dontAsk, чтение файла + AGENTS.md) ==');
const steps = [];
const started = Date.now();
const out = await ollama.run({
  config,
  chatKey: 'smoke',
  message: 'Прочитай файл секрет.txt в рабочем каталоге и назови кодовое слово.',
  model,
  effort: 'low', // без размышления: смотрим на инструменты, а не на длину рассуждения
  sessionId: null,
  chatHistory: [],
  providerSettings: { numCtx: 16384, keepAliveMin: 5 },
  cwd,
  permissionMode: 'dontAsk',
  onStep: (s) => steps.push(s),
  onProgress: () => {},
});
line('секунд на ход', ((Date.now() - started) / 1000).toFixed(1));
line('контекст (вход+выход)', `${out.contextTokens} из ${out.contextWindow}`);
line('шаги ленты', steps.map((s) => (s.k === 'tool' ? `tool:${s.name}` : s.k)).join(' → '));
line('нашёл кодовое слово', /барсук/i.test(out.reply) ? 'ДА' : `НЕТ — ${out.reply.slice(0, 200)}`);
line('соблюдает AGENTS.md', /ПРАВИЛА-ПРОЧИТАНЫ/.test(out.reply) ? 'ДА' : 'нет');
console.log(`\n--- ответ ---\n${out.reply}\n`);

console.log('== песочница пути (мимо модели, прямой вызов) ==');
const toolbox = await createToolbox({ cwd, roots: [], permissionMode: 'dontAsk' });
line('чтение /etc/passwd', JSON.stringify(await toolbox.call({ name: 'read_file', args: { path: '/etc/passwd' } })));
const plan = await createToolbox({ cwd, roots: [], permissionMode: 'plan' });
line('запись в режиме plan', JSON.stringify(await plan.call({ name: 'write_file', args: { path: 'x.txt', content: '1' } })));

console.log('\n== всплывашка в топбаре ==');
const usage = await ollama.usage(config);
line('state', usage.state);
for (const b of usage.bars) line(`полоса ${b.key}`, `${b.label}: ${b.pct}% — ${b.note || ''}`);
for (const r of usage.resources) {
  line(`ресурс ${r.key}`, `${r.label}: ${r.summary}${r.note ? ` — ${r.note}` : ''}`);
  for (const c of r.controls || []) line('  контрол', `${c.kind} ${c.id} → ${c.action || c.href || ''}`);
}

await fs.rm(cwd, { recursive: true, force: true });
