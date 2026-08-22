#!/usr/bin/env node

// Отдельный процесс для предварительной проверки поиска по базе знаний при запуске и установке.
// DatabaseSync синхронен, поэтому этот код принципиально не импортируется в цикл событий Fastify.
import { runKnowledgeSearchRuntimePreflight } from '../src/lib/search/runtime-preflight.js';
import { KNOWLEDGE_SEARCH_PREFLIGHT_PROTOCOL } from '../src/lib/search/runtime-preflight-client.js';

const report = await runKnowledgeSearchRuntimePreflight();
const args = process.argv.slice(2);
const jsonMode = args.length === 1 && args[0] === '--json';

if (jsonMode) {
  process.stdout.write(`${JSON.stringify({
    protocol: KNOWLEDGE_SEARCH_PREFLIGHT_PROTOCOL.name,
    protocolVersion: KNOWLEDGE_SEARCH_PREFLIGHT_PROTOCOL.version,
    report,
  })}\n`);
} else {
  if (args.length !== 0) {
    process.stderr.write('Usage: knowledge-search-preflight.mjs [--json]\n');
    process.exitCode = 64;
  } else {
    const sqlite = report.checks.find((check) => check.id === 'sqlite_runtime');
    if (report.ok) {
      process.stdout.write(
        `→ Knowledge search runtime: ready (Node ${process.versions.node}, SQLite ${sqlite?.actualVersion || 'unknown'})\n`,
      );
    } else {
      process.stderr.write(
        `⚠ Knowledge search runtime: degraded (${report.reasonCode || 'search_runtime_incomplete'}); Cockpit continues\n`,
      );
    }
  }
}
if (args.length <= 1 && !report.ok) process.exitCode = 2;
