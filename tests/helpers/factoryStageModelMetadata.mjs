import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { settingsFixture, sourceRoot } from './stageRunnerSettingsFixture.mjs';

/**
 * Настоящий Codex adapter получает каталог раннера и отдельные native model/list metadata.
 * CLI fixture обслуживает только discovery; попытка thread/turn завершается отказом.
 */
export async function codexModelFixture(t) {
  const fx = await settingsFixture(t);
  const binDir = path.join(fx.root, 'bin');
  const binary = path.join(binDir, 'codex');
  const cache = path.join(fx.root, 'codex-models.json');
  const trace = path.join(fx.root, 'native-methods.jsonl');
  const metadataFile = path.join(fx.root, 'native-models.json');
  const native = [
    {
      id: 'gpt-9.1-sol',
      model: 'gpt-9.1-sol',
      displayName: 'Sol',
      supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }]
    },
    {
      id: 'gpt-9.1-terra',
      model: 'gpt-9.1-terra',
      displayName: 'Terra',
      supportedReasoningEfforts: [{ reasoningEffort: 'high' }, { reasoningEffort: 'ultra' }]
    },
    {
      id: 'gpt-9.1-chat',
      model: 'gpt-9.1-chat',
      displayName: 'Chat only',
      supportedReasoningEfforts: [{ reasoningEffort: 'max' }]
    },
  ];

  await mkdir(binDir);
  await mkdir(fx.env.GRIGDESK_HOME, { recursive: true });
  await writeFile(path.join(fx.env.GRIGDESK_HOME, 'models.json'), 'sentinel-owner-registry');
  await copyFile(path.join(sourceRoot, 'engine/lib/runners/codex.sh'),
    path.join(fx.env.FACTORY_RUNNERS_DIR, 'codex.sh'));
  await writeFile(cache, JSON.stringify({ models: native.slice(0, 2).map((model, priority) => ({
    slug: model.id,
    visibility: 'list',
    priority,
  })) }));
  await writeFile(metadataFile, JSON.stringify({ data: native, nextCursor: null }));
  await writeFile(binary, [
    `#!${process.execPath}`,
    'const fs = require("node:fs");',
    'const readline = require("node:readline");',
    'if (process.argv.includes("--version")) { console.log("codex-cli 0.166.0"); process.exit(0); }',
    'if (!process.argv.includes("app-server")) throw new Error("metadata only");',
    'readline.createInterface({ input: process.stdin }).on("line", (line) => {',
    '  const message = JSON.parse(line);',
    `  fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify(message)+"\\n");`,
    '  if (message.id === undefined) return;',
    '  let result;',
    '  if (message.method === "initialize") result = { userAgent: "fixture/1" };',
    '  else if (message.method === "model/list") {',
    `    result = JSON.parse(fs.readFileSync(${JSON.stringify(metadataFile)}));`,
    '  }',
    '  else throw new Error("model call forbidden: " + message.method);',
    '  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result })+"\\n");',
    '});',
  ].join('\n'), { mode: 0o700 });
  await writeFile(fx.config, [
    'RUNNERS_SCHEMA=1', 'CONFIG_REVISION=1', 'PROJECT_RUNNER_PRIMARY=codex', 'PROJECT_RUNNER_FAILOVER=',
    'MODEL_DEFAULT_CODEX_EXACT=gpt-9.1-sol', 'MODEL_DEFAULT_CODEX_EFFORT=high', '',
  ].join('\n'));
  Object.assign(fx.env, {
    PATH: `${binDir}:${fx.env.PATH}`,
    FACTORY_CODEX_MODEL_CACHE: cache,
    FACTORY_FORBID_LIVE: '0',
    GRIGDESK_CODEX_BIN: binary,
    CODEX_HOME: path.join(fx.root, 'codex-home'),
  });

  return {
    ...fx,
    native,
    binary,
    cache,
    trace,
    metadataFile,
    async methods() {
      const content = await readFile(trace, 'utf8').catch(() => '');

      return content.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line).method);
    },
  };
}
